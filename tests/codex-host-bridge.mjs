import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CodexRuntime } = await import('../dist/agents/codex-runtime.js');

describe('CodexRuntime host bridge', () => {
  it('posts codex execution requests to the configured host bridge', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        content: 'host bridge result',
        sessionId: 'sess-123',
        model: 'gpt-host',
        inputTokens: 11,
        outputTokens: 7,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const runtime = new CodexRuntime({
        cliPath: '/usr/local/bin/codex',
        mode: 'host-bridge',
        hostBridgeUrl: 'http://127.0.0.1:4318/v1/codex/exec',
        hostBridgeToken: 'bridge-token',
        hostBridgeTimeoutMs: 5000,
      });

      const result = await runtime.invoke({
        prompt: 'inspect the workspace',
        cwd: '/tmp/worktree',
        purpose: 'agent-task',
        model: 'gpt-5-codex',
        sessionId: 'thread-abc',
      });

      assert.equal(result.content, 'host bridge result');
      assert.equal(result.sessionId, 'sess-123');
      assert.equal(result.model, 'gpt-host');
      assert.equal(result.inputTokens, 11);
      assert.equal(result.outputTokens, 7);
      assert.equal(result.launchMode, 'host-bridge');

      assert.equal(calls.length, 1);
      const [{ url, init }] = calls;
      assert.equal(url, 'http://127.0.0.1:4318/v1/codex/exec');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer bridge-token');
      assert.deepEqual(JSON.parse(init.body), {
        executor: 'codex-cli',
        prompt: 'inspect the workspace',
        model: 'gpt-5-codex',
        sessionId: 'thread-abc',
        cwd: '/tmp/worktree',
        purpose: 'agent-task',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
