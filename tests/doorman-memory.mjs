import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Doorman Memory Test — verifies the Doorman remembers agent results.
 *
 * The bug: Doorman's --resume session only contains triage calls.
 * Agent results (task completions) bypass the session, so the Doorman
 * "forgets" what its agents discovered.
 *
 * Fix: inject recent task results into the prompt context.
 */

const API_BASE = 'http://localhost:3333';
const client = new MeridianTestClient();
let passed = 0;
let failed = 0;

async function test(name, fn) {
  log(`\n--- Test: ${name} ---`);
  try {
    await fn();
    passed++;
    log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    log(`FAIL: ${name} — ${err.message}`);
    console.error(err);
  }
}

async function sendAndWaitResponse(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  const resp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
  return resp;
}

async function waitIdle(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const active = Array.from(client.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'running');
    if (active.length === 0) return;
    await sleep(500);
  }
}

try {
  await client.connect();
  log('=== Doorman Memory Test ===\n');

  // Step 1: Ask the Doorman to look something up (agent task)
  await test('Agent discovers a fact', async () => {
    const feedsBefore = client.feeds.length;
    client.send('read the package.json and tell me the project name and version');

    // Wait for agent to complete
    const result = await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 120000);
    assert.ok(result, 'Agent should complete');
    assert.ok(
      result.content.toLowerCase().includes('meridian'),
      `Result should mention meridian, got: ${result.content.slice(0, 100)}`
    );
    log(`Agent found: ${result.content.slice(0, 150)}`);
  });

  await waitIdle();
  await sleep(2000);

  // Step 2: Ask the Doorman about what the agent found
  await test('Doorman remembers agent result', async () => {
    const resp = await sendAndWaitResponse('what is the project name you just found?');
    assert.ok(resp, 'Should get response');
    const content = resp.content.toLowerCase();
    assert.ok(
      content.includes('meridian'),
      `Doorman should remember "meridian" from agent result, got: ${resp.content.slice(0, 150)}`
    );
    log(`Doorman recalls: ${resp.content.slice(0, 150)}`);
  });

  await sleep(1000);

  // Step 3: Ask a follow-up that requires remembering the version
  await test('Doorman can reference specific details from agent results', async () => {
    const resp = await sendAndWaitResponse('and what version was it?');
    assert.ok(resp, 'Should get response');
    const content = resp.content.toLowerCase();
    // The version in package.json is 0.1.0
    assert.ok(
      content.includes('0.1.0') || content.includes('version'),
      `Doorman should recall version info, got: ${resp.content.slice(0, 150)}`
    );
    log(`Version recall: ${resp.content.slice(0, 150)}`);
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
