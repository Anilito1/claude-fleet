# Agent Observatory — dev & technical notes

## How it works

Claude Code writes each session to `~/.claude/projects/<project>/<sessionId>.jsonl`, and each sub-agent to `<sessionId>/subagents/agent-<id>.jsonl` (+ a `.meta.json` describing the agent). Agent Observatory **watches those files** (read-only, incremental — it never re-reads the whole file, only the new bytes) and derives sessions, sub-agents, hierarchy, current activity, token usage and an estimated $ cost. Everything is local; no API key, no network.

## Build from source

```bash
git clone https://github.com/Anilito1/agent-observatory.git
cd agent-observatory
npm install
npm run build
```

Then in VS Code: open the folder and press **F5** ("Run Agent Observatory") → an Extension Development Host opens with the **Agent Observatory** icon in the activity bar.

Package a `.vsix`:

```bash
npm i -g @vscode/vsce
vsce package
```

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `agentObservatory.projectsDir` | `~/.claude/projects` | Claude Code transcripts folder. |
| `agentObservatory.activeWindowMinutes` | `180` | A session touched within this window is shown. |
| `agentObservatory.liveWindowSeconds` | `120` | A session touched within this window is "live". |
| `agentObservatory.pollIntervalMs` | `1500` | Watcher refresh cadence. |
| `agentObservatory.claudeCommand` | `claude` | CLI used to launch / resume sessions. |
| `agentObservatory.pricing` | `{}` | Override $/1M-token rates per model family. |

### Pricing

Defaults follow Anthropic's public rate structure (cache write 5 min = 1.25× input, 1 h = 2× input, cache read = 0.1× input). Override any of it:

```jsonc
"agentObservatory.pricing": {
  "opus":   { "input": 15, "output": 75, "cacheWrite5m": 18.75, "cacheWrite1h": 30, "cacheRead": 1.5 },
  "sonnet": { "input": 3,  "output": 15, "cacheWrite5m": 3.75,  "cacheWrite1h": 6,  "cacheRead": 0.3 },
  "haiku":  { "input": 1,  "output": 5,  "cacheWrite5m": 1.25,  "cacheWrite1h": 2,  "cacheRead": 0.1 }
}
```

Very large transcripts (> 12 MB) are read from their tail to avoid blocking the editor; their cost is then marked **≈** (partial). Normal active sessions are exact.

## Architecture

```
src/
  extension.ts   Controller: commands, view/panel, state broadcast
  watcher.ts     Scan + incremental read (per-file offset) + hierarchy + status + period aggregation
  parser.ts      Parse a JSONL line: token usage, title, activity
  pricing.ts     Per-model rates + cost calc
  launcher.ts    Terminals: new session / take control
  panel.ts       Webview (side view + full panel) + CSP
  types.ts       Shared host ↔ webview data model
media/
  main.js        Orb rendering, floating animation loop, SVG connectors, drawer, i18n
  style.css      Theme + animations
  avatars/       Character clips (working.mp4, chilling.mp4)
```

## Notes

- Read-only on transcripts; "take control" opens `claude --resume <id>` in a terminal (no direct injection into a running process, by design).
- $ cost is an estimate from configurable rates, not real billing.
- "Live" detection is based on file freshness (mtime), not a socket.
- Only two character clips are used (`working`, `chilling`); other states map onto these. Drop more clips in `media/avatars/` to extend.

MIT © Anilito1
