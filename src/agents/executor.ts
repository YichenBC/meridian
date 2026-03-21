import { readFileSync } from 'fs';
import { Task } from '../types.js';
import { ModelProvider, ContentBlock } from '../providers/types.js';
import { PreparedTaskContext } from '../skills/context.js';

export interface ExecuteParams {
  task: Task;
  prepared: PreparedTaskContext;
  signal: AbortSignal;
  model?: string;          // model override (from task.model or skill.model)
  onProgress: (text: string) => void;
  onPid?: (pid: number) => void;  // report child process PID for kill support
  requestApproval: (description: string) => Promise<boolean>;
}

export interface ExecuteResult {
  content: string;
  meta?: Record<string, unknown>;
}

/**
 * Unified interface for agent execution.
 * Inputs are diverse (different tasks, skills, scenarios),
 * but the interface is the same. Separation of interface and implementation.
 */
export interface AgentExecutor {
  name: string;
  execute(params: ExecuteParams): Promise<ExecuteResult>;
}

/**
 * LLM-based executor — calls any ModelProvider (MiniMax, OpenAI, Anthropic, etc.)
 */
export class LLMExecutor implements AgentExecutor {
  name = 'llm';

  constructor(
    private provider: ModelProvider,
    private model: string,
  ) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { prepared, signal, model: modelOverride, onProgress } = params;

    const effectiveModel = modelOverride || this.model;
    const content = buildUserContent(prepared.userPrompt);
    const result = await this.provider.streamMessage({
      model: effectiveModel,
      system: prepared.systemPrompt,
      messages: [{ role: 'user', content }],
      maxTokens: 8192,
      signal,
      onText: (chunk) => {
        if (chunk.length > 0) onProgress(chunk);
      },
    });

    return {
      content: cleanLLMOutput(result.content || ''),
      meta: {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  }
}

/**
 * Extract image paths from the prompt and build multimodal content blocks.
 * Matches the format: [media attached: "/path/to/file" (image/...)]
 * or [media attached: /path/to/file (image/...)]
 */
// Matches: [media attached: /path (type)] or [media attached: "name" /path (type)]
// Also:    [media 1/2: /path (type)] or [media 1/2: "name" /path (type)]
const MEDIA_RE = /\[media(?:\s+attached|\s+\d+\/\d+):(?:\s+"[^"]*")?\s+(\/[^\s(]+)\s+\(([^)]+)\)\]/g;

function buildUserContent(prompt: string): string | ContentBlock[] {
  const images: ContentBlock[] = [];
  let textPrompt = prompt;

  for (const match of prompt.matchAll(MEDIA_RE)) {
    const filePath = match[1];
    const mimeType = match[2];

    if (!mimeType.startsWith('image/')) continue;

    try {
      const data = readFileSync(filePath).toString('base64');
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data },
      });
      textPrompt = textPrompt.replace(match[0], '').trim();
    } catch {
      // File not found — leave the text reference in the prompt
    }
  }

  if (images.length === 0) return prompt;

  // Also remove the multi-file header line if present
  textPrompt = textPrompt.replace(/\[media attached: \d+ files\]\s*/g, '').trim();

  const blocks: ContentBlock[] = [];
  blocks.push(...images);
  if (textPrompt) {
    blocks.push({ type: 'text', text: textPrompt });
  }
  return blocks;
}

/**
 * Strip hallucinated tool calls and internal artifacts from LLM output.
 * Some models (e.g. MiniMax) generate fake XML tool calls they can't execute.
 */
function cleanLLMOutput(text: string): string {
  return text
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/g, '')
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .trim();
}
