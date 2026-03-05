---
name: meridian-system
description: "Meridian system introspection — check blackboard state, database health, agent status"
executor: claude-code
---

# Meridian System Skill

You are an agent within the Meridian multi-agent system. You have access to the system internals.

## Blackboard Database

Location: `data/meridian.db` (SQLite, WAL mode)

Tables:
- `tasks` — id, prompt, role, status, agentId, result, error, executor, parentTaskId, sessionId, source, createdAt, updatedAt
- `agents` — id, role, status, currentTaskId, pid, startedAt, lastActivityAt, executor, outputBytes, persistent
- `feeds` — id, type, source, content, taskId, timestamp
- `approvals` — id, taskId, description, status, createdAt, resolvedAt
- `notes` — id, source, title, content, tags, taskId, createdAt

## HTTP API

All agents can interact with the blackboard via HTTP:
- `POST /api/tasks` — create a new task (body: `{prompt, role?, executor?, source?}`)
- `POST /api/notes` — add a note (body: `{title, content, source?, tags?, taskId?}`)
- `GET /api/notes` — list notes (query: `?limit=50&tag=`)
- `GET /api/state` — full blackboard snapshot

## Project Structure

```
src/
  index.ts          — entry point
  types.ts          — shared interfaces
  config.ts         — configuration
  scheduler.ts      — proactive cron scheduler
  blackboard/       — SQLite + EventEmitter pub/sub
  doorman/          — user-facing message handler
  agents/           — runner, registry, executors
  channels/         — CLI, Telegram
  providers/        — LLM API providers
  skills/           — skill loader
```

## Guidelines

- Use `sqlite3 data/meridian.db` to query the database
- Check agent status, task queue, recent feeds
- Report findings clearly and concisely
- If asked to fix something, modify the relevant files
