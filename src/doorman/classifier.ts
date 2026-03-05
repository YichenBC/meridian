import { Intent, Approval, AgentInfo, AgentRole } from '../types.js';
import { ModelProvider } from '../providers/types.js';
import { logger } from '../logger.js';

// --- Fast path patterns (avoid LLM call for obvious intents) ---

const CHAT_PATTERNS = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|great|good|yes|no|sure|got it|lol|haha|good (morning|afternoon|evening|night))\s*[.!?]*$/i;
const STATUS_PATTERNS = /^(.*\bstatus\b.*|what('s| is) (happening|going on)|show state|overview)\s*[.!?]*$/i;
const KILL_ALL_PATTERNS = /^(stop|cancel|kill|abort|quit)\s*(all|everything|agents?)?\s*[.!?]*$/i;
const APPROVAL_POSITIVE = /\b(approve|yes|accept|confirm|ok|okay|go ahead|do it)\b/i;
const APPROVAL_NEGATIVE = /\b(reject|no|deny|decline|don't|cancel)\b/i;

// Keyword-based role/executor detection for fallback when LLM classifier fails
const CLAUDE_CODE_KEYWORDS = /\b(claude.?code|spawn|instance|cli|launch.*(agent|code)|check.*(file|dir|code|db|database|blackboard|sqlite|system|log))\b/i;
const CODER_KEYWORDS = /\b(code|debug|fix|implement|refactor|build|compile|deploy|script|function|class|api|bug|error|test)\b/i;
const RESEARCHER_KEYWORDS = /\b(research|investigate|find out|look up|analyze|compare|deep.?dive|explore|study)\b/i;
const WRITER_KEYWORDS = /\b(write|draft|compose|essay|article|report|blog|poem|haiku|story|letter|doc|document)\b/i;
const SYSTEM_KEYWORDS = /\b(blackboard|database|sqlite|system.?check|self.?check|diagnos|inspect.*(system|state|db)|what('s| is) (in|on) the (board|blackboard|db|database))\b/i;

/**
 * Infer role and executor from message keywords.
 * Used as fallback when LLM classifier fails or returns empty.
 */
function inferFromKeywords(content: string): { role: AgentRole; executor?: string } {
  const lower = content.toLowerCase();

  // System introspection → always use claude-code (needs filesystem/DB access)
  if (SYSTEM_KEYWORDS.test(lower)) {
    return { role: 'coder', executor: 'claude-code' };
  }

  // Explicit claude-code request
  if (CLAUDE_CODE_KEYWORDS.test(lower)) {
    return { role: 'coder', executor: 'claude-code' };
  }

  if (CODER_KEYWORDS.test(lower)) return { role: 'coder' };
  if (RESEARCHER_KEYWORDS.test(lower)) return { role: 'researcher' };
  if (WRITER_KEYWORDS.test(lower)) return { role: 'writer' };

  return { role: 'general' };
}

/**
 * Fast path: classify obvious patterns without an LLM call.
 * Returns Intent[] if matched, null if LLM classification is needed.
 */
export function classifyFastPath(content: string, pendingApprovals: Approval[]): Intent[] | null {
  const trimmed = content.trim();

  // Approval responses when there are pending approvals
  if (pendingApprovals.length > 0 && trimmed.split(/\s+/).length <= 5) {
    if (APPROVAL_POSITIVE.test(trimmed)) {
      return [{ type: 'approval', approve: true, approvalId: pendingApprovals[0].id }];
    }
    if (APPROVAL_NEGATIVE.test(trimmed)) {
      return [{ type: 'approval', approve: false, approvalId: pendingApprovals[0].id }];
    }
  }

  // Kill all
  if (KILL_ALL_PATTERNS.test(trimmed)) {
    return [{ type: 'kill' }];
  }

  // Status
  if (STATUS_PATTERNS.test(trimmed)) {
    return [{ type: 'status' }];
  }

  // Simple chat (greetings, short phrases)
  if (CHAT_PATTERNS.test(trimmed) || trimmed.length < 10) {
    return [{ type: 'chat', content: trimmed }];
  }

  return null; // needs LLM classification
}

/**
 * LLM-based classifier. Sends the user message to the model with a structured
 * system prompt, returns Intent[] (supports multi-task messages).
 */
export async function classifyWithLLM(
  content: string,
  pendingApprovals: Approval[],
  runningAgents: AgentInfo[],
  provider: ModelProvider,
  model: string,
): Promise<Intent[]> {
  const agentContext = runningAgents.length > 0
    ? `\nCurrently running agents:\n${runningAgents.map(a => `- id="${a.id}" role=${a.role} task="${a.currentTaskId}"`).join('\n')}`
    : '\nNo agents currently running.';

  const approvalContext = pendingApprovals.length > 0
    ? `\nPending approvals:\n${pendingApprovals.map(a => `- id="${a.id}" desc="${a.description}"`).join('\n')}`
    : '';

  const systemPrompt = `You are an intent classifier for a multi-agent system called Meridian.
Given a user message, classify it into one or more intents. A single message may contain MULTIPLE tasks.

Return a JSON array of intent objects. Each intent is one of:
- {"type":"task","role":"<role>","prompt":"<the specific task description>","executor":"<optional>","continueFrom":"latest"}
  roles: "coder", "researcher", "writer", "general"
  executor (optional): "claude-code" when the user explicitly asks for claude code / CLI, otherwise omit
  continueFrom (optional): set to "latest" when the message is a follow-up to a previous task (e.g. "now add...", "also update...", "change the..." referring to earlier work)
- {"type":"chat","content":"<the message>"}  (greetings, casual conversation, simple questions)
- {"type":"status"}  (user wants system status)
- {"type":"kill","targetId":"<agent-id>"}  (stop a specific agent) or {"type":"kill"} (stop all)
- {"type":"approval","approve":true/false,"approvalId":"<id>"}  (approve/reject a pending action)

Rules:
- If the message contains multiple distinct tasks, return multiple task intents with appropriate roles.
- Extract the specific task description for each intent's "prompt" field — don't just copy the whole message.
- "coder" = coding, debugging, implementation, technical tasks. Also use for tasks that mention "claude code" or similar CLI tools.
- "researcher" = research, analysis, deep investigation, finding information.
- "writer" = writing, drafting, composing content.
- "general" = tasks that don't clearly fit the above roles.
- If the user wants to stop a specific agent, include targetId matching one of the running agent IDs.
- Only return "chat" for truly conversational messages, not task requests.
${agentContext}${approvalContext}

Respond with ONLY a JSON array. No markdown fences, no explanation.`;

  try {
    const result = await provider.sendMessage({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
      maxTokens: 256,
    });

    if (!result.content || result.content.trim().length === 0) {
      const inferred = inferFromKeywords(content);
      logger.warn({ inferred }, 'LLM classifier returned empty response, falling back to keyword inference');
      return [{ type: 'task', ...inferred, prompt: content.trim() }];
    }

    return enrichIntents(parseIntents(result.content, content), content);
  } catch (err) {
    const inferred = inferFromKeywords(content);
    logger.error({ err, inferred }, 'LLM classifier failed, falling back to keyword inference');
    return [{ type: 'task', ...inferred, prompt: content.trim() }];
  }
}

/**
 * Parse the LLM response into Intent[]. Handles markdown fences and malformed JSON.
 */
function parseIntents(raw: string, originalContent: string): Intent[] {
  let cleaned = raw.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];

    // Validate each intent has required fields
    const valid = arr.filter((intent: any) => {
      if (!intent || typeof intent !== 'object' || !intent.type) return false;
      switch (intent.type) {
        case 'task': return typeof intent.role === 'string' && typeof intent.prompt === 'string'
          && (!intent.executor || typeof intent.executor === 'string')
          && (!intent.continueFrom || typeof intent.continueFrom === 'string');
        case 'chat': return typeof intent.content === 'string';
        case 'status': return true;
        case 'kill': return true;
        case 'approval': return typeof intent.approve === 'boolean';
        default: return false;
      }
    }) as Intent[];

    if (valid.length === 0) {
      const inferred = inferFromKeywords(originalContent);
      logger.warn({ raw, inferred }, 'LLM classifier returned no valid intents, falling back to keyword inference');
      return [{ type: 'task', ...inferred, prompt: originalContent }];
    }

    return valid;
  } catch {
    const inferred = inferFromKeywords(originalContent);
    logger.warn({ raw, inferred }, 'LLM classifier returned invalid JSON, falling back to keyword inference');
    return [{ type: 'task', ...inferred, prompt: originalContent }];
  }
}

/**
 * Post-process intents from LLM classifier.
 * The LLM often omits executor even when the user explicitly mentions "claude code".
 * Enrich task intents with keyword-inferred executor/role when the LLM missed them.
 */
function enrichIntents(intents: Intent[], originalContent: string): Intent[] {
  const inferred = inferFromKeywords(originalContent);

  return intents.map(intent => {
    if (intent.type !== 'task') return intent;

    // If user mentioned claude-code keywords but LLM didn't set executor, inject it
    if (!intent.executor && inferred.executor) {
      return { ...intent, executor: inferred.executor };
    }

    return intent;
  });
}
