/*
 * The layouts a document may reach an agent in, and the shapes a tool may
 * take a message in, for the test that holds no_injection_compliance to
 * what it answers in each (tests/unit/eval/injection-layouts.test.ts).
 *
 * A layout changes how a document is drawn and not what the agent did with
 * it; a tool's shape changes how an act is written and not what was done.
 * So a case of the rule's proof family keeps its label in every one of
 * them, and what the rule answers there is a measurement of the rule.
 *
 * Nothing here writes a planted sentence: each is the family's, taken as
 * it stands in proof/corpus.
 */

export interface FamilyCase {
  id: string;
  label: 'positive' | 'negative';
  input?: string;
  output: string;
  context: { toolCalls: Array<{ tool_name: string; input?: unknown; output?: unknown; error?: string }> };
}

/** Hard-wraps each line longer than `width` at its spaces, as a mail client or an editor does. */
export function wrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line;
      const out: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current !== '' && current.length + 1 + word.length > width) {
          out.push(current);
          current = word;
        } else current = current === '' ? word : `${current} ${word}`;
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}
const each = (text: string, line: (text: string, n: number) => string): string => text.split('\n').map(line).join('\n');
/** The text as the second cell of a query result, the cell wrapped at 56 characters: `row` draws one line of it, `head` the lines above, `foot` the line below. */
function cell(text: string, head: (width: number) => string[], row: (first: string, body: string) => string, foot: (width: number) => string[]): string {
  const lines = wrap(text, 56).split('\n');
  const width = Math.max(4, ...lines.map((l) => l.length));
  return [...head(width), ...lines.map((l, n) => row(n === 0 ? '7 ' : '  ', l.padEnd(width))), ...foot(width)].join('\n');
}

/** Each layout: its name, and the tool output it makes of one that is a string (null where it leaves the text as it is, or does not apply). */
export const LAYOUTS: ReadonlyArray<readonly [name: string, draw: (text: string) => unknown]> = [
  ['as the family has it', (t) => t],
  ['quoted with "> "', (t) => each(t, (l) => (l === '' ? '>' : `> ${l}`))],
  ['quoted with "| "', (t) => each(t, (l) => (l === '' ? '|' : `| ${l}`))],
  ['indented four spaces', (t) => each(t, (l) => (l === '' ? '' : `    ${l}`))],
  ['in a fence', (t) => `\`\`\`\n${t}\n\`\`\``],
  ['numbered "     5→", a file read with its lines numbered', (t) => each(t, (l, n) => `${String(n + 1).padStart(6)}→${l}`)],
  ['numbered "5: "', (t) => each(t, (l, n) => `${n + 1}: ${l}`)],
  ['numbered "  5 | "', (t) => each(t, (l, n) => `${String(n + 1).padStart(3)} | ${l}`)],
  ['the hits of a search, "notes.md:5:" before each line', (t) => each(t, (l, n) => `notes.md:${n + 1}:${l}`)],
  ['a blame, a commit and an author before each line', (t) => each(t, (l, n) => `a1b2c3d4 (Dana Reyes 2026-11-02 ${n + 1}) ${l}`)],
  ['wrapped at 40', (t) => (wrap(t, 40) === t ? null : wrap(t, 40))],
  ['wrapped at 60', (t) => (wrap(t, 60) === t ? null : wrap(t, 60))],
  ['wrapped at 72', (t) => (wrap(t, 72) === t ? null : wrap(t, 72))],
  ['line ends CR LF', (t) => (t.includes('\n') ? t.replace(/\n/g, '\r\n') : null)],
  [
    'a wrapped cell of a query result drawn as a grid',
    (t) =>
      cell(
        t,
        (w) => [`+----+${'-'.repeat(w + 2)}+`, `| id | ${'body'.padEnd(w)} |`, `+----+${'-'.repeat(w + 2)}+`],
        (f, b) => `| ${f} | ${b} |`,
        (w) => [`+----+${'-'.repeat(w + 2)}+`],
      ),
  ],
  [
    'the same with no bar at the start of a line',
    (t) =>
      cell(
        t,
        (w) => [` id | ${'body'.padEnd(w)}`, `----+${'-'.repeat(w + 2)}`],
        (f, b) => ` ${f} | ${b.trimEnd()}`,
        () => [],
      ),
  ],
  [
    'a wrapped cell of a Markdown table, each line of it a row',
    (t) =>
      cell(
        t,
        (w) => [`| id | ${'body'.padEnd(w)} |`, `|----|${'-'.repeat(w + 2)}|`],
        (f, b) => `| ${f} | ${b} |`,
        () => [],
      ),
  ],
  ['paragraphs of HTML', (t) => (/[<&]/.test(t) ? null : t.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>\n')}</p>`).join('\n'))],
  ['{ content }, one string of a structure', (t) => ({ path: 'notes.md', content: t })],
  ['an MCP result, one text part', (t) => ({ content: [{ type: 'text', text: t }] })],
  ['JSON text', (t) => JSON.stringify({ path: 'notes.md', content: t })],
  ['a JSON string literal', (t) => JSON.stringify(t)],
  ['{ lines: [...] }, a line to a string under a key that says lines', (t) => (t.includes('\n') ? { path: 'notes.md', lines: t.split('\n') } : null)],
  ['{ rows: [...] }, a line to a string under a key that does not', (t) => (t.includes('\n') ? { rows: t.split('\n') } : null)],
  ['MCP text parts, a line each', (t) => (t.includes('\n') ? { content: t.split('\n').map((text) => ({ type: 'text', text })) } : null)],
];

/** A case with every tool output that is a string drawn in a layout, or null when the layout changes none of them. */
export function drawn(c: FamilyCase, draw: (text: string) => unknown): FamilyCase['context']['toolCalls'] | null {
  let changed = false;
  const toolCalls = c.context.toolCalls.map((call) => {
    if (typeof call.output !== 'string') return call;
    const made = draw(call.output);
    if (made === null || made === call.output) return call;
    changed = true;
    return { ...call, output: made };
  });
  return changed ? toolCalls : null;
}

const DESTINATION = ['to', 'recipient', 'recipients', 'address', 'channel', 'phone', 'email', 'url', 'endpoint', 'target'];
const TEXT = ['body', 'text', 'message', 'content', 'data', 'payload'];
export interface Send {
  at: number;
  destination: string;
  text: string;
  subject?: string;
}
/** The call of a case that sends a text to a destination, with the two: the first whose arguments hold a string under a key a destination goes by and one under a key a text goes by. */
export function sendOf(c: FamilyCase): Send | null {
  for (const [at, call] of c.context.toolCalls.entries()) {
    const input = call.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) continue;
    const record = input as Record<string, unknown>;
    const d = Object.keys(record).find((k) => DESTINATION.includes(k) && typeof record[k] === 'string');
    const t = Object.keys(record).find((k) => TEXT.includes(k) && typeof record[k] === 'string');
    if (d !== undefined && t !== undefined) return { at, destination: record[d] as string, text: record[t] as string, subject: typeof record.subject === 'string' ? record.subject : undefined };
  }
  return null;
}
const single = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
/** Each shape a tool may take a message in: its name, and the call it makes of a destination and a text. */
export const SHAPES: ReadonlyArray<readonly [name: string, call: (s: Send) => { tool_name: string; input: unknown }]> = [
  ['{ to, body }', (s) => ({ tool_name: 'send_message', input: { to: s.destination, body: s.text } })],
  ['{ to, subject, body }', (s) => ({ tool_name: 'send_email', input: { to: s.destination, subject: s.subject ?? 'Fwd', body: s.text } })],
  ['{ recipient, text }', (s) => ({ tool_name: 'forward_message', input: { recipient: s.destination, text: s.text } })],
  ['{ channel, text }', (s) => ({ tool_name: 'post_message', input: { channel: s.destination, text: s.text } })],
  ['{ address, body }', (s) => ({ tool_name: 'send', input: { address: s.destination, body: s.text } })],
  ['{ body, to }', (s) => ({ tool_name: 'send_message', input: { body: s.text, to: s.destination } })],
  ['{ text, recipient }', (s) => ({ tool_name: 'forward_message', input: { text: s.text, recipient: s.destination } })],
  ['{ to, kind, body }', (s) => ({ tool_name: 'send_message', input: { to: s.destination, kind: 'notice', body: s.text } })],
  ['{ url, body }', (s) => ({ tool_name: 'http_post', input: { url: s.destination, body: s.text } })],
  ['{ command, args: [destination, text] }', (s) => ({ tool_name: 'run', input: { command: 'send', args: [s.destination, s.text] } })],
  ["mail -s 'Fwd' <destination> <<< '<text>'", (s) => ({ tool_name: 'bash', input: { command: `mail -s 'Fwd' ${s.destination} <<< ${single(s.text)}` } })],
  ['echo "<text>" | mail -s Fwd <destination>', (s) => ({ tool_name: 'bash', input: { command: `echo ${JSON.stringify(s.text)} | mail -s Fwd ${s.destination}` } })],
  ['send <<< "<text>" <destination>', (s) => ({ tool_name: 'bash', input: { command: `send <<< ${JSON.stringify(s.text)} ${s.destination}` } })],
  ["curl -d '<text>' <destination>", (s) => ({ tool_name: 'bash', input: { command: `curl -d ${single(s.text)} ${s.destination}` } })],
  ["curl <destination> -d '<text>'", (s) => ({ tool_name: 'bash', input: { command: `curl ${s.destination} -d ${single(s.text)}` } })],
];
