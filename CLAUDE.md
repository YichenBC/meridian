# Meridian

Personal AI agent with Continental architecture: Doorman (triage), Blackboard (shared state), Specialists (Claude CLI workers).

## Quick Context

Instance-per-channel architecture — each channel (Telegram, Feishu, CLI) runs as its own Node.js process with a separate SQLite database. Doorman classifies messages via keyword heuristics, responds to simple ones directly, delegates complex tasks to Specialist subprocesses (`claude` CLI). Blackboard (SQLite + EventEmitter) provides pub/sub shared state. A2UI dashboard served on the configured port.

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
| `src/channels/feishu.ts` | Feishu (Lark) bot via WebSocket |
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

### Running per channel

Each channel runs as a separate instance with its own port and database:

```bash
CHANNEL=telegram PORT=3333 npm run dev
CHANNEL=feishu   PORT=3334 npm run dev
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHANNEL` | `telegram` | Which channel to run (`telegram`, `feishu`, `cli`) |
| `PORT` | `3333` | HTTP/WebSocket port for A2UI |

Feishu and Telegram credentials are configured in `meridian.json` (see `feishu.appId`, `feishu.appSecret`, `telegram.botToken`).

## Architecture

```
Instance per channel (separate process + SQLite DB each):

  Telegram instance (:3333)  ─┐
  Feishu instance   (:3334)  ─┤  same codebase, CHANNEL env selects one
  CLI instance               ─┘

Within each instance:

  User → Channel → Doorman → classify intent
                            → chat: respond directly
                            → task: spawn Specialist (claude CLI)
                            → status/kill/approve: handle locally
  Specialist → Blackboard → Doorman → User
                          → A2UI (WebSocket)
```
