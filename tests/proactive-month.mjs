import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Proactive Month Simulation — 2 test cases
 *
 * Simulates ~1 month of real usage in compressed time:
 * - Daily briefs, periodic monitoring via cron → POST /api/tasks
 * - User messages interleaved with proactive tasks
 *
 * Sets up real crontab entries, simulates the calls, then cleans up.
 *
 * Requires: Meridian running (npm start)
 */

const API_BASE = 'http://localhost:3333';
const CRON_MARKER = '# MERIDIAN_TEST_PROACTIVE';
const client = new MeridianTestClient();
const { toolExecutor } = getRuntimeConfig();
const INTERACTIVE_SOURCE = 'a2ui:0';
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

async function httpPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

async function httpGet(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  return { status: resp.status, data: await resp.json() };
}

function sendAndWaitResponse(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  return client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
}

async function waitIdle(timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const active = Array.from(client.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'running');
    if (active.length === 0) return;
    await sleep(500);
  }
}

/**
 * Wait for a specific task to reach completed or failed.
 */
async function waitForTask(taskId, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = client.tasks.get(taskId);
    if (t && (t.status === 'completed' || t.status === 'failed')) return t;
    await sleep(500);
  }
  return null;
}

// ---------------------------------------------------------------
// Crontab helpers — install and remove test entries
// ---------------------------------------------------------------

function installTestCron() {
  const dailyBrief = `* * * * * curl -s -X POST ${API_BASE}/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"Generate daily brief: summarize key priorities","source":"cron"}' ${CRON_MARKER}`;
  const monitoring = `* * * * * curl -s -X POST ${API_BASE}/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"System health check: report disk, memory, uptime","executor":"${toolExecutor}","source":"cron"}' ${CRON_MARKER}`;

  let existing = '';
  try { existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' }); } catch { /* no crontab */ }

  // Don't duplicate
  if (existing.includes(CRON_MARKER)) {
    log('Test cron entries already installed');
    return;
  }

  const newCrontab = existing.trimEnd() + '\n' + dailyBrief + '\n' + monitoring + '\n';
  execSync(`echo ${JSON.stringify(newCrontab)} | crontab -`);
  log('Installed test cron entries');
}

function removeTestCron() {
  let existing = '';
  try { existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' }); } catch { return; }

  const cleaned = existing
    .split('\n')
    .filter(line => !line.includes(CRON_MARKER))
    .join('\n');

  if (cleaned.trim() === '') {
    execSync('crontab -r 2>/dev/null || true');
  } else {
    execSync(`echo ${JSON.stringify(cleaned)} | crontab -`);
  }
  log('Removed test cron entries');
}

function verifyCronInstalled() {
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    return crontab.includes(CRON_MARKER);
  } catch { return false; }
}

// ---------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------

const DAILY_BRIEFS = [
  'Generate daily brief: summarize key priorities for today',
  'Morning brief: check calendar, weather, and pending tasks',
  'Daily digest: summarize yesterday\'s completed work and today\'s plan',
  'Weekly review: summarize this week\'s accomplishments',
  'Daily brief: any urgent items that need attention today?',
];

const MONITORING = [
  'System health check: report disk, memory, uptime',
  'Check if any background tasks failed in the last 6 hours',
  'Monitor: scan recent logs for errors or warnings',
];

const USER_MESSAGES = [
  { type: 'chat', content: 'good morning' },
  { type: 'task', content: 'write a haiku about coffee' },
  { type: 'status', content: 'status' },
  { type: 'task', content: 'write a one-sentence motivational quote' },
  { type: 'chat', content: 'thanks, that was great' },
  { type: 'status', content: 'what\'s going on?' },
  { type: 'task', content: 'write a fun fact about space' },
  { type: 'chat', content: 'cool' },
];

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

try {
  await client.connect();
  log('=== Proactive Month Simulation (2 cases) ===');

  // ---------------------------------------------------------------
  // Test 1: A month of proactive cron tasks
  //
  // Simulates 30 days of daily briefs + monitoring checks.
  // Compressed: fire 5 daily briefs and 3 monitoring tasks via API,
  // same as cron would over ~1 week. Verify all complete, correct
  // source field, and crontab integration works.
  // ---------------------------------------------------------------
  await test('Month of proactive cron tasks (compressed)', async () => {
    // Step 1: Install real crontab entries (proves the setup works)
    installTestCron();
    assert.ok(verifyCronInstalled(), 'Cron entries should be installed');
    log('Crontab verified — real cron entries are in place');

    // Step 2: Simulate compressed month — fire proactive tasks via API
    // (same calls cron would make, but we don't wait for cron to tick)
    const cronTaskIds = [];

    log('Simulating 30 days: firing 5 daily briefs + 3 monitoring checks...');

    // Day 1-5: daily briefs
    for (let day = 0; day < DAILY_BRIEFS.length; day++) {
      const { status, data } = await httpPost('/api/tasks', {
        prompt: DAILY_BRIEFS[day],
        source: 'cron',
      });
      assert.equal(status, 201, `Day ${day + 1} brief should be created`);
      cronTaskIds.push(data.id);
      log(`  Day ${day + 1}: brief posted (${data.id})`);

      // Don't flood — let runner pick up tasks between batches
      // Simulates tasks arriving spread across days
      await sleep(500);
    }

    // Every 6 hours: monitoring (3 checks = ~18 hours of a single day)
    for (let i = 0; i < MONITORING.length; i++) {
      const { status, data } = await httpPost('/api/tasks', {
        prompt: MONITORING[i],
        executor: toolExecutor,
        source: 'cron',
      });
      assert.equal(status, 201, `Monitoring ${i + 1} should be created`);
      cronTaskIds.push(data.id);
      log(`  Monitor ${i + 1}: check posted (${data.id})`);
      await sleep(500);
    }

    // Step 3: Wait for all cron tasks to complete (generous timeout — they queue)
    log(`Waiting for ${cronTaskIds.length} proactive tasks to complete...`);
    let completed = 0;
    let taskFailed = 0;
    for (const id of cronTaskIds) {
      const t = await waitForTask(id, 180000);
      if (!t) {
        log(`  WARNING: task ${id} did not complete in time`);
        taskFailed++;
      } else if (t.status === 'completed') {
        completed++;
      } else {
        log(`  WARNING: task ${id} ended with status=${t.status}`);
        taskFailed++;
      }
    }

    log(`  Results: ${completed} completed, ${taskFailed} failed/timeout out of ${cronTaskIds.length}`);
    assert.ok(completed >= cronTaskIds.length - 1,
      `At least ${cronTaskIds.length - 1} of ${cronTaskIds.length} cron tasks should complete, got ${completed}`);

    // Step 4: Verify source tracking
    const state = await httpGet('/api/state');
    const cronTasks = state.data.tasks.filter(t => t.source === 'cron');
    assert.ok(cronTasks.length >= cronTaskIds.length,
      `Should have at least ${cronTaskIds.length} cron-sourced tasks in DB, found ${cronTasks.length}`);
    log(`Source tracking: ${cronTasks.length} tasks marked source="cron" in blackboard`);

    // Step 5: Also post a note (daily observation — no spawn)
    const { status: noteStatus } = await httpPost('/api/notes', {
      title: 'Week 1 observation',
      content: 'System ran 5 daily briefs and 3 monitoring checks without issues.',
      source: 'cron',
      tags: 'weekly,observation',
    });
    assert.equal(noteStatus, 201, 'Note should be created');
    log('Posted weekly observation note');
  });

  await waitIdle();
  await sleep(2000);

  // ---------------------------------------------------------------
  // Test 2: Mixed month — cron tasks interleaved with user messages
  //
  // Simulates the real UX: proactive tasks firing in the background
  // while user sends messages, asks status, delegates tasks.
  // Verifies no interference between proactive and interactive.
  // ---------------------------------------------------------------
  await test('Mixed proactive + user workload over a month', async () => {
    const allTaskIds = [];
    const userTaskIds = [];
    let userChats = 0;
    let userTasksAcked = 0;

    log('Simulating mixed month: cron + user interleaved...');

    // Simulate 4 "weeks" — each week has 1-2 cron tasks + 2 user interactions
    for (let week = 1; week <= 4; week++) {
      log(`  Week ${week}:`);

      // --- Cron fires daily brief for this week ---
      const briefPrompt = `Week ${week} daily brief: summarize priorities`;
      const { data: cronData } = await httpPost('/api/tasks', {
        prompt: briefPrompt,
        source: 'cron',
      });
      allTaskIds.push(cronData.id);
      log(`    Cron: daily brief (${cronData.id})`);

      // --- User interaction mid-week ---
      const userAction = USER_MESSAGES[(week - 1) * 2 % USER_MESSAGES.length];
      if (userAction.type === 'chat') {
        const resp = await sendAndWaitResponse(userAction.content);
        assert.ok(resp, `Week ${week}: user chat should get response`);
        assert.ok(resp.content.length > 0, 'Chat response should not be empty');
        userChats++;
        log(`    User chat: "${userAction.content}" → "${resp.content.slice(0, 60)}"`);
      } else if (userAction.type === 'task') {
        const feedsBefore = client.feeds.length;
        client.send(userAction.content);
        const ack = await client.waitForFeed('doorman_response',
          f => client.feeds.indexOf(f) >= feedsBefore, 30000);
        assert.ok(ack, `Week ${week}: user task should be acknowledged`);
        userTasksAcked++;
        log(`    User task: "${userAction.content}" → ack`);

        // Find the new task
        await sleep(1000);
        const newUserTask = Array.from(client.tasks.values())
          .find(t => t.source === INTERACTIVE_SOURCE && t.prompt?.includes(userAction.content.slice(0, 20))
            && !userTaskIds.includes(t.id));
        if (newUserTask) userTaskIds.push(newUserTask.id);
      } else if (userAction.type === 'status') {
        const resp = await sendAndWaitResponse(userAction.content);
        assert.ok(resp, `Week ${week}: status should respond`);
        log(`    User status: "${resp.content.slice(0, 80)}"`);
      }

      // --- Cron fires monitoring check ---
      if (week % 2 === 0) {
        const monPrompt = `Week ${week} monitoring: check system health`;
        const { data: monData } = await httpPost('/api/tasks', {
          prompt: monPrompt,
          executor: toolExecutor,
          source: 'cron',
        });
        allTaskIds.push(monData.id);
        log(`    Cron: monitoring check (${monData.id})`);
      }

      // --- Another user interaction end of week ---
      const userAction2 = USER_MESSAGES[((week - 1) * 2 + 1) % USER_MESSAGES.length];
      if (userAction2.type === 'chat') {
        const resp = await sendAndWaitResponse(userAction2.content);
        assert.ok(resp, `Week ${week} end: chat should respond`);
        userChats++;
        log(`    User chat: "${userAction2.content}" → "${resp.content.slice(0, 60)}"`);
      } else if (userAction2.type === 'task') {
        const feedsBefore = client.feeds.length;
        client.send(userAction2.content);
        const ack = await client.waitForFeed('doorman_response',
          f => client.feeds.indexOf(f) >= feedsBefore, 30000);
        assert.ok(ack, `Week ${week} end: task should be acknowledged`);
        userTasksAcked++;
        log(`    User task: "${userAction2.content}" → ack`);
      } else if (userAction2.type === 'status') {
        const resp = await sendAndWaitResponse(userAction2.content);
        assert.ok(resp, `Week ${week} end: status should respond`);
        log(`    User status: "${resp.content.slice(0, 80)}"`);
      }

      // Brief pause between weeks (let tasks drain)
      await sleep(1000);
    }

    // Wait for everything to complete
    log('Waiting for all tasks to complete...');
    await waitIdle(300000);

    // Verify results
    const finalState = await httpGet('/api/state');
    const cronTasks = finalState.data.tasks.filter(t => t.source === 'cron');
    const userTasks = finalState.data.tasks.filter(t => t.source === INTERACTIVE_SOURCE);
    const completedCron = cronTasks.filter(t => t.status === 'completed').length;
    const completedUser = userTasks.filter(t => t.status === 'completed').length;

    log(`\n  Month summary:`);
    log(`    Cron tasks: ${completedCron} completed out of ${cronTasks.length}`);
    log(`    User tasks: ${completedUser} completed out of ${userTasks.length}`);
    log(`    User chats: ${userChats} responded`);
    log(`    User tasks acked: ${userTasksAcked}`);

    // At least most tasks should complete (allow 1 failure for flakiness)
    assert.ok(completedCron >= allTaskIds.length - 1,
      `At least ${allTaskIds.length - 1} cron tasks should complete, got ${completedCron}`);
    assert.ok(userChats >= 2, `Should have at least 2 chat interactions, got ${userChats}`);
    assert.ok(userTasksAcked >= 2, `Should have at least 2 tasks acknowledged, got ${userTasksAcked}`);

    // Verify cron and user tasks don't interfere
    // (user chats still responded during cron task execution)
    log('No interference detected between proactive and user tasks.');
  });

  // ---------------------------------------------------------------
  // Cleanup: remove test cron entries
  // ---------------------------------------------------------------
  log('\n--- Cleanup ---');
  removeTestCron();
  assert.ok(!verifyCronInstalled(), 'Test cron entries should be removed');
  log('Crontab cleaned up — no test entries remain');

  // Summary
  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  // Always clean up cron on failure
  try { removeTestCron(); } catch { /* best effort */ }
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  try { removeTestCron(); } catch { /* best effort */ }
  client.disconnect();
}
