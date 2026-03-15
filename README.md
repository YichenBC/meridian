# Meridian

> **Personal experimental project** — this is a self-use AI agent orchestration system. Not production-ready. Published for reference only.

A blackboard-based coordination brain for multi-agent AI orchestration. Meridian uses the **Continental Architecture**: a Doorman (intent classification), a Blackboard (shared state hub), and Specialists (pluggable executors) — coordinating work across LLM providers, Claude Code CLI, Codex CLI, and external tools.

Currently used as a personal knowledge assistant: ingesting articles/papers/images into an Obsidian vault, answering questions from stored knowledge, and generating daily research briefings — all accessible via Telegram and Feishu.

## Architecture

```
Channels (Telegram, Feishu, CLI, A2UI WebSocket)
         │ text, photos, PDFs, documents
    ┌────▼────┐
    │ Doorman  │  Fast-path regex + LLM fallback triage
    └────┬────┘
         │
    ┌────▼──────┐
    │ Blackboard │  SQLite + EventEmitter (tasks, agents, feeds, approvals)
    └────┬──────┘
         │
    ┌────▼───────┐
    │ Agent Runner│  Slot-based spawning (max 3 parallel), DAG scheduling
    └────┬───────┘
         │
    Claude Code CLI (with skill catalog + media attachments in prompt)
         │
    OpenClaw CLI tools: summarize, obsidian-cli, blogwatcher, peekaboo, ...
```

## Quick Start

### Prerequisites

- **Node.js 20+**
- **Claude Code CLI** (`claude`) on PATH
- An LLM provider API key (for Doorman triage)

### Install

```bash
git clone https://github.com/YichenBC/meridian.git
cd meridian
npm install
```

### Configure

```bash
cp meridian.example.json meridian.json
```

Edit `meridian.json` with your API keys, bot tokens, and paths. See `meridian.example.json` for all available fields. The file is gitignored.

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start

# Per-channel instances
CHANNEL=telegram PORT=3333 npm start
CHANNEL=feishu   PORT=3334 npm start
```

## Knowledge Assistant

Built-in skills for personal knowledge management:

| Skill | What it does |
|-------|-------------|
| `knowledge-ingest` | Ingest URLs, PDFs, images, text into Obsidian vault with summarization and cross-linking |
| `knowledge-query` | Search vault and synthesize answers with citations |
| `daily-brief` | Morning briefing from tracked feeds + recent vault additions |
| `idea-generator` | Cross-reference vault knowledge to find unexpected connections |

### How it works

1. Send a message (Telegram/Feishu/CLI): `"save this https://example.com/article"`
2. Doorman fast-paths it as a task with `claude-code` executor
3. Agent receives a catalog of all available skills, picks `knowledge-ingest`
4. Agent reads the SKILL.md, follows the pipeline: summarize → search vault → write note
5. Result sent back to you via Telegram

### Media attachments

Send photos, PDFs, or documents via Telegram/Feishu — they're downloaded to `data/media/`, paths injected into the agent prompt. Claude Code reads images natively (multimodal) and PDFs.

Telegram media groups (multiple photos sent together) are buffered and batched into a single task.

### Proactive daily jobs (system cron)

```cron
0 6 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Run daily research","executor":"claude-code","source":"cron"}'
0 9 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Generate daily brief","executor":"claude-code","source":"cron"}'
```

## Skills

Skills are Markdown files with YAML frontmatter in `skills/<name>/SKILL.md`. The agent receives a catalog of all eligible skills and reads the relevant SKILL.md (OpenClaw-style LLM semantic matching — no keyword matching).

Meridian loads skills from two sources:
- `skillsDir` (default `./skills`) — Meridian-managed, highest precedence
- `extraSkillsDirs` — external skill trees (e.g., OpenClaw's `openclaw/skills`)

When skills declare `metadata.openclaw.requires` (bins, env, config), Meridian evaluates eligibility at load time. Ineligible skills are skipped.

## HTTP API

```bash
POST /api/tasks     # Create task: {"prompt":"...", "executor":"claude-code"}
GET  /api/state     # Full blackboard snapshot
GET  /api/skills    # Loaded skills with eligibility
POST /api/notes     # Add a note
GET  /health        # Status + uptime
```

## Testing

```bash
npm run test:unit       # All unit tests
npm run test:skills     # Skill loading + executor tests
node --test tests/knowledge-skills.mjs      # Knowledge skill tests
node --test tests/knowledge-integration.mjs # Integration tests
node --test tests/media-support.mjs         # Media attachment tests
```

## License

MIT
