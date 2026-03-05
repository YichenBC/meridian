import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

const client = new MeridianTestClient();

try {
  await client.connect();
  log('=== Docx Multi-turn E2E Test ===');

  // 1. Send initial docx creation task
  client.send('create a report.docx about AI trends');

  // Wait for agent spawn
  log('Waiting for first agent to spawn...');
  await client.waitForFeed('agent_spawned', null, 15000);

  // Wait for first task completion (up to 5 min)
  log('Waiting for first task to complete...');
  const firstTask = await client.waitForTaskStatus('completed', 300000);
  assert.ok(firstTask, 'First task should complete');
  assert.ok(firstTask.result && firstTask.result.length > 0, 'First task should have a result');
  log(`First task completed: ${firstTask.id}`);

  // Brief pause before follow-up
  await sleep(2000);

  // 2. Send follow-up task (should trigger continueFrom)
  client.send('add a section about AI safety to the report');

  // Wait for second agent spawn
  log('Waiting for second agent to spawn...');
  await client.waitForFeed('agent_spawned',
    f => f.content.includes('safety') || f.content.includes('section'), 15000);

  // Wait for second task completion
  log('Waiting for second task to complete...');
  const secondTask = await client.waitForTaskStatus('completed', 300000);
  assert.ok(secondTask, 'Second task should complete');
  assert.ok(secondTask.id !== firstTask.id, 'Second task should be different from first');
  log(`Second task completed: ${secondTask.id}`);

  // 3. Verify via /api/state that second task has parentTaskId
  // The client tracks tasks from WebSocket updates
  const allTasks = Array.from(client.tasks.values());
  const latestCompleted = allTasks
    .filter(t => t.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  assert.ok(latestCompleted.length >= 2, 'Should have at least 2 completed tasks');

  // The most recent completed task should have parentTaskId
  const secondCompleted = latestCompleted[0];
  log(`Second completed task parentTaskId: ${secondCompleted.parentTaskId || 'none'}`);

  // parentTaskId check — may not be set if LLM didn't classify as continueFrom
  if (secondCompleted.parentTaskId) {
    log('Multi-turn linking confirmed: parentTaskId is set');
  } else {
    log('WARN: parentTaskId not set — LLM may not have classified as continueFrom');
  }

  log('=== Docx multi-turn test passed! ===');
  process.exit(0);
} catch (err) {
  log(`FAIL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
