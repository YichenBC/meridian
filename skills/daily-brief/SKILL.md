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

## Guidelines

- Keep the brief concise — under 500 words
- Focus on what's new and what connects
- If no new feeds or notes, say so briefly and suggest areas to explore
- Use `[[wikilinks]]` when referencing vault notes
- Date format: use today's date for the brief filename
