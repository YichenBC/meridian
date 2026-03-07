import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Reactive Blackboard E2E Test
 *
 * Verifies that the Runner reactively picks up tasks from the blackboard:
 * 1. Fast-path: task spawns immediately when no agents running
 * 2. Multi-spawn: sending 3 tasks rapidly fills all 3 slots
 * 3. Queueing: a 4th task while 3 running queues as pending
 * 4. Auto-drain: when an agent finishes, the queued task auto-spawns
 *
 * Requires: Meridian running with maxAgents=3 (default)
 */

const client = new MeridianTestClient();

function getNewTasks(taskIdsBefore) {
  return Array.from(client.tasks.values())
    .filter(t => !taskIdsBefore.has(t.id));
}

async function waitForTaskByPrompt(snippet, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = Array.from(client.tasks.values())
      .find(t => t.prompt.includes(snippet) && (t.status === 'completed' || t.status === 'failed' || t.status === 'running' || t.status === 'pending'));
    if (task) return task;
    await sleep(250);
  }
  return null;
}

try {
  await client.connect();
  log('=== Reactive Blackboard E2E Test ===');

  // ---------------------------------------------------------------
  // 1. Fast-path: send a task when idle → should spawn immediately
  // ---------------------------------------------------------------
  log('--- Test 1: Fast-path spawn when idle ---');
  const taskIdsBefore1 = new Set(client.tasks.keys());
  const feedsBefore1 = client.feeds.length;
  client.send('write a haiku about the ocean');

  const spawned1 = await client.waitForFeed('agent_spawned',
    f => client.feeds.indexOf(f) >= feedsBefore1, 15000);
  assert.ok(spawned1, 'Task should spawn immediately when idle');
  log(`Fast-path spawn confirmed: ${spawned1.content.slice(0, 80)}`);

  // Verify the Doorman response is an immediate ack, not a queued message
  const resp1 = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore1 && f.content.length > 0 && !/queued/i.test(f.content), 5000);
  assert.ok(resp1, 'Doorman should send an immediate non-queued ack for fast-path');
  log(`Doorman fast-path response: ${resp1.content.slice(0, 80)}`);

  // Wait for it to complete before next test
  log('Waiting for first task to complete...');
  const oceanTask = getNewTasks(taskIdsBefore1).find(t => t.prompt.includes('ocean'));
  assert.ok(oceanTask, 'Ocean task should exist');
  const oceanDone = await waitForTaskByPrompt('ocean', 120000);
  assert.ok(oceanDone && oceanDone.status === 'completed', 'Ocean task should complete');
  log('First task completed.');

  // Brief pause to let cleanup finish
  await sleep(1000);

  // ---------------------------------------------------------------
  // 2. Multi-spawn: send 3 tasks rapidly → all 3 should spawn
  // ---------------------------------------------------------------
  log('--- Test 2: Fill all 3 agent slots ---');

  // Track spawned count from this point
  const feedsBefore2 = client.feeds.length;
  const taskIdsBefore2 = new Set(client.tasks.keys());

  client.send('write a detailed 6-paragraph essay about mountains');
  await sleep(500);
  client.send('write a detailed 6-paragraph essay about rivers');
  await sleep(500);
  client.send('write a detailed 6-paragraph essay about forests');

  // Wait for 3 new agent_spawned events
  log('Waiting for 3 agents to spawn...');
  const waitForNSpawns = async (n, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const currentCount = client.feeds
        .filter((f, i) => i >= feedsBefore2 && f.type === 'agent_spawned').length;
      if (currentCount >= n) return currentCount;
      await sleep(500);
    }
    return client.feeds
      .filter((f, i) => i >= feedsBefore2 && f.type === 'agent_spawned').length;
  };

  const spawnCount = await waitForNSpawns(3, 30000);
  assert.ok(spawnCount >= 3, `Expected 3 spawns, got ${spawnCount}`);
  const phaseTwoTasks = getNewTasks(taskIdsBefore2);
  assert.ok(phaseTwoTasks.some(t => t.prompt.includes('mountains')), 'Mountains task should exist');
  assert.ok(phaseTwoTasks.some(t => t.prompt.includes('rivers')), 'Rivers task should exist');
  assert.ok(phaseTwoTasks.some(t => t.prompt.includes('forests')), 'Forests task should exist');
  log(`All 3 agent slots filled (${spawnCount} spawned).`);

  // ---------------------------------------------------------------
  // 3. Queueing: send a 4th task → should queue, not spawn
  // ---------------------------------------------------------------
  log('--- Test 3: 4th task queues when slots full ---');

  const feedsBefore3 = client.feeds.length;
  const taskIdsBefore3 = new Set(client.tasks.keys());

  client.send('write a detailed 6-paragraph essay about stars');

  // Expect an ack for the queued task
  const queueResp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore3, 10000);
  assert.ok(queueResp, 'Doorman should acknowledge the queued task');
  log(`Queue response confirmed: ${queueResp.content.slice(0, 80)}`);

  // Verify no immediate spawn for the 4th task (wait a couple seconds)
  await sleep(2000);
  const spawnsAfterQueue = client.feeds.filter((f, i) => i >= feedsBefore3 && f.type === 'agent_spawned').length;
  assert.equal(spawnsAfterQueue, 0,
    'No new spawn should happen while slots are full');
  log('Confirmed: 4th task queued, no immediate spawn.');

  // Verify task is visible as pending via state
  const pendingTasks = getNewTasks(taskIdsBefore3).filter(t => t.status === 'pending');
  assert.ok(pendingTasks.some(t => t.prompt.includes('stars')), 'Stars task should be pending on the board');
  log(`Pending tasks on board: ${pendingTasks.length}`);

  // ---------------------------------------------------------------
  // 4. Auto-drain: when a slot frees, the queued task auto-spawns
  // ---------------------------------------------------------------
  log('--- Test 4: Auto-drain picks up queued task ---');

  // Wait for one of the 3 running tasks to complete
  log('Waiting for one running task to complete (up to 2 min)...');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const completedPhaseTwo = phaseTwoTasks.find(t => client.tasks.get(t.id)?.status === 'completed');
    if (completedPhaseTwo) break;
    await sleep(500);
  }

  // The queued task should auto-spawn — wait for a new agent_spawned
  log('Waiting for queued task to auto-spawn...');
  const autoSpawned = await client.waitForFeed('agent_spawned',
    f => client.feeds.indexOf(f) >= feedsBefore3, 15000);
  assert.ok(autoSpawned, 'Queued task should auto-spawn when slot frees');
  log(`Auto-drain confirmed: ${autoSpawned.content.slice(0, 80)}`);

  // Verify the previously pending task is now running
  const starsTask = await waitForTaskByPrompt('stars', 15000);
  assert.ok(starsTask, 'Stars task should exist');
  assert.ok(starsTask.status === 'running' || starsTask.status === 'completed',
    `Stars task should be running or completed, got: ${starsTask.status}`);
  log(`Stars task status: ${starsTask.status}`);

  // Wait for all remaining tasks to finish (cleanup)
  log('Waiting for all tasks to complete...');
  const waitAllDone = async (timeout = 180000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const active = Array.from(client.tasks.values())
        .filter(t => t.status === 'pending' || t.status === 'running');
      if (active.length === 0) return true;
      await sleep(1000);
    }
    return false;
  };
  const allDone = await waitAllDone();
  assert.ok(allDone, 'All tasks should eventually complete');
  log('All tasks completed.');

  log('=== All reactive blackboard tests passed! ===');
  process.exit(0);
} catch (err) {
  log(`FAIL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
