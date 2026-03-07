# Meridian

Personal AI agent with Continental architecture: Doorman (triage), Blackboard (shared state), Specialists (Claude CLI workers).

## Quick Context

Instance-per-channel architecture — each channel (Telegram, Feishu, CLI) runs as its own Node.js process with a separate SQLite database. Doorman classifies messages via keyword heuristics, responds to simple ones directly, delegates complex tasks to Specialist subprocesses (`claude` CLI). Blackboard (SQLite + EventEmitter) provides pub/sub shared state with DAG-based task scheduling. A2UI dashboard served on the configured port.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, wires everything |
| `src/types.ts` | All shared interfaces |
| `src/config.ts` | Env-based configuration |
| `src/blackboard/blackboard.ts` | EventEmitter + SQLite pub/sub state |
| `src/blackboard/db.ts` | SQLite schema + CRUD + DAG operations |
| `src/blackboard/permissions.ts` | Constitutional permission system |
| `src/doorman/doorman.ts` | Message triage, response, specialist management |
| `src/doorman/classifier.ts` | Intent classification (heuristic) |
| `src/doorman/http-server.ts` | HTTP + WebSocket for A2UI, health endpoint |
| `src/agents/runner.ts` | DAG-aware agent spawning with context windowing |
| `src/agents/registry.ts` | Track active agents, slot management |
| `src/agents/executor.ts` | LLM-based agent executor |
| `src/agents/claude-code-executor.ts` | Claude Code CLI executor |
| `src/agents/codex-cli-executor.ts` | Codex CLI executor |
| `src/channels/cli.ts` | stdin/stdout channel |
| `src/channels/telegram.ts` | Telegram bot channel |
| `src/channels/feishu.ts` | Feishu (Lark) bot via WebSocket |
| `src/skills/loader.ts` | Load SKILL.md files |
| `src/skills/context.ts` | Task context preparation + blackboard context |
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

### Testing

```bash
npm run test:unit          # All unit tests (77 tests, 13 suites)
npm run test:bench         # Performance benchmarks
npm run test:dag           # DAG scheduling unit tests
npm run test:dag:integration  # DAG runner simulation tests
npm run test:feeds         # Feed rotation tests
npm run test:context       # Context windowing tests
npm run test:permissions   # Permission system tests
npm run test:skills        # Skills support tests
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHANNEL` | `telegram` | Which channel to run (`telegram`, `feishu`, `cli`) |
| `PORT` | `3333` | HTTP/WebSocket port for A2UI |
| `MERIDIAN_API_TOKEN` | (none) | Bearer token for `/api/*` endpoints |

API token can also be set in `meridian.json` as `apiToken`.

## Architecture

```
Instance per channel (separate process + SQLite DB each):

  Telegram instance (:3333)  ─┐
  Feishu instance   (:3334)  ─┤  same codebase, CHANNEL env selects one
  CLI instance               ─┘

Within each instance:

  User → Channel → Doorman → classify intent
                            → chat: respond directly
                            → task: create on Blackboard
                            → status/kill/approve: handle locally

  Blackboard → Runner → drainPending (DAG-aware, priority-sorted)
                       → claimTask (atomic) → spawn Agent
                       → context windowing (blocker results + notes)

  Agent → Executor (LLM/claude-code/codex) → result → Blackboard
  Blackboard → Doorman → User
             → A2UI (WebSocket)

Task DAG: tasks can declare blockedBy (dependency array) and priority.
Runner processes tasks in waves — blocked tasks wait until all
dependencies complete. Completed tasks trigger re-drain to unblock
dependents.
```

## Key Design Decisions

- **Atomic claiming**: `claimTask()` uses `UPDATE WHERE status='pending'` to prevent race conditions
- **Feed rotation**: Old feed entries auto-pruned on startup (keeps last 5000)
- **Context windowing**: Agents receive predecessor task results + relevant notes, not full blackboard state
- **Approval timeout**: 30-minute limit on approval listeners prevents resource leaks
- **Constitutional permissions**: 3 modes (passthrough/constitutional/supervised) with risk assessment
