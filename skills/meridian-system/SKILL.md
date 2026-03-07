---
name: meridian-system
description: "Meridian system introspection — check blackboard state, database health, agent status"
executor: claude-code
---

# Meridian System Skill

You are an agent within the Meridian multi-agent system. You have access to the system internals.

## Blackboard Database

Location: `data/<channel>.db` (for example `data/cli.db`, `data/telegram.db`, `data/feishu.db`; SQLite, WAL mode)

Tables:
- `tasks` — id, prompt, role, status, agentId, result, error, executor, model, parentTaskId, sessionId, source, createdAt, updatedAt
- `agents` — id, role, status, currentTaskId, pid, startedAt, lastActivityAt, executor, outputBytes, persistent
- `feeds` — id, type, source, content, taskId, timestamp
- `approvals` — id, taskId, description, status, createdAt, resolvedAt
- `notes` — id, source, title, content, tags, taskId, createdAt

## HTTP API

All agents can interact with the blackboard via HTTP:
- `POST /api/tasks` — create a new task (body: `{prompt, role?, executor?, model?, source?}`)
- `POST /api/notes` — add a note (body: `{title, content, source?, tags?, taskId?}`)
- `GET /api/notes` — list notes (query: `?limit=50&tag=`)
- `GET /api/state` — full blackboard snapshot

## Project Structure

```
src/
  index.ts          — entry point
  types.ts          — shared interfaces
  config.ts         — configuration
  blackboard/       — SQLite + EventEmitter pub/sub
  doorman/          — user-facing message handler + HTTP/WS server
  agents/           — runner, registry, executors
  channels/         — CLI, Telegram, Feishu
  providers/        — LLM API providers
  skills/           — skill loader
```

## Proactive / Scheduled Tasks

Use system cron to post tasks to the blackboard via HTTP API. No in-process scheduler needed.

```cron
# Daily brief at 9am
0 9 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Generate daily brief","executor":"claude-code","source":"cron"}'

# Monitor disk usage every 6 hours
0 */6 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Check disk usage and alert if above 80%","executor":"claude-code","source":"cron"}'
```

The reactive runner picks up cron-posted tasks the same as user tasks.

## Self-Modification

You can modify Meridian itself. This is by design — the Doorman delegates these tasks to you (a claude-code specialist), never does them itself.

### CRITICAL: You are running inside a live system

The Meridian process that spawned you is currently serving users via Telegram/Feishu/CLI. If your changes crash the process, the user loses all communication channels and cannot instruct you to fix it. You must treat self-modification like surgery on a patient who must stay alive.

### Safety protocol (mandatory)

Before modifying ANY source file:
1. **Git snapshot**: `git add -A && git commit -m "pre-self-modify: <what you plan to do>"`
2. **Identify risk tier** (see below)
3. **Build gate**: `npm run build` — if it fails, revert immediately with `git checkout .`
4. **Never restart the process** — your changes take effect on next user-initiated restart

### Risk tiers

**SAFE (modify freely):**
- `skills/` — adding or editing skill files
- `tests/` — adding or editing tests
- `data/` — database queries, cleanup
- `a2ui/` — dashboard changes
- `meridian.json` — config changes (take effect on restart)
- New files that don't affect existing imports

**CAUTION (modify carefully, build-gate required):**
- `src/doorman/` — the Doorman triage logic. A bug here means users get no response.
- `src/agents/` — the runner/registry. A bug here means no agents can spawn.
- `src/providers/` — LLM provider. A bug here means agents can't think.
- `src/types.ts` — shared interfaces. Breaking changes cascade everywhere.

**FORBIDDEN (never modify while running):**
- `src/index.ts` — the entry point. Changes can't take effect without restart.
- `src/channels/` — channel connectors. A bug disconnects the user permanently.
- `src/blackboard/` — the coordination core. A bug can corrupt shared state.
- `package.json` / `package-lock.json` — dependency changes require restart.

If a task requires modifying FORBIDDEN files:
1. Make the change
2. Run `npm run build` to verify it compiles
3. Report to the user: "Changes ready but require restart to take effect. Run `npm run dev` to apply."
4. Do NOT attempt to restart the process yourself

### What you can do
- Edit source files in `src/` (respecting risk tiers above)
- Run `npm run build` to compile, `npm test` to verify
- Modify `meridian.json` for config changes
- Add or edit skills in `skills/`
- Query and repair the SQLite database
- Post follow-up tasks via `POST /api/tasks` if the work needs multiple steps

### After making changes, always:
1. Run `npm run build` to verify the code compiles
2. If build fails: `git checkout .` to revert, then report the error
3. If build succeeds: `git add -A && git commit -m "self-modify: <summary>"`
4. Summarize what you changed, the risk tier, and whether restart is needed

## Guidelines

- Use `sqlite3` to query the database (path depends on channel: `data/telegram.db`, `data/feishu.db`, etc.)
- Check agent status, task queue, recent feeds
- Report findings clearly and concisely
