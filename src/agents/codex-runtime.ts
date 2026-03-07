import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { CodexExecutionMode } from '../types.js';

interface CodexUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  session_id?: string;
  model?: string;
  usage?: CodexUsage;
  message?: string;
  item?: {
    type?: string;
    message?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: { message?: string };
}

interface HostBridgeResponse {
  content?: string;
  sessionId?: string;
  session_id?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

export interface CodexRuntimeOptions {
  cliPath: string;
  mode: CodexExecutionMode;
  hostBridgeUrl?: string;
  hostBridgeToken?: string;
  hostBridgeTimeoutMs: number;
}

export interface CodexInvocation {
  prompt: string;
  cwd: string;
  purpose: 'agent-task' | 'doorman';
  model?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface CodexInvocationResult {
  content: string;
  sessionId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  launchMode: CodexExecutionMode;
}

export class CodexRuntime {
  constructor(private options: CodexRuntimeOptions) {}

  get mode(): CodexExecutionMode {
    return this.options.mode;
  }

  async invoke(params: CodexInvocation): Promise<CodexInvocationResult> {
    if (this.options.mode === 'host-bridge') {
      return this.invokeViaHostBridge(params);
    }
    return this.invokeViaSubprocess(params);
  }

  private async invokeViaHostBridge(params: CodexInvocation): Promise<CodexInvocationResult> {
    if (!this.options.hostBridgeUrl) {
      throw new Error('codexExecutionMode=host-bridge but no codexHostBridgeUrl is configured');
    }

    params.onProgress?.('');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Host bridge request timed out')), this.options.hostBridgeTimeoutMs);
    timeout.unref();

    const forwardAbort = () => controller.abort(new Error('Aborted'));
    params.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.options.hostBridgeToken) {
        headers.authorization = `Bearer ${this.options.hostBridgeToken}`;
      }

      const response = await fetch(this.options.hostBridgeUrl, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          executor: 'codex-cli',
          prompt: params.prompt,
          model: params.model,
          sessionId: params.sessionId,
          cwd: params.cwd,
          purpose: params.purpose,
        }),
      });

      const payload = await this.readHostBridgePayload(response);
      if (!response.ok) {
        throw new Error(payload.error || `Host bridge returned HTTP ${response.status}`);
      }
      if (payload.error) {
        throw new Error(payload.error);
      }

      return {
        content: typeof payload.content === 'string' ? payload.content.trim() : '',
        sessionId: payload.sessionId || payload.session_id,
        model: payload.model,
        inputTokens: payload.inputTokens ?? payload.input_tokens,
        outputTokens: payload.outputTokens ?? payload.output_tokens,
        launchMode: 'host-bridge',
      };
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async readHostBridgePayload(response: Response): Promise<HostBridgeResponse> {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as HostBridgeResponse;
    } catch {
      return {
        content: response.ok ? text : undefined,
        error: response.ok ? undefined : text,
      };
    }
  }

  private invokeViaSubprocess(params: CodexInvocation): Promise<CodexInvocationResult> {
    const outputPath = path.join(os.tmpdir(), `meridian-codex-${crypto.randomUUID()}.txt`);
    const args = this.buildArgs(params.prompt, outputPath, params.model, params.sessionId);

    return new Promise<CodexInvocationResult>((resolve, reject) => {
      const child: ChildProcess = spawn(this.options.cliPath, args, {
        cwd: params.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let sessionId: string | undefined;
      let model: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let latestError: string | undefined;

      const handleTextChunk = (text: string, isStderr: boolean): void => {
        if (isStderr) {
          stderr += text;
          stderrBuffer += text;
        } else {
          stdout += text;
          stdoutBuffer += text;
        }

        const current = isStderr ? stderrBuffer : stdoutBuffer;
        const lines = current.split('\n');
        const remainder = lines.pop() || '';
        if (isStderr) {
          stderrBuffer = remainder;
        } else {
          stdoutBuffer = remainder;
        }

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = tryParseJsonEvent(trimmed);
          if (!event) {
            params.onProgress?.('');
            continue;
          }

          if (event.thread_id) sessionId = event.thread_id;
          if (event.session_id) sessionId = event.session_id;
          if (event.model) model = event.model;

          const usage = event.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
          }

          if (typeof event.message === 'string' && event.type === 'error') {
            latestError = event.message;
          }
          if (event.error?.message) {
            latestError = event.error.message;
          }

          params.onProgress?.('');
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        handleTextChunk(chunk.toString(), false);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        handleTextChunk(chunk.toString(), true);
      });

      child.on('error', (err) => {
        cleanupOutputFile(outputPath);
        reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        if (params.signal?.aborted) {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          return;
        }
        if (code !== 0) {
          const errMsg = latestError || stderr.trim() || stdout.trim() || `codex CLI exited with code ${code}`;
          reject(new Error(errMsg));
          return;
        }

        let content = '';
        try {
          if (fs.existsSync(outputPath)) {
            content = fs.readFileSync(outputPath, 'utf-8').trim();
          }
        } catch {
          // keep fallback below
        } finally {
          cleanupOutputFile(outputPath);
        }

        if (!content) {
          const merged = [stdout, stderr].filter(Boolean).join('\n');
          content = extractFallbackContent(merged) || merged.trim();
        }

        resolve({
          content,
          sessionId,
          model,
          inputTokens,
          outputTokens,
          launchMode: 'subprocess',
        });
      });

      if (params.signal?.aborted) {
        cleanupOutputFile(outputPath);
        child.kill('SIGTERM');
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }

      const onAbort = () => {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
        forceKill.unref();
      };

      params.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => {
        params.signal?.removeEventListener('abort', onAbort);
        cleanupOutputFile(outputPath);
      });
    });
  }

  private buildArgs(prompt: string, outputPath: string, model?: string, sessionId?: string): string[] {
    // Match claude-code executor semantics: no Codex sandbox, no interactive approvals.
    const common = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outputPath];
    if (model) {
      common.push('-m', model);
    }

    if (sessionId) {
      return ['exec', 'resume', ...common, sessionId, prompt];
    }
    return ['exec', ...common, prompt];
  }
}

function extractFallbackContent(stdout: string): string {
  const jsonLines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(tryParseJsonEvent)
    .filter((event): event is CodexEvent => !!event);

  for (let i = jsonLines.length - 1; i >= 0; i--) {
    const event = jsonLines[i];
    if (event.type === 'item.completed') {
      const fromItem = extractItemText(event.item);
      if (fromItem) return fromItem;
    }
    if (event.type === 'error') continue;
    if (typeof event.message === 'string' && event.message.trim().length > 0) {
      return event.message.trim();
    }
    if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      return event.item.text.trim();
    }
  }
  return '';
}

function extractItemText(item?: CodexEvent['item']): string {
  if (!item) return '';
  if (typeof item.message === 'string' && item.message.trim().length > 0) {
    return item.message.trim();
  }
  if (!Array.isArray(item.content)) return '';
  return item.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim();
}

function cleanupOutputFile(outputPath: string): void {
  if (!fs.existsSync(outputPath)) return;
  try {
    fs.unlinkSync(outputPath);
  } catch {
    // Best effort cleanup.
  }
}

function tryParseJsonEvent(text: string): CodexEvent | null {
  try {
    const parsed = JSON.parse(text) as CodexEvent;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
