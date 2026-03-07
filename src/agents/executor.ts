import { Task } from '../types.js';
import { ModelProvider } from '../providers/types.js';
import { PreparedTaskContext } from '../skills/context.js';

export interface ExecuteParams {
  task: Task;
  prepared: PreparedTaskContext;
  signal: AbortSignal;
  model?: string;          // model override (from task.model or skill.model)
  onProgress: (text: string) => void;
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
    const result = await this.provider.streamMessage({
      model: effectiveModel,
      system: prepared.systemPrompt,
      messages: [{ role: 'user', content: prepared.userPrompt }],
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
