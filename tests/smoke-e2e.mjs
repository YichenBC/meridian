import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

const API_BASE = process.env.MERIDIAN_URL || 'http://localhost:3333';
const WS_URL = API_BASE.replace(/^http/, 'ws') + '/ws';
const client = new MeridianTestClient(WS_URL);
const { toolExecutor } = getRuntimeConfig();

async function waitForTask(taskId, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = client.tasks.get(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) return task;
    await sleep(500);
  }
  return null;
}

try {
  await client.connect();
  log('=== Meridian Smoke E2E ===');

  const helloFeedsBefore = client.feeds.length;
  client.send('hello');
  const hello = await client.waitForFeed(
    'doorman_response',
    (f) => client.feeds.indexOf(f) >= helloFeedsBefore,
    30000,
  );
  assert.ok(hello?.content?.length > 0, 'Greeting should return a response');
  log(`Greeting: ${hello.content.slice(0, 80)}`);

  const taskIdsBefore = new Set(client.tasks.keys());
  const taskFeedsBefore = client.feeds.length;
  client.send('list the files in the current directory');

  const ack = await client.waitForFeed(
    'doorman_response',
    (f) => client.feeds.indexOf(f) >= taskFeedsBefore,
    30000,
  );
  assert.ok(ack?.content?.length > 0, 'Task request should be acknowledged');
  log(`Ack: ${ack.content.slice(0, 80)}`);

  const task = Array.from(client.tasks.values())
    .find((t) => !taskIdsBefore.has(t.id) && t.executor === toolExecutor);
  assert.ok(task, `Expected a ${toolExecutor} task to be created`);

  const completed = await waitForTask(task.id, 180000);
  assert.ok(completed, 'Task should finish');
  assert.equal(completed.status, 'completed', `Task should complete successfully, got ${completed?.status}`);
  assert.ok((completed.result || '').length > 0, 'Completed task should have a result');
  log(`Task result: ${(completed.result || '').slice(0, 120)}`);

  log('=== Smoke test passed ===');
  process.exit(0);
} catch (err) {
  log(`FAIL: ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
