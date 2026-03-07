# Meridian

A blackboard-based coordination brain for multi-agent AI orchestration.

Meridian uses the **Continental Architecture**: a Doorman (intent classification), a Blackboard (shared state hub), and Specialists (pluggable executors) — coordinating work across LLM providers, Claude/Codex CLI, and external agent systems.

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
    Executors: LLMExecutor │ ClaudeCodeExecutor │ CodexCliExecutor
```

## Quick Start

### Prerequisites

- **Node.js 20+**
- **Claude Code CLI** (`claude`) — optional, for tool/coding tasks
- **Codex CLI** (`codex`) — optional, alternative tool/coding executor
- An LLM provider API key (Anthropic/MiniMax-compatible Messages API, or OpenAI Chat Completions API)

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

  // LLM provider (either anthropic-messages OR openai-chat)
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

  // Meridian's primary skill directory (default: ./skills)
  "skillsDir": "/absolute/path/to/meridian/skills",

  // Optional extra skill directories, such as OpenClaw skills
  // Meridian's own skillsDir wins on same-name collisions
  "extraSkillsDirs": [
    "/absolute/path/to/openclaw/openclaw/skills"
  ],

  // Optional: Claude Code CLI path (auto-detected if on PATH)
  "claudeCliPath": "/usr/local/bin/claude",

  // Optional: Codex CLI path
  "codexCliPath": "/usr/local/bin/codex",

  // Optional: how Meridian runs codex tasks
  // "subprocess" keeps today's behavior
  // "host-bridge" sends the request to an external native host service
  "codexExecutionMode": "subprocess",

  // Required when codexExecutionMode = "host-bridge"
  "codexHostBridgeUrl": "http://127.0.0.1:4318/v1/codex/exec",
  "codexHostBridgeTimeoutMs": 900000,

  // Optional: default tool executor for delegated action tasks
  // "claude-code" (default) or "codex-cli"
  "toolExecutor": "claude-code",

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

OpenAI-compatible setup example:

```jsonc
{
  "provider": {
    "baseUrl": "https://api.openai.com",
    "api": "openai-chat",
    "apiKey": "sk-...",
    "authHeader": false,
    "models": [
      { "id": "gpt-4.1", "contextWindow": 1000000, "maxTokens": 8192 }
    ]
  },
  "model": "gpt-4.1"
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
│   ├── claude-code-executor.ts  # Claude CLI subprocess executor
│   └── codex-cli-executor.ts    # Codex CLI subprocess executor
├── channels/
│   ├── cli.ts               # stdin/stdout channel
│   └── telegram.ts          # Telegram bot (grammy)
├── providers/
│   ├── types.ts             # ModelProvider interface
│   ├── index.ts             # Provider factory
│   ├── anthropic-messages.ts # Anthropic Messages API + SSE streaming
│   └── openai-chat.ts       # OpenAI Chat Completions API + SSE streaming
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
executor: llm          # or claude-code / codex-cli
model: claude-sonnet-4-5-20250514  # optional override
---

# Skill instructions here
Markdown content injected into the agent's system prompt.
```

Meridian supports two skill sources:

- Primary `skillsDir`: Meridian-managed skills. This is the default install target and has highest precedence.
- Optional `extraSkillsDirs`: external skill trees such as OpenClaw's `openclaw/skills`.

At runtime, Meridian loads both. If two skills have the same `name`, the copy in `skillsDir` wins. The loader only requires `SKILL.md`, so OpenClaw-style skill folders work as long as they contain that file; extra files such as `manifest.yaml` and helper scripts are preserved on install.

Installed skills are prepared into a neutral execution context before task dispatch. Executors consume that prepared context instead of reading skill files directly, so `llm`, `claude-code`, and `codex-cli` all use the same skill-binding path.

When a skill declares `metadata.openclaw.requires`, Meridian evaluates those gates at load time:

- `requires.bins` and `requires.anyBins`
- `requires.env` with support for OpenClaw `skills.entries.<skillKey>.env` and `apiKey`
- `requires.config` against both `meridian.json` and `~/.openclaw/openclaw.json`
- `skillKey`, `primaryEnv`, `os`, and `enabled: false` in OpenClaw skill entries

Ineligible skills still appear in `/api/skills`, but they include an `eligibility` object and are skipped by automatic skill selection.

### Skill Management API

```bash
# List loaded skills
curl http://localhost:3333/api/skills

# Install a skill into Meridian's primary skillsDir
curl -X POST http://localhost:3333/api/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"sourcePath":"/absolute/path/to/openclaw/openclaw/skills/weather"}'
```

Meridian accepts natural-language install requests such as:

```text
please install the weather skill
install skill "/absolute/path/to/skill-dir"
帮我安装 weather skill
```

Resolution order:

- direct filesystem path with `SKILL.md`
- matching skill name inside configured `extraSkillsDirs`
- fallback to the real `clawhub install <slug>` CLI if `clawhub` is installed

For terminal usage aimed specifically at Meridian, use:

```bash
./bin/meridian-skill install weather
./bin/meridian-skill install /absolute/path/to/skill-dir
```

Meridian writes install provenance to `.meridian-skill.json` inside the installed skill directory and exposes the same data in `GET /api/skills`, so you can tell whether a skill came from a local path, an extra skills directory, or a ClawHub download.

`clawhub install <slug>` remains the OpenClaw / ClawHub-native command and should not be overloaded to mean Meridian installs.

## Configuration Reference

| Setting | Env Override | Default | Description |
|---|---|---|---|
| `port` | `MERIDIAN_PORT` | `3333` | HTTP/WebSocket server port |
| `dataDir` | `MERIDIAN_DATA_DIR` | `./data` | SQLite database location |
| `skillsDir` | `MERIDIAN_SKILLS_DIR` | `./skills` | Skills directory |
| `extraSkillsDirs` | `MERIDIAN_EXTRA_SKILLS_DIRS` | unset | Extra skill roots (path-delimited), e.g. OpenClaw skills |
| `maxAgents` | `MERIDIAN_MAX_AGENTS` | `3` | Max parallel agents |
| `agentTimeoutMs` | `MERIDIAN_AGENT_TIMEOUT` | `300000` | Agent timeout (5min) |
| `claudeCliPath` | `MERIDIAN_CLAUDE_CLI` | unset | Path to `claude` CLI (enables claude-code executor) |
| `codexCliPath` | `MERIDIAN_CODEX_CLI` | unset | Path to `codex` CLI (enables codex-cli executor) |
| `codexExecutionMode` | `MERIDIAN_CODEX_EXEC_MODE` | `subprocess` | Run codex locally as a child process or through a native host bridge |
| `codexHostBridgeUrl` | `MERIDIAN_CODEX_HOST_BRIDGE_URL` | unset | HTTP endpoint for an external host-native codex execution service |
| `codexHostBridgeToken` | `MERIDIAN_CODEX_HOST_BRIDGE_TOKEN` | unset | Optional bearer token for the host bridge |
| `codexHostBridgeTimeoutMs` | `MERIDIAN_CODEX_HOST_BRIDGE_TIMEOUT` | `900000` | Timeout for a host-bridge codex execution request |
| `toolExecutor` | `MERIDIAN_TOOL_EXECUTOR` | `claude-code` | Doorman default executor for tool/file/shell tasks |

## Host-Native Codex Execution

`codexExecutionMode: "host-bridge"` is the path for running codex outside Meridian's own process sandbox. In this mode Meridian no longer `spawn()`s `codex` directly; it sends a JSON request to an external host service:

```json
{
  "executor": "codex-cli",
  "prompt": "task prompt",
  "model": "optional-model",
  "sessionId": "optional-session",
  "cwd": "/absolute/project/path",
  "purpose": "agent-task | doorman"
}
```

The bridge must return JSON like:

```json
{
  "content": "final result text",
  "sessionId": "optional-session-id",
  "model": "resolved-model",
  "inputTokens": 123,
  "outputTokens": 456
}
```

Important limits:

- Meridian can route to a host bridge, but it does not create the host bridge for you.
- Child processes inherit Meridian's sandbox; a real non-sandbox path therefore requires a separate native service (for example a launchd agent, desktop helper, or another unsandboxed daemon).
- In constitutional mode, agent tasks that use host-native codex execution are treated as high risk and go through approval.
- If you also point the Doorman at `codex-cli`, the Doorman can use the same bridge, but its safety then depends on the external host bridge because Doorman calls do not go through task-level approvals.

## License

MIT
