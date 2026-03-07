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
 *   - passthrough:    approve everything EXCEPT critical risk
 *   - constitutional: assess risk by consequence, escalate high+critical to user
 *   - supervised:     ask user for everything
 *
 * Risk levels:
 *   - low:      reversible, local — allow in passthrough + constitutional
 *   - high:     irreversible or external — allow in passthrough, ask in constitutional
 *   - critical: can crash the live system and cut off user communication — ask in ALL modes
 *
 * The mode is a function parameter — the caller (Runner) decides which mode
 * to use based on config, skill overrides, or runtime switching.
 */

export type AuditorMode = 'passthrough' | 'constitutional' | 'supervised';
export type PermissionDecision = 'allow' | 'ask';
export type RiskLevel = 'low' | 'high' | 'critical';

// Irreversible actions — cannot be undone
const IRREVERSIBLE = /\b(rm\s|rm\b|rmdir|delete|drop\s|truncate|reset\s--hard|force[\s-]push|--force|overwrite|destroy|wipe|purge)\b/i;

// External-facing actions — affect state beyond the local machine
const EXTERNAL = /\b(push|deploy|publish|release|send|post\s|tweet|email|message|notify|broadcast|merge\s|pr\screate|upload)\b/i;

// Host-native execution — crosses the Meridian sandbox boundary and depends
// on external desktop/daemon permissions, so it should be treated as high risk.
const HOST_NATIVE = /\b(host[-\s]?bridge|host[-\s]?native|native execution|unsandbox(?:ed)?|desktop app|terminal\.app|apple events?|launchservices|launchctl asuser)\b/i;

// Self-modification of critical system files — breakage can crash the live
// process and cut off all user communication channels. No mode should
// auto-approve this, because the consequence is unrecoverable without
// external intervention.
const CRITICAL_PATHS = /\b(src\/index\.ts|src\/channels\/|src\/blackboard\/|package\.json|package-lock\.json)\b/;

// Write-intent verbs — distinguish reading (safe) from modifying (risky)
const WRITE_INTENT = /\b(edit|write|modify|overwrite|create|replace|update|patch|change|rewrite|append|insert|remove|add|install)\b/i;

/**
 * Assess risk based on consequence, not action type.
 * Principle 1 (Proportionality): the two questions that matter.
 *
 * Critical risk is a special tier: the consequence is so severe (total
 * system death, loss of all communication channels) that no permission
 * mode should auto-approve it.
 */
export function assessRisk(description: string): RiskLevel {
  // Critical: writing to files that can crash the live system.
  // Reading these files is fine — only modifications are dangerous.
  if (CRITICAL_PATHS.test(description) && WRITE_INTENT.test(description)) return 'critical';
  if (HOST_NATIVE.test(description)) return 'high';
  if (IRREVERSIBLE.test(description)) return 'high';
  if (EXTERNAL.test(description)) return 'high';
  return 'low';
}

/**
 * Decide whether to allow an action or escalate to the user.
 * Pure function — no side effects, no state, no LLM calls.
 *
 * Critical risk always escalates — even in passthrough mode.
 * This is the self-modification safety net: an agent cannot silently
 * break the channels, blackboard, or entry point.
 */
export function decide(description: string, mode: AuditorMode): PermissionDecision {
  const risk = assessRisk(description);

  // Critical risk overrides all modes — always ask
  if (risk === 'critical') return 'ask';

  if (mode === 'passthrough') return 'allow';
  if (mode === 'supervised') return 'ask';

  // Constitutional mode: Principle 2 (Subsidiarity)
  // Agent handles low-risk; human handles high-risk
  return risk === 'low' ? 'allow' : 'ask';
}
