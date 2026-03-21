import { Task, Skill, Note } from '../types.js';

export interface BlackboardContext {
  /** Results from blocker tasks (DAG predecessors) */
  blockerResults?: { id: string; prompt: string; result: string }[];
  /** Notes addressed to or relevant to this task */
  relevantNotes?: Note[];
  /** Session memory from a reused session (domain expertise + task history) */
  sessionMemory?: string;
  /** Domain-specific system prompt (e.g., knowledge assistant spec) */
  domainSystemPrompt?: string;
  /** Work experience notes scoped to this agent's context (skill-specific + global) */
  experienceNotes?: Note[];
}

export interface PreparedTaskContext {
  systemPrompt: string;
  userPrompt: string;
  toolPrompt: string;
  skillName: string | null;
  skillSourceDir: string | null;
}

/**
 * Build a skills catalog XML block for LLM-based skill selection.
 * Following the OpenClaw pattern: inject name + description + location,
 * let the agent decide which skill applies and read its SKILL.md.
 */
function buildSkillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const entries = skills.map(s =>
    `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.sourceDir}/SKILL.md</location>\n  </skill>`
  ).join('\n');

  return `<available_skills>\n${entries}\n</available_skills>`;
}

/**
 * Prepare task context with a single pre-selected skill (legacy path).
 * Used when a specific skill is already determined (e.g., by explicit request).
 */
export function prepareTaskContext(task: Task, skill: Skill | null, bbContext?: BlackboardContext): PreparedTaskContext {
  const userPrompt = task.prompt;
  const contextSection = buildBlackboardContext(bbContext);

  if (!skill) {
    return {
      systemPrompt: buildBaseSystemPrompt(task.role),
      userPrompt,
      toolPrompt: contextSection ? `${userPrompt}\n\n${contextSection}` : userPrompt,
      skillName: null,
      skillSourceDir: null,
    };
  }

  return {
    systemPrompt: `${buildBaseSystemPrompt(task.role)}\n\n## Skill: ${skill.name}\nLocation: ${skill.baseDir}\n\n${skill.content}`,
    userPrompt,
    toolPrompt: `You have an installed skill available for this task.

Skill name: ${skill.name}
Skill directory: ${skill.baseDir}

Follow the skill instructions below when they apply. Use files and resources from the skill directory if referenced.

## Skill Instructions
${skill.content}

## Task
${userPrompt}${contextSection ? `\n\n${contextSection}` : ''}`,
    skillName: skill.name,
    skillSourceDir: skill.sourceDir,
  };
}

/**
 * Prepare task context with LLM-based skill selection (OpenClaw pattern).
 * Injects all eligible skills as a catalog; the agent reads the relevant SKILL.md.
 */
export function prepareTaskContextWithCatalog(task: Task, skills: Skill[], bbContext?: BlackboardContext): PreparedTaskContext {
  const userPrompt = task.prompt;
  const contextSection = buildBlackboardContext(bbContext);
  const catalog = buildSkillsCatalog(skills);

  // Domain system prompt takes precedence over generic base prompt
  const basePrompt = bbContext?.domainSystemPrompt || buildBaseSystemPrompt(task.role);

  const skillSelectionInstructions = catalog ? `
## Available Skills

Before starting work, scan the skill descriptions below.
- If exactly one skill clearly applies to this task: read its SKILL.md file at the given location, then follow its instructions.
- If multiple skills could apply: choose the most specific one, read its SKILL.md, then follow it.
- If none clearly apply: proceed without a skill — complete the task using your own judgment.
- Never read more than one SKILL.md up front.

${catalog}
` : '';

  return {
    systemPrompt: `${basePrompt}${skillSelectionInstructions}`,
    userPrompt,
    toolPrompt: `${skillSelectionInstructions}
## Task
${userPrompt}${contextSection ? `\n\n${contextSection}` : ''}`,
    skillName: null,
    skillSourceDir: null,
  };
}

function buildBaseSystemPrompt(role: string): string {
  return `You are a ${role} agent. Complete the following task thoroughly and return a clear, concise result.
You are a pure text agent - you have NO tools, NO file access, NO shell, NO internet. Do NOT output tool calls, XML tags, or code blocks pretending to run commands. Just provide your best answer using your knowledge.`;
}

function buildBlackboardContext(ctx?: BlackboardContext): string {
  if (!ctx) return '';
  const parts: string[] = [];

  if (ctx.blockerResults && ctx.blockerResults.length > 0) {
    parts.push('## Predecessor Task Results (from completed dependencies)\n');
    for (const b of ctx.blockerResults) {
      const truncated = b.result.length > 1000 ? b.result.slice(0, 1000) + '...' : b.result;
      parts.push(`### ${b.prompt.slice(0, 100)}\n${truncated}\n`);
    }
  }

  if (ctx.relevantNotes && ctx.relevantNotes.length > 0) {
    parts.push('## Blackboard Notes\n');
    for (const n of ctx.relevantNotes) {
      parts.push(`- **${n.title}** (${n.source}): ${n.content.slice(0, 500)}`);
    }
  }

  if (ctx.experienceNotes && ctx.experienceNotes.length > 0) {
    parts.push('## Work Experience (standing instructions — follow unless task explicitly overrides)\n');
    let charCount = 0;
    for (const n of ctx.experienceNotes) {
      const line = `- **${n.title}**: ${n.content.slice(0, 300)}`;
      charCount += line.length;
      if (charCount > 3000) { parts.push('- *(additional experience notes truncated)*'); break; }
      parts.push(line);
    }
  }

  if (ctx.sessionMemory) {
    parts.push('## Session Memory (from previous tasks in this domain)\n');
    // Cap at 2000 chars to avoid bloating the context window
    const truncated = ctx.sessionMemory.length > 2000
      ? ctx.sessionMemory.slice(0, 2000) + '\n...(truncated)'
      : ctx.sessionMemory;
    parts.push(truncated);
  }

  return parts.join('\n');
}
