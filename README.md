# Meridian

> **Personal experimental project** — this is a self-use AI agent orchestration system, entirely vibe-coded. Expect rough edges and bugs. Not production-ready. Published for reference only.

Inspired by OpenClaw, I built a blackboard-based coordination brain for multi-agent AI orchestration by entirely **vibe coding** (Claude Code). 
Originally, I am tired of waiting OpenClaw for handling my message queue, in which it cannot tell me the progress of previous task.
And I also want to make use of Claude Code and its skills.
So I want to build a lightweight OpenClaw, **Meridian**, which could always respond to me.
Meridian uses the **Continental Architecture**: a Doorman (intent classification), a Blackboard (shared state hub), and Specialists (pluggable executors) — coordinating work across LLM providers, Claude Code CLI, Codex CLI, and external tools.

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
    │ Blackboard │  SQLite + EventEmitter (tasks, agents, feeds, approvals, notes)
    └────┬──────┘
         │
    ┌────▼───────┐
    │ Agent Runner│  Slot-based spawning (max 3 parallel), DAG scheduling
    └────┬───────┘
         │
    Executors: Claude Code CLI │ Codex CLI │ LLM (direct API)
         │
    Skills (SKILL.md) + OpenClaw CLI tools (summarize, obsidian-cli, blogwatcher, ...)
```

## Quick Start

### Prerequisites

- **Node.js 20+**
- **Claude Code CLI** (`claude`) — primary executor for tool/coding tasks
- **Codex CLI** (`codex`) — optional alternative executor
- An LLM provider API key (Anthropic/OpenAI-compatible, for Doorman triage)
- **Telegram bot token** and/or **Feishu app credentials** (if using those channels)
- For knowledge skills: `obsidian-cli`, `summarize`, `blogwatcher` on PATH (from [OpenClaw](https://github.com/nicobailon/openclaw))

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

# Per-channel instances (each gets its own SQLite DB)
CHANNEL=telegram PORT=3333 npm start
CHANNEL=feishu   PORT=3334 npm start
```

## Knowledge Assistant

Built-in skills for personal knowledge management:

| Skill | What it does | Requires |
|-------|-------------|----------|
| `knowledge-ingest` | Ingest URLs, PDFs, images, text into Obsidian vault with summarization and cross-linking | `obsidian-cli`, `summarize` |
| `knowledge-query` | Search vault and synthesize answers with citations | `obsidian-cli` |
| `daily-brief` | Morning briefing from tracked feeds + recent vault additions | `obsidian-cli`, `blogwatcher` |
| `idea-generator` | Cross-reference vault knowledge to find unexpected connections | `obsidian-cli` |

Other built-in skills: `meridian-system` (system introspection, self-modification), `qr-code` (QR code generation), `general-assistant` (fallback for unspecialized tasks).

Skills from `extraSkillsDirs` (e.g., OpenClaw) are also loaded and available to agents.

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
# Adjust port if running on non-default port
0 6 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Run daily research","executor":"claude-code","source":"cron"}'
0 9 * * * curl -s -X POST http://localhost:3333/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Generate daily brief","executor":"claude-code","source":"cron"}'
```

Cron task results are automatically routed to the configured Telegram chat.

## Skills

Skills are Markdown files with YAML frontmatter in `skills/<name>/SKILL.md`. The agent receives a catalog of all eligible skills and reads the relevant SKILL.md (OpenClaw-style LLM semantic matching — no keyword matching).

Meridian loads skills from two sources:
- `skillsDir` (default `./skills`) — Meridian-managed, highest precedence
- `extraSkillsDirs` — external skill trees (e.g., OpenClaw's `openclaw/skills`)

When skills declare `metadata.openclaw.requires` (bins, env, config), Meridian evaluates eligibility at load time. Ineligible skills are silently skipped — check `GET /api/skills` to see eligibility status.

## HTTP API

```bash
GET  /health              # Status + uptime (no auth)
GET  /api/state           # Full blackboard snapshot
GET  /api/skills          # Loaded skills with eligibility
POST /api/tasks           # Create task: {"prompt":"...", "executor":"claude-code"}
POST /api/notes           # Add a note: {"title":"...", "content":"..."}
GET  /api/notes           # List notes: ?limit=50&tag=...
POST /api/approve/:id     # Approve/reject: {"accept": true}
POST /api/skills/install  # Install skill: {"sourcePath":"/path/to/skill"}
WS   /                    # WebSocket for real-time state (A2UI dashboard)
```

If `apiToken` is set in config, `/api/*` endpoints require `Authorization: Bearer <token>`.

## A2UI Dashboard

Open `http://localhost:3333` in a browser for a real-time dashboard (single-file PWA). It shows running agents, task queue, feeds, and pending approvals. You can also send messages and approve/reject requests directly from the dashboard via WebSocket.

## Testing

```bash
npm run test:unit                              # All unit tests
npm run test:skills                            # Skill loading + executor tests
node --test tests/knowledge-skills.mjs         # Knowledge skill tests
node --test tests/knowledge-integration.mjs    # Integration tests
node --test tests/media-support.mjs            # Media attachment tests
```

## Roadmap

### Phase 1: Harden the Core *(in progress)*
- [x] Constitutional permission system (passthrough/constitutional/supervised)
- [x] Feishu channel with typing indicator
- [x] Instance-per-channel architecture (separate process + DB per channel)
- [x] Knowledge assistant skills (ingest, query, daily-brief, idea-generator)
- [x] Media attachment pipeline (photos, PDFs, documents via Telegram/Feishu)
- [x] OpenClaw-style LLM skill selection
- [ ] Token-aware context management (replace feed-count with token counting)
- [ ] Session management — persistent Claude Code sessions, warm agent pool

### Phase 2: MCP Client
- [ ] Implement MCP client so Meridian can call any MCP server as a tool
- [ ] Streamable HTTP transport (not legacy stdio/SSE)
- [ ] OpenClaw and NanoClaw tools become consumable through MCP

### Phase 3: Planner/Worker/Judge
- [ ] **Planner agent** — decomposes tasks into a DAG (extends existing `blockedBy` system)
- [ ] **Judge agent** — validates results before posting to blackboard (prevents sycophancy)
- [ ] Coordination skills: research synthesis, code review pipeline, competing hypotheses

### Phase 4: A2A Integration
- [ ] Publish `/.well-known/agent-card.json` (discoverable agents)
- [ ] A2A client for delegating to external agents
- [ ] OpenClaw agents, NanoClaw containers, any A2A agent become "workers"

### Phase 5: Toward ClawOS
- [ ] Universal integration engine (vibe-coding + browser automation + API)
- [ ] Proactive intelligence (pattern recognition, prediction, auto-research)
- [ ] Personal knowledge graph (cross-service connections, lifelong learning)
- [ ] Consumer polish (one-click setup, beautiful UI, works out of the box)

### Protocol Priority

| Protocol | Status | Action |
|----------|--------|--------|
| **MCP** | 97M+ downloads, Linux Foundation | **Now** |
| **A2A** | 150+ partners, Linux Foundation | **Within 6 months** |
| **AG-UI** | Adopted by MS, CopilotKit | Replace custom WebSocket |

## License

MIT
