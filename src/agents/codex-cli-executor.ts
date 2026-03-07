import { AgentExecutor, ExecuteParams, ExecuteResult } from './executor.js';
import { CodexRuntime } from './codex-runtime.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Executor that runs `codex exec` either as a local child process or through
 * an external host bridge, depending on configuration.
 */
export class CodexCliExecutor implements AgentExecutor {
  name = 'codex-cli';
  private runtime: CodexRuntime;

  constructor(
    private cliPath: string,
    private defaultWorkDir?: string,
  ) {
    this.runtime = new CodexRuntime({
      cliPath: this.cliPath,
      mode: config.codexExecutionMode,
      hostBridgeUrl: config.codexHostBridgeUrl,
      hostBridgeToken: config.codexHostBridgeToken,
      hostBridgeTimeoutMs: config.codexHostBridgeTimeoutMs,
    });
  }

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { task, prepared, signal, model: modelOverride, onProgress, requestApproval } = params;
    const workDir = this.defaultWorkDir || process.cwd();
    const prompt = prepared.toolPrompt;

    if (this.runtime.mode === 'host-bridge') {
      const approved = await requestApproval(
        `Run codex-cli via host native execution bridge in ${workDir} for task: ${task.prompt.slice(0, 200)}`,
      );
      if (!approved) {
        throw new Error('Host native codex execution was not approved');
      }
    }

    logger.info({
      cliPath: this.cliPath,
      workDir,
      promptLen: prompt.length,
      resume: task.sessionId || null,
      launchMode: this.runtime.mode,
    }, 'Running codex CLI');

    const result = await this.runtime.invoke({
      prompt,
      cwd: workDir,
      purpose: 'agent-task',
      model: modelOverride,
      sessionId: task.sessionId,
      signal,
      onProgress,
    });

    return {
      content: result.content,
      meta: {
        executor: 'codex-cli',
        sessionId: result.sessionId,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        launchMode: result.launchMode,
      },
    };
  }
}
