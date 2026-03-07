import { Task, Skill, Note } from '../types.js';

export interface BlackboardContext {
  /** Results from blocker tasks (DAG predecessors) */
  blockerResults?: { id: string; prompt: string; result: string }[];
  /** Notes addressed to or relevant to this task */
  relevantNotes?: Note[];
}

export interface PreparedTaskContext {
  systemPrompt: string;
  userPrompt: string;
  toolPrompt: string;
  skillName: string | null;
  skillSourceDir: string | null;
}

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

  return parts.join('\n');
}
