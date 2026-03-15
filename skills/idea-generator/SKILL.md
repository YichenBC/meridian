---
name: idea-generator
description: "Cross-reference vault knowledge to discover unexpected connections and generate new ideas"
executor: claude-code
metadata: { "openclaw": { "requires": { "bins": ["obsidian-cli"] } } }
---

# Idea Generator

You cross-reference the user's Obsidian vault at `~/Documents/openmao_vault/` to find unexpected connections and generate new ideas.

## Pipeline

1. **Sample the vault**:
   - Run `obsidian-cli search-content "<topic>"` across 3-5 different topic areas
   - Pick topics from different vault folders to maximize cross-pollination:
     - `01 Sources/` — external knowledge
     - `02 Concepts/` — frameworks and mental models
     - `03 Projects/` — active work
   - If the user specified a focus area, weight searches toward that topic

2. **Read diverse notes**:
   - Select 5-8 notes from different areas
   - Read their full content to understand the details

3. **Find unexpected connections**:
   - Look for patterns that span different domains
   - Identify concepts from one area that could apply to another
   - Note contradictions between different sources
   - Find gaps — areas where the vault has depth in related topics but nothing on the connecting idea

4. **Generate ideas**:
   - Produce 3-5 concrete, actionable ideas
   - Each idea should reference at least 2 vault notes from different areas
   - Rate each idea's novelty (how unexpected the connection is)
   - Suggest next steps for the most promising ideas

5. **Optionally store insights**:
   - If an idea is particularly strong, write it directly as a file:
     ```
     Write to ~/Documents/openmao_vault/07 Connections/<descriptive-title>.md
     ```
   - Do NOT use `obsidian-cli create` — write the `.md` file directly.

6. **Return ideas** as the task result.

## Output Format

```markdown
## Idea 1: <Title>
**Connecting:** [[Note A]] + [[Note B]]
**Insight:** <1-2 paragraphs explaining the connection and why it matters>
**Next step:** <Concrete action to explore this further>

## Idea 2: <Title>
...
```

## Guidelines

- Prioritize surprising connections over obvious ones
- Each idea should be actionable, not just an observation
- Reference specific vault notes with `[[wikilinks]]`
- If the user asks for ideas on a specific topic, focus there but still cross-reference broadly
- Don't force connections — if there aren't enough notes to generate meaningful ideas, suggest what to ingest first
