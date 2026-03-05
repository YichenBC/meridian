# Meridian

Personal AI agent with Continental architecture: Doorman (triage), Blackboard (shared state), Specialists (Claude CLI workers).

## Quick Context

Single Node.js process. Doorman classifies messages via keyword heuristics, responds to simple ones directly, delegates complex tasks to Specialist subprocesses (`claude` CLI). Blackboard (SQLite + EventEmitter) provides pub/sub shared state. A2UI dashboard at http://localhost:3333.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, wires everything |
| `src/types.ts` | All shared interfaces |
| `src/config.ts` | Env-based configuration |
| `src/blackboard/blackboard.ts` | EventEmitter + SQLite pub/sub state |
| `src/blackboard/db.ts` | SQLite schema + CRUD |
| `src/doorman/doorman.ts` | Message triage, response, specialist management |
| `src/doorman/classifier.ts` | Intent classification (heuristic) |
| `src/doorman/http-server.ts` | HTTP + WebSocket for A2UI |
| `src/channels/cli.ts` | stdin/stdout channel |
| `src/specialists/runner.ts` | Spawn claude CLI subprocesses |
| `src/specialists/registry.ts` | Track active specialists |
| `src/skills/loader.ts` | Load SKILL.md files |
| `a2ui/index.html` | Single-file PWA dashboard |

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm start      # Run compiled JS
```

## Architecture

```
User → CLI/A2UI → Doorman → classify intent
                          → chat: respond directly
                          → task: spawn Specialist (claude CLI)
                          → status/kill/approve: handle locally
Specialist → Blackboard → Doorman → User
                        → A2UI (WebSocket)
```
