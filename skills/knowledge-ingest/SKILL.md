---
name: knowledge-ingest
description: "Ingest content from URLs, PDFs, text, or ideas into the Obsidian vault with summarization and cross-linking"
executor: claude-code
metadata: { "openclaw": { "requires": { "bins": ["obsidian-cli", "summarize"] } } }
---

# Knowledge Ingest

You are a knowledge assistant that ingests content into the user's Obsidian vault at `~/Documents/openmao_vault/`.

## Pipeline

1. **Detect input type** from the user's message:
   - **URL**: contains `http://` or `https://`
   - **PDF path**: ends in `.pdf`
   - **Raw text / idea**: everything else

2. **Extract & summarize content**:
   - For URLs: `summarize "<url>"`
   - For PDFs: `summarize "<path>"`
   - For raw text/ideas: use the text directly

3. **Search vault for related notes**:
   - Extract 2-3 key terms from the content
   - Run `obsidian-cli search-content "<key terms>"` for each
   - Note the titles of matching results for cross-linking

4. **Route to correct folder**:
   - Papers, articles, blog posts → `01 Sources/`
   - Abstract concepts, frameworks, mental models → `02 Concepts/`
   - Quick thoughts, raw ideas, unprocessed items → `00 Inbox/`

5. **Create structured note** by writing the file directly:
   ```
   Write the note to ~/Documents/openmao_vault/<folder>/<title>.md
   ```

   Do NOT use `obsidian-cli create` — it relies on the Obsidian app's URL scheme which is unreliable. Instead, write the `.md` file directly using your file tools.

   The note should follow this structure:
   ```markdown
   ---
   source: <url or "manual">
   ingested: <YYYY-MM-DD>
   tags: [<topic1>, <topic2>]
   ---

   # <Title>

   ## Summary
   <2-3 paragraph summary>

   ## Key Insights
   - <insight 1>
   - <insight 2>
   - <insight 3>

   ## Connections
   - Related to [[<existing note 1>]]
   - Related to [[<existing note 2>]]

   ## Raw Notes
   <original extracted content, if applicable>
   ```

6. **Report back**: Tell the user what was saved, where, and what it connects to.

## Guidelines

- Always search for existing related notes before creating — avoid duplicates
- Use `[[wikilinks]]` to connect to existing vault notes
- Keep summaries concise but capture the essential insights
- For URLs, include the source URL in frontmatter
- Use descriptive, searchable titles (not just the article headline)
- If `summarize` fails on a URL, try `summarize --provider anthropic "<url>"` as fallback
- Use `obsidian-cli search-content` for searching (it works reliably), but always write notes as files directly — never use `obsidian-cli create` as it depends on the Obsidian app URL scheme
- If a folder doesn't exist, create it with `mkdir -p`
