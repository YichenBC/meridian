---
name: memory
description: "Persist, retrieve, update, and delete user preferences, corrections, and work experience for Meridian"
executor: claude-code
---

# Memory — Work Experience Management

You manage Meridian's persistent work experience. This system lets the user save preferences, corrections, and workflow rules that Meridian will follow in future tasks.

## Experience Scopes

Experience is stored as blackboard notes with specific tag prefixes:

| Scope | Tag | Who reads it | Examples |
|-------|-----|-------------|----------|
| **Orchestration** | `exp:orchestration` | Doorman (task routing/triage) | "URLs should use knowledge-ingest", "deep research = vault-first" |
| **Skill-specific** | `exp:skill:<name>` | Agents working with that skill | "knowledge-ingest: always cross-link to active projects" |
| **Global** | `exp:global` | All agents | "ask before assuming when preference is unclear" |

## Operations

### Save Experience

When the user says "remember this", "记住", or provides feedback worth preserving:

1. Determine the scope (orchestration / skill / global) from context
2. Write a concise title (the rule itself) and content (why + when to apply)
3. Check for duplicates: `GET http://localhost:${PORT}/api/notes?tag=exp:` — scan titles for overlap
4. If updating, delete the old note first: `DELETE http://localhost:${PORT}/api/notes/{id}`
5. Create the note: `POST http://localhost:${PORT}/api/notes` with body:

```json
{
  "title": "Rule: always use knowledge-ingest for URLs",
  "content": "When user sends a URL for ingestion, route through knowledge-ingest skill. Why: ensures consistent vault formatting, cross-linking, and metadata. When to apply: any task involving URL content processing.",
  "source": "user",
  "tags": "exp:orchestration"
}
```

The PORT is the Meridian instance port. Check the environment or default to 3333.

### List Experience

When the user says "list memories", "show preferences", "what do you remember":

1. Fetch all: `GET http://localhost:${PORT}/api/notes?tag=exp:`
2. Group by scope (orchestration / skill / global)
3. Format as a readable list with scope labels

### Forget Experience

When the user says "forget X", "delete that preference", "忘记":

1. Search notes by tag `exp:` and match title/content
2. Confirm with user which note to delete (if ambiguous)
3. Delete: `DELETE http://localhost:${PORT}/api/notes/{id}`
4. Confirm deletion

### Update Experience

Delete-then-create. Find the old note, delete it, create updated version.

## Writing Guidelines

- **Title = the rule**: "Always use knowledge-ingest for URLs" not "URL handling preference"
- **Content = why + when**: Include the reason (prevents future misapplication) and scope of applicability
- **Be concise**: One rule per note. Split compound preferences into separate notes.
- **Choose scope carefully**:
  - If it's about *which task/skill to use* → `exp:orchestration`
  - If it's about *how a specific skill should behave* → `exp:skill:<skill-name>`
  - If it applies to *all work regardless of skill* → `exp:global`
- **Avoid noise**: Don't save ephemeral task details. Only save reusable patterns.

## Quick Response

After saving, respond in one sentence: "Saved: [title] (scope: [scope])."
Do not explain how the memory system works unless asked.
