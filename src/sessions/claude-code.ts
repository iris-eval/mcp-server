/*
 * The session reader: Claude Code's own session logs, read as turns.
 *
 * Claude Code writes every session to a JSON Lines file under
 * ~/.claude/projects/<project>/<session id>.jsonl: each prompt, each model
 * response (one entry per content block), each tool call and its result,
 * plus the host's own bookkeeping. Those files already hold a user's real
 * agent history, so they are the evidence an evaluator most needs and the
 * one nobody had to set up. readClaudeCodeSession reads one file into turns,
 * read only; captureOfTurn and traceBodyOfTurn make a turn an Iris trace.
 *
 * A TURN is one prompt and everything the agent did until the next prompt.
 * A prompt is a user entry that is not a tool result, not the host's own
 * text (a skill's expansion, a compaction summary, a shell command run with
 * `!`, a local command's output), and not a sub-agent's (`isSidechain`).
 * Newer logs mark who sent it (`origin.kind`): a person, a task
 * notification, another session, an automatic continuation. A version that
 * marks a person's prompts marks every one, so a prompt it left unmarked was
 * not typed by a person (`other`). A version that marks none is read the
 * older way: a prompt is a person's unless its text is one of the host's own
 * tags. A prompt Claude Code queued while a turn ran (an `attachment` entry,
 * `queued_command`) is read by the agent mid-turn: it is named on that turn.
 *
 * The log is the host's record, written as the agent ran, so its tool calls
 * are whole: every call the main agent made is in it, with its result. That
 * is declared on the trace (src/eval/evidence.ts) for a turn the log holds
 * in full: it ended with the model's end of turn, nothing was interrupted,
 * every call has its result, and every line was read. A sub-agent's own
 * calls are in its own transcript; the main turn records the call that
 * started it and what it returned.
 *
 * Measured on this format before writing it, and by an independent review
 * against 13 real logs (Claude Code 2.1.236 to 2.1.280): a response split
 * across entries repeats its token usage and its stop reason on each, so
 * usage is counted once per message id; the host's own messages carry the
 * model `<synthetic>`; Claude Code cuts a large tool result itself and says
 * so in `toolUseResult`; every cache write had a one-hour lifetime; a line
 * can be cut short by a crash.
 */
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { CaptureField, ToolCallRecord, TokenUsage, TraceCapture } from '../types/trace.js';

/** Who sent the prompt that began a turn. */
export type TurnOrigin = 'human' | 'command' | 'task_notification' | 'peer' | 'auto_continuation' | 'other';

/**
 * How a turn ended. `answered`: the model ended its turn with text.
 * `cut_off`: its last response stopped at the output limit. `local`: a slash
 * command the host ran itself, which never reached the model. `api_error`:
 * the turn ended on an error from the API. `interrupted`: a person stopped
 * it, or a call never got its result. `unanswered`: anything else, a turn
 * the log ends in the middle of included.
 */
export type TurnEnd = 'answered' | 'cut_off' | 'local' | 'api_error' | 'interrupted' | 'unanswered';

export interface SessionTurn {
  /** The session id: the log file's name. */
  session: string;
  /** The turn's place in the session, from 1. */
  index: number;
  /** Claude Code's id for the prompt, when the log carries one. */
  promptId?: string;
  origin: TurnOrigin;
  /** What the agent was asked: the prompt's text. */
  input: string;
  /** The input is not the whole prompt: an image or a document was left out, or the text was cut to its head and tail. */
  inputPartial: boolean;
  /** The last text the agent wrote in the turn; empty when it wrote none. */
  output: string;
  /** The output was cut to its head and tail. */
  outputCut: boolean;
  toolCalls: ToolCallRecord[];
  ended: TurnEnd;
  /** The log holds the turn in full: it ended answered, nothing was interrupted, every call has its result, and every line was read. */
  whole: boolean;
  /** A line in the turn could not be read (a crash cut it short); whatever it held is not in the turn. */
  lost: boolean;
  /**
   * Prompts that arrived while the turn ran: who sent each, and when. A
   * person's among them means the turn answered more than one ask, so its
   * answer cannot be judged against `input` alone.
   */
  queued: Array<{ origin: TurnOrigin; at: string }>;
  /** The model that answered, when one model did. */
  model?: string;
  /** Summed over the turn's model responses, each counted once. */
  tokenUsage?: TokenUsage;
  startedAt: string;
  endedAt: string;
}

export interface ReadOptions {
  /** A tool output, an error, a prompt or an answer longer than this is kept as its head and its tail. */
  maxFieldChars?: number;
  /** Filled in as the log is read: lines that could not be read, including any before the first prompt. */
  stats?: { lostLines: number };
}

/** How the reader names itself on the traces it makes (the trace's `capture.name`). */
export const SESSION_READER = 'claude-code-session-log';
export const FIELD_MAX_CHARS = 262_144;
/** The longest session id the ingest doors accept. */
const SESSION_ID_MAX = 200;

/** The host's own tags: text that opens with one is the host speaking, not a prompt. */
const HOST_TAGS = /^<(local-command-caveat|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|system-reminder|user-memory-input)\b/;
const LOCAL_OUTPUT = /^<local-command-(?:stdout|stderr)\b/;
// A slash command: the host writes its name and arguments in tags, with its message tag first in some versions.
const COMMAND = /^(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>([^<]*)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
const TASK_NOTIFICATION = /^<task-notification\b/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]/;

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
interface Entry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  promptId?: string;
  origin?: { kind?: string };
  timestamp?: string;
  version?: string;
  message?: { id?: string; model?: string; content?: unknown; usage?: Record<string, unknown>; stop_reason?: string | null };
  /** On a tool result: Claude Code's own structured record of it. */
  toolUseResult?: { persistedOutputPath?: unknown; truncated?: unknown; file?: { truncatedByTokenCap?: unknown } };
  /** On an attachment entry: a prompt Claude Code queued while a turn ran. */
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string } };
}

const ORIGIN_OF: Record<string, TurnOrigin> = { human: 'human', 'task-notification': 'task_notification', peer: 'peer', 'auto-continuation': 'auto_continuation' };
/** An origin kind as a turn origin; a kind the table does not name (or one named like a property every object has) is `other`. */
const originOf = (kind: string): TurnOrigin => (Object.hasOwn(ORIGIN_OF, kind) ? ORIGIN_OF[kind] : 'other');
/**
 * Who sent a prompt Claude Code queued mid-turn: its origin when marked;
 * else what it queued, which every queued entry says (`commandMode`). A
 * queued `prompt` with no mark is read as a person's, so the turn is never
 * judged against one ask while it answered two.
 */
function queuedOrigin(a: NonNullable<Entry['attachment']>): TurnOrigin {
  if (typeof a.origin?.kind === 'string') return originOf(a.origin.kind);
  if (a.commandMode === 'task-notification') return 'task_notification';
  if (a.commandMode === 'prompt') return 'human';
  return 'other';
}

function capped(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2);
  return { text: `${text.slice(0, half)}\n… [${text.length - max} characters left out by the session reader] …\n${text.slice(-half)}`, truncated: true };
}

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]).filter((b) => b !== null && typeof b === 'object') : []);

/** A prompt's text, and whether it held something besides text (an image, a document) that the text leaves out. */
function promptText(content: unknown): { text: string; other: boolean } {
  if (typeof content === 'string') return { text: content, other: false };
  const blocks = blocksOf(content);
  return {
    text: blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n'),
    other: blocks.some((b) => b.type !== 'text'),
  };
}

/** What a tool returned, as the agent received it, and whether anything in it was not text (an image, a document, a tool reference) and so is named rather than kept. */
function resultText(content: unknown): { text: string; partial: boolean } {
  if (typeof content === 'string') return { text: content, partial: false };
  const blocks = blocksOf(content);
  return {
    text: blocks
      .map((b) => (b.type === 'text' ? String(b.text ?? '') : b.type ? `[${b.type}]` : ''))
      .filter((t) => t !== '')
      .join('\n'),
    partial: blocks.some((b) => b.type !== 'text'),
  };
}

/** Whether Claude Code cut this result itself: saved the whole to a file and kept a preview, or stopped a read at its token cap. */
function cutByHost(e: Entry): boolean {
  const r = e.toolUseResult;
  if (!r || typeof r !== 'object') return false;
  return (typeof r.persistedOutputPath === 'string' && r.persistedOutputPath !== '') || r.truncated === true || r.file?.truncatedByTokenCap === true;
}

/**
 * Who sent a prompt, or null when the entry is not one. `stamping` holds the
 * versions that mark `origin` somewhere in this log: an unmarked prompt from
 * one of them was not typed by a person (the host marks every one it takes
 * from a person), so it is `other`. Only a version that never marks is read
 * the older way, by its leading tags.
 */
function promptOrigin(e: Entry, text: string, nonText: boolean, stamping: ReadonlySet<string>): TurnOrigin | null {
  if (e.isSidechain || e.isCompactSummary) return null;
  const kind = e.origin?.kind;
  if (kind === 'human') return COMMAND.test(text.trimStart()) ? 'command' : 'human';
  if (typeof kind === 'string') return originOf(kind);
  // No origin. The host's expansions and notices are meta or carry its tags; an image alone is still a prompt.
  if (e.isMeta) return null;
  const head = text.trimStart();
  if ((head === '' && !nonText) || HOST_TAGS.test(head) || INTERRUPTED.test(head)) return null;
  // A slash command's entry is written by the host, marked or not: it is a command whoever's version wrote it.
  if (COMMAND.test(head)) return 'command';
  if (typeof e.version === 'string' && stamping.has(e.version)) return 'other';
  if (TASK_NOTIFICATION.test(head)) return 'task_notification';
  return 'human';
}

/** The Claude Code versions that mark a person's prompt (`origin.kind` human) somewhere in this log. A line without the key is not parsed. */
async function stampingVersionsOf(path: string): Promise<Set<string>> {
  const versions = new Set<string>();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"origin"')) continue;
    try {
      const e = JSON.parse(line) as Entry | null;
      if (e && e.type === 'user' && e.origin?.kind === 'human' && typeof e.version === 'string') versions.add(e.version);
    } catch {
      /* a line cut short; the main pass counts it */
    }
  }
  return versions;
}

/** A slash command as the person typed it: `/review the parser`. */
function commandText(text: string): string {
  const m = COMMAND.exec(text.trimStart());
  return m ? [m[1].trim(), (m[2] ?? '').trim()].filter(Boolean).join(' ') : text;
}

interface Building {
  turn: SessionTurn;
  /** Calls by tool_use id, waiting for their result. */
  pending: Map<string, ToolCallRecord>;
  /** A call with no id: its result cannot be matched to it. */
  unmatched: boolean;
  /** Message ids already counted toward the usage. */
  counted: Set<string>;
  models: Set<string>;
  interrupted: boolean;
  /** The last thing the agent did was a call, after its last text. */
  lastWasCall: boolean;
  /** The stop reason of the last model response the turn holds, null when it carries none. */
  lastStop: string | null;
  /** The message id of that response. */
  lastMessage: string | null;
  /** The last thing in the turn was an API error (a later model response clears it). */
  apiError: boolean;
  /** The host ran a local command and wrote its output. */
  local: boolean;
  lost: boolean;
}

function finish(b: Building, max: number, logEnded: boolean): SessionTurn {
  const t = b.turn;
  const unanswered = b.pending.size > 0 || b.unmatched;
  const out = capped(t.output, max);
  t.output = out.text;
  t.outputCut = out.truncated;
  const modelEnded = b.lastStop === 'end_turn' || b.lastStop === 'stop_sequence' || b.lastStop === 'refusal';
  t.ended = b.apiError
    ? 'api_error'
    : b.interrupted || (b.pending.size > 0 && !logEnded)
      ? 'interrupted'
      : t.origin === 'command' && b.local && b.models.size === 0
        ? 'local'
        : b.lastStop === 'max_tokens'
          ? 'cut_off'
          : t.output !== '' && !b.lastWasCall && (modelEnded || b.lastStop === null)
            ? 'answered'
            : 'unanswered';
  t.lost = b.lost;
  t.whole = t.ended === 'answered' && !unanswered && !b.lost;
  if (b.models.size === 1) t.model = [...b.models][0];
  return t;
}

function addUsage(t: SessionTurn, usage: Record<string, unknown> | undefined): void {
  if (!usage || typeof usage !== 'object') return;
  const n = (k: string): number => (typeof usage[k] === 'number' && Number.isFinite(usage[k]) ? (usage[k] as number) : 0);
  const read = n('cache_read_input_tokens');
  const write = n('cache_creation_input_tokens');
  // How many of the writes had a one-hour lifetime, priced above a five-minute write (src/cost/trace-cost.ts).
  const created = usage.cache_creation as Record<string, unknown> | undefined;
  const hour = created && typeof created === 'object' && typeof created.ephemeral_1h_input_tokens === 'number' && Number.isFinite(created.ephemeral_1h_input_tokens) ? (created.ephemeral_1h_input_tokens as number) : undefined;
  const prompt = n('input_tokens') + read + write;
  const completion = n('output_tokens');
  const u = (t.tokenUsage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  u.prompt_tokens = (u.prompt_tokens ?? 0) + prompt;
  u.completion_tokens = (u.completion_tokens ?? 0) + completion;
  u.total_tokens = (u.total_tokens ?? 0) + prompt + completion;
  if (read > 0) u.cache_read_tokens = (u.cache_read_tokens ?? 0) + read;
  if (write > 0) u.cache_creation_tokens = (u.cache_creation_tokens ?? 0) + write;
  if (write > 0 && hour !== undefined) u.cache_creation_1h_tokens = (u.cache_creation_1h_tokens ?? 0) + hour;
}

/**
 * The turns of one session log, in order. Read only, one line at a time
 * (twice: once for the versions that mark who sent a prompt), so a log of
 * any size is read in the memory of its largest turn. A turn the log ends in
 * the middle of (the session is still running) is yielded with what it has,
 * and is not `answered` unless the model had ended its turn.
 */
export async function* readClaudeCodeSession(path: string, options: ReadOptions = {}): AsyncGenerator<SessionTurn> {
  const max = options.maxFieldChars ?? FIELD_MAX_CHARS;
  const session = basename(path).replace(/\.jsonl$/, '');
  const stamping = await stampingVersionsOf(path);
  let current: Building | null = null;
  let index = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      e = null as unknown as Entry;
    }
    // A line cut short by a crash, or one that is not an entry: it may have held a call, so the turn it falls in is not held in full.
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      if (options.stats) options.stats.lostLines += 1;
      if (current) current.lost = true;
      continue;
    }
    const at = typeof e.timestamp === 'string' ? e.timestamp : '';
    if (e.isSidechain) continue;
    // A prompt Claude Code queued while the turn ran: the agent reads it mid-turn, so it belongs to this turn, and is named on it.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      if (current) current.turn.queued.push({ origin: queuedOrigin(e.attachment), at });
      continue;
    }
    // The host ran a local command (/model, /clear): its output is a system entry in newer logs.
    if (e.type === 'system' && e.subtype === 'local_command' && current) {
      current.local = true;
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message || typeof e.message !== 'object') continue;

    if (e.type === 'user') {
      const blocks = blocksOf(e.message.content);
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        for (const r of results) {
          const call = current?.pending.get(String(r.tool_use_id));
          if (!call || !current) continue;
          current.pending.delete(String(r.tool_use_id));
          const got = resultText(r.content);
          const body = capped(got.text, max);
          if (r.is_error === true) call.error = body.text || 'the tool reported an error';
          else call.output = body.text;
          // Cut by this reader, by Claude Code before it was written, or holding something that is named rather than kept.
          if (body.truncated || got.partial || cutByHost(e)) call.truncated = true;
          current.turn.endedAt = at || current.turn.endedAt;
        }
        continue;
      }
      const { text, other } = promptText(e.message.content);
      if (current && INTERRUPTED.test(text.trimStart())) {
        current.interrupted = true;
        continue;
      }
      if (current && LOCAL_OUTPUT.test(text.trimStart())) current.local = true;
      const origin = promptOrigin(e, text, other, stamping);
      if (origin === null) continue;
      if (current) yield finish(current, max, false);
      index += 1;
      const prompt = capped(origin === 'command' ? commandText(text) : text.trim(), max);
      current = {
        turn: {
          session,
          index,
          ...(e.promptId ? { promptId: e.promptId } : {}),
          origin,
          input: prompt.text,
          // A command's model input is the skill text the host expands it into, which the reader skips: `/name args` is not all the model was asked.
          inputPartial: prompt.truncated || other || origin === 'command',
          output: '',
          outputCut: false,
          toolCalls: [],
          ended: 'unanswered',
          whole: false,
          lost: false,
          queued: [],
          startedAt: at,
          endedAt: at,
        },
        pending: new Map(),
        unmatched: false,
        counted: new Set(),
        models: new Set(),
        interrupted: false,
        lastWasCall: false,
        lastStop: null,
        lastMessage: null,
        apiError: false,
        local: false,
        lost: false,
      };
      continue;
    }

    // An assistant entry: one content block of a model response, or the host's own message.
    if (!current) continue;
    const m = e.message;
    current.turn.endedAt = at || current.turn.endedAt;
    if (e.isApiErrorMessage) {
      current.apiError = true;
      continue;
    }
    if (m.model === '<synthetic>') continue;
    // A model response after an error: the turn went on, so the error is not how it ended.
    current.apiError = false;
    // The latest response's own stop reason: a response that carries none does not inherit an earlier one's.
    if (m.id !== current.lastMessage) {
      current.lastMessage = m.id ?? null;
      current.lastStop = typeof m.stop_reason === 'string' ? m.stop_reason : null;
    } else if (typeof m.stop_reason === 'string') current.lastStop = m.stop_reason;
    if (m.model) {
      current.models.add(m.model);
      if (m.id && !current.counted.has(m.id)) {
        current.counted.add(m.id);
        addUsage(current.turn, m.usage);
      }
    }
    for (const b of blocksOf(m.content)) {
      if (b.type === 'tool_use') {
        const call: ToolCallRecord = { tool_name: String(b.name ?? ''), input: b.input, ...(b.id ? { call_id: String(b.id) } : {}) };
        current.turn.toolCalls.push(call);
        if (b.id) current.pending.set(String(b.id), call);
        else current.unmatched = true;
        current.lastWasCall = true;
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
        current.turn.output = b.text.trim();
        current.lastWasCall = false;
      }
    }
  }
  if (current) yield finish(current, max, true);
}

/** What a turn's record holds in full, declared on its trace (src/eval/evidence.ts). */
export function captureOfTurn(turn: SessionTurn, version?: string): TraceCapture {
  const complete: CaptureField[] = [
    // The whole prompt, and the only ask: a person's prompt queued mid-turn is a second one the input does not hold.
    ...(turn.input.trim() !== '' && !turn.inputPartial && !turn.queued.some((q) => q.origin === 'human') ? (['input'] as const) : []),
    ...(turn.whole ? (['tool_calls'] as const) : []),
    // A result cut, or named rather than kept, is not one recorded in full, and a line that could not be read may have held one.
    ...(!turn.lost && turn.toolCalls.every((c) => (c.output !== undefined || c.error !== undefined) && c.truncated !== true) ? (['tool_outputs'] as const) : []),
  ];
  return { name: SESSION_READER, ...(version ? { version } : {}), ...(complete.length > 0 ? { complete } : {}) };
}

/** A turn as the body `POST /api/v1/traces` and `iris-eval ingest` take. */
export interface TurnTraceBody {
  agent_name: string;
  framework: string;
  input: string;
  output: string;
  tool_calls?: ToolCallRecord[];
  token_usage?: TokenUsage;
  run: string;
  session_id: string;
  timestamp: string;
  capture: TraceCapture;
  metadata: Record<string, unknown>;
}

/**
 * A turn as a trace. An empty list of calls is sent only for a turn the log
 * holds in full, where it says no tool was called; otherwise a turn with no
 * recorded call sends no list, which says nothing either way. A turn with
 * many calls can be larger than the HTTP door's default body limit
 * (`security.requestSizeLimit`, 1 MB); `iris-eval ingest --file` has none.
 */
export function traceBodyOfTurn(turn: SessionTurn, version?: string): TurnTraceBody {
  const session = turn.session.slice(0, SESSION_ID_MAX);
  return {
    agent_name: 'claude-code',
    framework: 'claude-code',
    input: turn.input,
    output: turn.output,
    ...(turn.toolCalls.length > 0 || turn.whole ? { tool_calls: turn.toolCalls } : {}),
    ...(turn.tokenUsage ? { token_usage: turn.tokenUsage } : {}),
    run: session,
    session_id: session,
    timestamp: turn.startedAt || new Date(0).toISOString(),
    capture: captureOfTurn(turn, version),
    metadata: {
      ...(turn.model ? { model: turn.model } : {}),
      turn: {
        index: turn.index,
        origin: turn.origin,
        ended: turn.ended,
        ...(turn.promptId ? { prompt_id: turn.promptId } : {}),
        ...(turn.queued.length > 0 ? { queued: turn.queued } : {}),
        ...(turn.inputPartial ? { input_partial: true } : {}),
        ...(turn.outputCut ? { output_cut: true } : {}),
        started_at: turn.startedAt,
        ended_at: turn.endedAt,
      },
    },
  };
}
