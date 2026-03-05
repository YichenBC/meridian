import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

const client = new MeridianTestClient();

try {
  await client.connect();
  log('=== Deepresearch E2E Test ===');

  // 1. Send deepresearch task
  client.send('use claude code to deepresearch agentic-posttraining');

  // 2. Assert agent_spawned within 15s
  log('Waiting for agent_spawned...');
  const spawned = await client.waitForFeed('agent_spawned', null, 15000);
  assert.ok(spawned, 'Should receive agent_spawned event');
  assert.ok(spawned.content.length > 0, 'agent_spawned should have content');
  log(`Agent spawned: ${spawned.content.slice(0, 80)}`);

  // 3. At ~8s ask about progress
  await sleep(8000);
  client.send('what is the progress?');
  log('Waiting for doorman_response to progress query...');
  const progressResp = await client.waitForFeed('doorman_response', null, 15000);
  assert.ok(progressResp, 'Should receive doorman_response');
  assert.ok(progressResp.content.length > 0, 'Progress response should be non-empty');
  log(`Progress response: ${progressResp.content.slice(0, 100)}`);

  // 4. At ~20s ask how it's going (contextual)
  await sleep(12000);
  client.send('how is it going?');
  log('Waiting for contextual response...');
  const contextResp = await client.waitForFeed('doorman_response',
    f => f.content !== progressResp.content, 15000);
  assert.ok(contextResp, 'Should receive contextual response');
  assert.ok(contextResp.content.length > 0, 'Contextual response should be non-empty');
  log(`Contextual response: ${contextResp.content.slice(0, 100)}`);

  // 5. At ~30s send "status"
  await sleep(10000);
  client.send('status');
  log('Waiting for status response...');
  const statusResp = await client.waitForFeed('doorman_response',
    f => f.content !== contextResp.content && f.content !== progressResp.content, 15000);
  assert.ok(statusResp, 'Should receive status response');
  assert.ok(statusResp.content.includes('agent') || statusResp.content.includes('Agent') || statusResp.content.includes('running'),
    'Status should mention running agent');
  log(`Status response: ${statusResp.content.slice(0, 120)}`);

  // 6. Wait for agent_result (up to 10 min)
  log('Waiting for agent_result (up to 10 min)...');
  const result = await client.waitForFeed('agent_result', null, 600000);
  assert.ok(result, 'Should receive agent_result');
  assert.ok(result.content.length > 100, 'Result should be substantial (>100 chars)');
  log(`Agent result received: ${result.content.length} chars`);

  log('=== All deepresearch tests passed! ===');
  process.exit(0);
} catch (err) {
  log(`FAIL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
