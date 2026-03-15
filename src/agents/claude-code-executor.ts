import { spawn, ChildProcess } from 'child_process';
import { AgentExecutor, ExecuteParams, ExecuteResult } from './executor.js';
import { logger } from '../logger.js';

/**
 * Executor that spawns `claude` CLI as a child process.
 * Uses --print with JSON output to capture session_id for multi-turn.
 * Streams stdout as progress.
 */
export class ClaudeCodeExecutor implements AgentExecutor {
  name = 'claude-code';

  constructor(
    private cliPath: string,
    private defaultWorkDir?: string,
  ) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { task, prepared, signal, model: modelOverride, onProgress, onPid } = params;
    const prompt = prepared.toolPrompt;

    // Always use project root as cwd so .mcp.json (MCP servers) is picked up.
    // Skill context is passed via the prompt, not via cwd.
    const workDir = this.defaultWorkDir || process.cwd();
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    // Model override: per-task or per-skill model selection
    if (modelOverride) {
      args.push('--model', modelOverride);
    }

    // Resume from previous session if available
    if (task.sessionId) {
      args.push('--resume', task.sessionId);
    }

    args.push(prompt);

    logger.info({ cliPath: this.cliPath, workDir, promptLen: prompt.length, resume: task.sessionId || null }, 'Spawning claude CLI');

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child: ChildProcess = spawn(this.cliPath, args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: undefined },
      });

      // Report PID for process group kill support
      if (child.pid && onPid) {
        onPid(child.pid);
      }

      let stdout = '';
      let stderr = '';
      const streamMessages: any[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        // stream-json emits newline-delimited JSON messages.
        // Parse each line to extract incremental text for progress heartbeats.
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            streamMessages.push(msg);
            // Emit progress on assistant text deltas to keep heartbeat alive
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text) {
                  onProgress(block.text);
                }
              }
            } else {
              // Any valid message counts as activity
              onProgress('');
            }
          } catch {
            // Partial JSON line — will be completed in next chunk
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        // Stderr activity means the process is alive — emit heartbeat
        onProgress('');
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          return;
        }
        if (code !== 0) {
          const errMsg = stderr.trim() || `claude CLI exited with code ${code}`;
          reject(new Error(errMsg));
          return;
        }

        // Extract result from stream-json messages
        const parsed = this.parseStreamOutput(streamMessages, stdout);
        resolve(parsed);
      });

      // Handle abort signal
      if (signal.aborted) {
        child.kill('SIGTERM');
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }

      const onAbort = () => {
        logger.info({ pid: child.pid }, 'Aborting claude CLI process');
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
        forceKill.unref();
      };

      signal.addEventListener('abort', onAbort, { once: true });

      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private parseStreamOutput(messages: any[], rawStdout: string): ExecuteResult {
    // Extract final result message (type: 'result') from stream
    const resultMsg = messages.find(m => m.type === 'result');
    if (resultMsg) {
      const sessionId = resultMsg.session_id ?? resultMsg.sessionId ?? undefined;
      const content = resultMsg.result ?? resultMsg.content ?? '';
      return {
        content: typeof content === 'string' ? content : JSON.stringify(content),
        meta: {
          executor: 'claude-code',
          sessionId,
          inputTokens: resultMsg.input_tokens ?? resultMsg.usage?.input_tokens,
          outputTokens: resultMsg.output_tokens ?? resultMsg.usage?.output_tokens,
          model: resultMsg.model,
        },
      };
    }

    // Fallback: concatenate all assistant text blocks
    const textParts: string[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    for (const msg of messages) {
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.model) model = msg.model;
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
      }
    }

    if (textParts.length > 0) {
      return {
        content: textParts.join(''),
        meta: { executor: 'claude-code', sessionId, model },
      };
    }

    // Last resort: try parsing raw stdout as single JSON (backwards compat)
    try {
      const json = JSON.parse(rawStdout.trim());
      const result = json.result ?? json.content ?? rawStdout.trim();
      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        meta: {
          executor: 'claude-code',
          sessionId: json.session_id ?? json.sessionId,
          model: json.model,
        },
      };
    } catch {
      logger.warn('Failed to parse claude CLI output, using raw text');
      return {
        content: rawStdout.trim(),
        meta: { executor: 'claude-code' },
      };
    }
  }
}
