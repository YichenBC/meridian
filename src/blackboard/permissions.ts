/**
 * Constitutional Permission System for Meridian
 *
 * Philosophy (inspired by Anthropic's Constitutional AI + cross-disciplinary governance):
 *
 *   1. Proportionality — oversight matches consequence, not action type.
 *      Two questions: Is it reversible? Is it local?
 *      (From medical ethics: risk-proportional consent; military ROE: escalation ladder)
 *
 *   2. Subsidiarity — decide at the lowest competent level.
 *      The agent handles what it can; humans are consulted only when
 *      the agent genuinely cannot assess the risk.
 *      (From Catholic social teaching / political philosophy)
 *
 *   3. Trust but verify — the default is trust (the user launched the agent).
 *      Every action is logged on the blackboard. Permission is not the only
 *      safety mechanism; observability is.
 *      (From diplomatic governance; permaculture: feedback loops)
 *
 * Three modes:
 *   - passthrough:    approve everything (dev mode, current default)
 *   - constitutional: assess risk by consequence, escalate high-risk to user
 *   - supervised:     ask user for everything
 *
 * The mode is a function parameter — the caller (Runner) decides which mode
 * to use based on config, skill overrides, or runtime switching.
 */

export type AuditorMode = 'passthrough' | 'constitutional' | 'supervised';
export type PermissionDecision = 'allow' | 'ask';
export type RiskLevel = 'low' | 'high';

// Irreversible actions — cannot be undone
const IRREVERSIBLE = /\b(rm\s|rm\b|rmdir|delete|drop\s|truncate|reset\s--hard|force[\s-]push|--force|overwrite|destroy|wipe|purge)\b/i;

// External-facing actions — affect state beyond the local machine
const EXTERNAL = /\b(push|deploy|publish|release|send|post\s|tweet|email|message|notify|broadcast|merge\s|pr\screate|upload)\b/i;

/**
 * Assess risk based on consequence, not action type.
 * Principle 1 (Proportionality): the two questions that matter.
 */
export function assessRisk(description: string): RiskLevel {
  if (IRREVERSIBLE.test(description)) return 'high';
  if (EXTERNAL.test(description)) return 'high';
  return 'low';
}

/**
 * Decide whether to allow an action or escalate to the user.
 * Pure function — no side effects, no state, no LLM calls.
 */
export function decide(description: string, mode: AuditorMode): PermissionDecision {
  if (mode === 'passthrough') return 'allow';
  if (mode === 'supervised') return 'ask';

  // Constitutional mode: Principle 2 (Subsidiarity)
  // Agent handles low-risk; human handles high-risk
  return assessRisk(description) === 'low' ? 'allow' : 'ask';
}
