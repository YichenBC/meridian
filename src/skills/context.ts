import { Task, Skill } from '../types.js';

export interface PreparedTaskContext {
  systemPrompt: string;
  userPrompt: string;
  toolPrompt: string;
  skillName: string | null;
  skillSourceDir: string | null;
}

export function prepareTaskContext(task: Task, skill: Skill | null): PreparedTaskContext {
  const userPrompt = task.prompt;

  if (!skill) {
    return {
      systemPrompt: buildBaseSystemPrompt(task.role),
      userPrompt,
      toolPrompt: userPrompt,
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
${userPrompt}`,
    skillName: skill.name,
    skillSourceDir: skill.sourceDir,
  };
}

function buildBaseSystemPrompt(role: string): string {
  return `You are a ${role} agent. Complete the following task thoroughly and return a clear, concise result.
You are a pure text agent - you have NO tools, NO file access, NO shell, NO internet. Do NOT output tool calls, XML tags, or code blocks pretending to run commands. Just provide your best answer using your knowledge.`;
}
