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
    const { task, skill, signal, onProgress } = params;

    // Always use project root as cwd so .mcp.json (MCP servers) is picked up.
    // Skill context is passed via the prompt, not via cwd.
    const workDir = this.defaultWorkDir || process.cwd();
    const args = [
      '--print',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    // Resume from previous session if available
    if (task.sessionId) {
      args.push('--resume', task.sessionId);
    }

    args.push(task.prompt);

    logger.info({ cliPath: this.cliPath, workDir, promptLen: task.prompt.length, resume: task.sessionId || null }, 'Spawning claude CLI');

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child: ChildProcess = spawn(this.cliPath, args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: undefined },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onProgress(text);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
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

        // Parse JSON response for session_id and result
        const parsed = this.parseJsonOutput(stdout);
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

  private parseJsonOutput(raw: string): ExecuteResult {
    try {
      const json = JSON.parse(raw.trim());
      const result = json.result ?? json.content ?? raw.trim();
      const sessionId = json.session_id ?? json.sessionId ?? undefined;
      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        meta: {
          executor: 'claude-code',
          sessionId,
          inputTokens: json.input_tokens ?? json.usage?.input_tokens,
          outputTokens: json.output_tokens ?? json.usage?.output_tokens,
          model: json.model,
        },
      };
    } catch {
      // Fallback: treat entire output as text result
      logger.warn('Failed to parse claude CLI JSON output, using raw text');
      return {
        content: raw.trim(),
        meta: { executor: 'claude-code' },
      };
    }
  }
}
