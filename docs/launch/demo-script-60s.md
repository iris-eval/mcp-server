# Iris Demo Script — "Zero to First Trace" (60s)

Companion to the full 3-4 minute demo script (`demo-script.md`). This is a fast, punchy screen recording with voiceover. No slides. Real UI only.

---

## 60-Second Version

### 0:00-0:05 — Hook

**Voiceover:** "Your AI agents are running. You have no idea what they're doing. Here's how to fix that in 60 seconds."

**Screen:** Dark background. Text fades in line by line, matching the voiceover cadence. No animation beyond the fade. Cut to editor on final word.

---

### 0:05-0:15 — The Config

**Voiceover:** "Add one entry to your MCP config. No SDK. No code changes. Just this."

**Screen:** Editor open to `claude_desktop_config.json`. The Iris config block is typed or pasted in:

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

**Text overlay (bottom-right, 0:12):** `Zero integration code`

**Notes:** Type the JSON at a realistic but fast speed. Do not fast-forward — it should feel effortless, not rushed. File save at 0:14, cut to next scene.

---

### 0:15-0:30 — The Agent Runs

**Voiceover:** "Restart your agent. It discovers Iris automatically through the MCP protocol and starts reporting traces, eval scores, and costs. No wiring. The protocol handles it."

**Screen:** Claude Desktop (or Cursor) launching. Show the MCP server list — Iris appears as a connected server. Then run a real task: ask the agent something that produces tool calls (e.g., "What is our refund policy for annual plans?"). The agent runs, calls a tool, returns a response. The key visual: the agent calling `log_trace` and `evaluate_output` in its tool call sidebar.

**Text overlay (bottom-right, 0:20):** `Auto-discovered via MCP`

**Notes:** The agent task should be short enough to complete within this window. Pre-run once to warm the npx cache so there is no download delay during recording. If Claude Desktop is used, make sure Iris shows in the MCP tools panel.

---

### 0:30-0:50 — The Dashboard

**Voiceover (0:30-0:37):** "Open the dashboard. Every tool call. Every token. Every dollar."

**Screen:** Browser opens `http://localhost:6920`. Summary page loads: trace count, average score, pass rate, total cost cards at top. Timeline chart below.

**Text overlay (bottom-right, 0:33):** `12 eval rules | <1ms | $0`

**Voiceover (0:37-0:43):** "PII detection caught an email pattern in the response. Hallucination markers flagged. Cost threshold — enforced."

**Screen:** Click into a trace. Span tree expands showing the agent chain. Eval results panel on the right shows: `no_pii` failed (detected email), `no_hallucination_markers` warning, `cost_under_threshold` passed. Scroll slowly through the eval details.

**Voiceover (0:43-0:50):** "All deterministic. No LLM-as-judge. Under one millisecond per eval."

**Screen:** Mouse hovers over the eval latency indicator showing sub-millisecond timing. Then back out to the trace list showing multiple traces with scores and cost columns.

**Notes:** Dashboard should have 15-20+ traces pre-loaded so it looks realistic, not empty. Include at least one trace with a PII failure and one with a hallucination warning. The span tree expansion is the visual hook — make sure it is visible and readable at recording resolution.

---

### 0:50-0:60 — CTA

**Voiceover:** "Iris. MCP-native agent eval and observability. Open-source core. MIT licensed."

**Screen:** Clean dark background. Text appears line by line:

```
Iris — MCP-Native Agent Eval & Observability

npx @iris-eval/mcp-server

github.com/iris-eval/mcp-server
iris-eval.com
```

**Voiceover (0:57):** "npx @iris-eval/mcp-server. iris-eval.com."

**Text overlay (final frame, hold for 3s):** GitHub and website URLs.

**Notes:** The final frame should hold for at least 2-3 seconds after voiceover ends. This is the frame people screenshot.

---

---

## 30-Second Version (Social Media Cut)

Optimized for X, LinkedIn, and YouTube Shorts. Vertical (9:16) or square (1:1) crop.

### 0:00-0:03 — Hook

**Voiceover:** "See what your AI agents are actually doing. 30 seconds."

**Screen:** Text on dark background matching voiceover.

### 0:03-0:10 — The Config

**Voiceover:** "One JSON entry. No SDK. No code changes."

**Screen:** Editor showing the `claude_desktop_config.json` Iris block. Quick type, save.

### 0:10-0:20 — The Dashboard

**Voiceover:** "Traces, eval scores, costs. PII detection. Hallucination flags. All in under a millisecond."

**Screen:** Dashboard summary page — quick cut to trace detail with span tree — quick cut to eval results showing a PII failure.

**Text overlay (0:14):** `12 eval rules | <1ms | $0`

### 0:20-0:30 — CTA

**Voiceover:** "Iris. MCP-native eval and observability. Open source."

**Screen:** Clean dark background with:

```
npx @iris-eval/mcp-server
iris-eval.com
```

Hold final frame for 3 seconds.

---

---

## Screen Recording Checklist

Everything Ian needs to capture before editing.

### Environment Setup (do before recording)

- [ ] Run `npx @iris-eval/mcp-server --dashboard` once to warm the npx cache
- [ ] Pre-load 15-20 traces into the database across 2-3 agent names, with varied scores and costs
- [ ] Include at least one trace where `no_pii` fails (output contains an email or phone number)
- [ ] Include at least one trace where `no_hallucination_markers` returns a warning
- [ ] Include at least one trace where `cost_under_threshold` passes and one where it fails
- [ ] Set terminal to dark theme, monospace font, minimum 16pt
- [ ] Set browser zoom to 100% or 110% so dashboard text is readable at 1080p
- [ ] Hide browser bookmarks bar and other toolbars for clean framing
- [ ] Resolution: 1920x1080 minimum, 2560x1440 preferred

### Recordings Needed

| # | Scene | What to capture | Duration | Notes |
|---|-------|----------------|----------|-------|
| 1 | Config | Editor open, type/paste the Iris JSON block into `claude_desktop_config.json`, save | ~10s | Use VS Code or similar. Real file, not a mockup. |
| 2 | Agent run | Claude Desktop or Cursor running a task with Iris connected. Show Iris in the MCP server list, then the agent calling `log_trace` and `evaluate_output` in the tool sidebar. | ~15s | Pick a task that completes in under 10 seconds. Pre-warm caches. |
| 3 | Dashboard summary | Browser opening `localhost:6920`. Summary cards and timeline chart visible. | ~5s | Make sure the page loads instantly (pre-open in a tab if needed). |
| 4 | Trace detail | Click into a trace. Span tree expands. Eval results panel visible with pass/fail indicators. | ~15s | Pick the trace with the PII failure so there is something visually interesting. Scroll slowly. |
| 5 | Trace list | Back out to the trace list. Multiple traces visible with score, latency, cost columns. | ~5s | 15+ rows visible. Sort by timestamp descending. |
| 6 | CTA frame | Static dark background with text: Iris headline, npx command, GitHub URL, website URL. | ~10s | Create this as a still image or simple title card. Hold long enough for screenshots. |

### For the 30-Second Cut

Same recordings as above, just edited tighter. No additional capture needed. Skip the agent run scene (scene 2) and compress the dashboard into a quick-cut montage of scenes 3 and 4.

### Voiceover

- Record voiceover separately from screen capture (easier to edit and re-time)
- Tone: direct and confident, not salesy. Think explaining to a peer, not pitching to a customer.
- Pace: deliberate but not slow. Every word earns its place.
- No background music for the 60s version (optional subtle ambient for the 30s social cut)
