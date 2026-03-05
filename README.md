# Meridian

A blackboard-based coordination brain for multi-agent AI orchestration.

Meridian uses the **Continental Architecture**: a Doorman (intent classification), a Blackboard (shared state hub), and Specialists (pluggable executors) — coordinating work across LLM providers, Claude Code CLI, and external agent systems.

## Architecture

```
Channels (CLI, Telegram, A2UI WebSocket)
         │
    ┌────▼────┐
    │ Doorman  │  Intent classification (fast regex + LLM fallback)
    └────┬────┘
         │
    ┌────▼──────┐
    │ Blackboard │  SQLite + EventEmitter (tasks, agents, feeds, approvals)
    └────┬──────┘
         │
    ┌────▼───────┐
    │ Agent Runner│  Slot-based spawning (max 3 parallel)
    └────┬───────┘
         │
    Executors: LLMExecutor │ ClaudeCodeExecutor
```

## Quick Start

### Prerequisites

- **Node.js 20+**
- **Claude Code CLI** (`claude`) — optional, for code tasks
- An LLM provider API key (Anthropic, MiniMax, or any Anthropic Messages API-compatible endpoint)

### Install

```bash
git clone https://github.com/YichenBC/meridian.git
cd meridian
npm install
```

### Configure

Copy the example config and edit it:

```bash
cp meridian.example.json meridian.json
```

Edit `meridian.json`:

```jsonc
{
  // Optional: HTTP proxy
  "proxy": "http://127.0.0.1:10808",

  // LLM provider (any Anthropic Messages API-compatible endpoint)
  "provider": {
    "baseUrl": "https://api.anthropic.com",
    "api": "anthropic-messages",
    "apiKey": "sk-ant-...",
    "authHeader": true,
    "models": [
      { "id": "claude-sonnet-4-5-20250514", "contextWindow": 200000, "maxTokens": 8192 }
    ]
  },

  // Default model for classification and chat
  "model": "claude-sonnet-4-5-20250514",

  // Optional: Claude Code CLI path (auto-detected if on PATH)
  "claudeCliPath": "/usr/local/bin/claude",

  // Optional: Telegram bot
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "your-chat-id"
  },

  // Optional: tuning
  "port": 3333,
  "maxAgents": 3,
  "agentTimeoutMs": 300000
}
```

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

### Verify

- **CLI**: Type in your terminal — you'll see a `you>` prompt
- **A2UI Dashboard**: Open http://localhost:3333
- **Telegram**: Send a message to your bot (if configured)
- **Health check**: `curl http://localhost:3333/api/state`

## Usage

### From the CLI or Telegram

```
you> what's the status?           # Shows running agents, pending tasks
you> research quantum computing   # Spawns a researcher agent
you> fix the bug in auth.ts       # Spawns a coder agent (Claude Code)
you> kill all                     # Stops all running agents
you> approve                      # Approves pending approval
```

### From the HTTP API

```bash
# Submit a task directly
curl -X POST http://localhost:3333/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Analyze the codebase structure", "role": "researcher"}'

# Get full state
curl http://localhost:3333/api/state

# Add a note
curl -X POST http://localhost:3333/api/notes \
  -H 'Content-Type: application/json' \
  -d '{"title": "Reminder", "content": "Check deployment", "tags": ["ops"]}'
```

## Project Structure

```
src/
├── index.ts                 # Entry point, wires everything
├── types.ts                 # Shared interfaces
├── config.ts                # Configuration (meridian.json + env vars)
├── logger.ts                # Pino logger
├── scheduler.ts             # Cron-based proactive tasks
├── blackboard/
│   ├── blackboard.ts        # EventEmitter + SQLite pub/sub state hub
│   └── db.ts                # SQLite schema, CRUD, migrations
├── doorman/
│   ├── doorman.ts           # Message triage, intent dispatch
│   ├── classifier.ts        # Two-tier intent classification
│   └── http-server.ts       # HTTP + WebSocket server, A2UI
├── agents/
│   ├── runner.ts            # Agent lifecycle, slot-based spawning
│   ├── registry.ts          # In-memory agent tracking
│   ├── executor.ts          # LLMExecutor implementation
│   └── claude-code-executor.ts  # Claude CLI subprocess executor
├── channels/
│   ├── cli.ts               # stdin/stdout channel
│   └── telegram.ts          # Telegram bot (grammy)
├── providers/
│   ├── types.ts             # ModelProvider interface
│   ├── index.ts             # Provider factory
│   └── anthropic-messages.ts # Anthropic Messages API + SSE streaming
└── skills/
    └── loader.ts            # SKILL.md parser (YAML frontmatter)

skills/                      # Skill definitions
├── example/SKILL.md         # General-purpose assistant
└── meridian-system/SKILL.md # System introspection (claude-code executor)

a2ui/
└── index.html               # Single-file PWA dashboard

tests/                       # Integration test scripts
```

## Skills

Skills are Markdown files with YAML frontmatter in `skills/<name>/SKILL.md`:

```yaml
---
name: my-skill
description: What this skill does
executor: llm          # or claude-code
model: claude-sonnet-4-5-20250514  # optional override
---

# Skill instructions here
Markdown content injected into the agent's system prompt.
```

## Configuration Reference

| Setting | Env Override | Default | Description |
|---|---|---|---|
| `port` | `MERIDIAN_PORT` | `3333` | HTTP/WebSocket server port |
| `dataDir` | `MERIDIAN_DATA_DIR` | `./data` | SQLite database location |
| `skillsDir` | `MERIDIAN_SKILLS_DIR` | `./skills` | Skills directory |
| `maxAgents` | `MERIDIAN_MAX_AGENTS` | `3` | Max parallel agents |
| `agentTimeoutMs` | `MERIDIAN_AGENT_TIMEOUT` | `300000` | Agent timeout (5min) |
| `claudeCliPath` | `MERIDIAN_CLAUDE_CLI` | auto-detect | Path to `claude` CLI |

## License

MIT
