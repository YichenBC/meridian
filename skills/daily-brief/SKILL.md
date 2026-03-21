---
name: daily-brief
description: "Generate a morning briefing from tracked feeds and recent vault additions"
executor: claude-code
metadata: { "openclaw": { "requires": { "bins": ["obsidian-cli", "blogwatcher"] } } }
---

# Daily Brief

You generate a daily knowledge briefing for the user. This runs every morning to surface new information and connections.

## Pipeline

1. **Check tracked feeds**:
   - Run `blogwatcher scan` to check for new articles from tracked blogs/feeds
   - If new articles found, run `blogwatcher read-all` to get their content
   - Summarize each new article in 2-3 sentences

2. **Find recent vault additions**:
   - Run `find ~/Documents/openmao_vault -name "*.md" -mtime -1 -type f` to find notes modified in the last 24 hours
   - Read and summarize recent additions

3. **Generate connections**:
   - Cross-reference new articles with recent vault notes
   - Identify 3-5 interesting connections or emerging themes
   - Note any contradictions or complementary perspectives

4. **Write the daily brief** directly as a file:
   ```
   Write to ~/Documents/openmao_vault/05 Reviews/daily-briefs/YYYY-MM-DD.md
   ```

   Do NOT use `obsidian-cli create` — write the `.md` file directly.

   Brief format:
   ```markdown
   ---
   date: <YYYY-MM-DD>
   type: daily-brief
   ---

   # Daily Brief — <YYYY-MM-DD>

   ## New from Feeds
   - **<Article Title>** (<source>) — <2-3 sentence summary>
   - ...

   ## Recent Vault Additions
   - [[<Note Title>]] — <brief description>
   - ...

   ## Emerging Connections
   1. <Connection or theme linking multiple sources>
   2. ...

   ## Suggested Actions
   - [ ] <Something to read deeper>
   - [ ] <An idea to explore>
   - [ ] <A connection to investigate>
   ```

5. **Return the brief text** as the task result (this gets sent to the user via Telegram/Feishu).

## Active Research Threads (prioritize these when scoring relevance)

The user is actively working on **tool-call agent post-training**. When evaluating feeds, vault additions, and connections, prioritize content related to these threads (in rough priority order):

1. **Reward modeling for tool agents** — generative RM (CoT + score), execution-free verifiers, RM quality metrics (AUC, calibration), RM-R1/ToolRM/SWE-RM lineage
2. **GRPO variants & credit assignment** — turn-level rewards, GRPO-λ, RC-GRPO, per-token credit, vanishing advantage problem
3. **Self-distillation & privileged teacher** — OPSD, on-policy distillation, using execution results as privileged info
4. **Gradient conflict in multi-capability training** — DART, GRPO-MA, reasoning vs tool-use interference, disentangled LoRA
5. **Agent RL training infrastructure** — Agent-R1, Agent Lightning, RLFactory, VERL, training frameworks
6. **Process reward models** — AgentPRM, step-level feedback, online PRM learning
7. **Agentic coding / SWE agents** — SWE-bench, coding agent patterns, sandbox design

Secondary (track but don't prioritize):
- General LLM capabilities & new model releases
- Agent system architecture & orchestration patterns
- Prompt injection / agent security

### How to use these threads

- **In "New from Feeds"**: Flag articles touching any of the above threads and explain the connection. Skip or briefly note articles outside these areas.
- **In "Emerging Connections"**: Always try to connect new information back to the user's active research. E.g., "This new benchmark could be used to evaluate our RM" or "This method addresses the same credit assignment problem we identified in P1."
- **In "Suggested Actions"**: Prioritize actions that advance the research roadmap in [[tool-agent-training-improvement-analysis]] and [[agent-post-training-roadmap]].

## Guidelines

- Keep the brief concise — under 500 words
- Focus on what's new and what connects to the active research threads
- If no new feeds or notes, suggest a specific next step from [[tool-agent-training-improvement-analysis]] or an unread paper from [[reward-feedback-landscape-tool-agents]]
- Use `[[wikilinks]]` when referencing vault notes
- Date format: use today's date for the brief filename
- When nothing is new, don't pad — say "quiet day" and suggest one concrete thing to advance the research
