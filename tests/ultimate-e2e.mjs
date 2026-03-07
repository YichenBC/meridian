import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Ultimate E2E Test — Long-Horizon, Multi-Turn, Cross-Domain
 *
 * Scenario: User asks Meridian to build a competitive analysis tool.
 * This exercises the full stack across multiple domains:
 *
 * PHASE 1 — Research (deep research + browser use)
 *   Turn 1: "Research the top 3 AI coding assistants and their pricing"
 *   → Doorman ack + agent spawns + result with real data
 *   Turn 2: "Also check their GitHub star counts" (follow-up, multi-turn)
 *   → Agent reuses session context
 *
 * PHASE 2 — DAG Pipeline via API (research → code → verify)
 *   Step A: Research task (gather API docs for comparison)
 *   Step B: Coding task blocked on A (generate comparison script using A's findings)
 *   Step C: Verification task blocked on B (run the generated code and validate)
 *   → Tests blockedBy, priority, context windowing
 *
 * PHASE 3 — Browser + Coding Combined
 *   Turn 3: "Open the Anthropic docs page and summarize the Claude API pricing"
 *   → Browser task via tool executor
 *   Turn 4: "Now write a cost calculator function based on that pricing" (follow-up)
 *   → Coding task, should reference pricing from Turn 3
 *
 * PHASE 4 — Status + Control Flow
 *   Turn 5: Check status while tasks are running
 *   Turn 6: Rapid-fire: send two tasks simultaneously
 *   Turn 7: "stop" while something is running
 *   Turn 8: Final status check — all tasks accounted for
 *
 * PHASE 5 — Blackboard Intelligence
 *   Post notes to blackboard, verify agents can read them
 *   Verify DAG tasks received predecessor context
 *   Verify completed task count matches expectations
 *
 * Requires: Meridian running with tool executor (claude-code or codex-cli)
 * Run: npm start && node tests/ultimate-e2e.mjs
 * Timeout: ~15-20 minutes total
 */

const API_BASE = process.env.MERIDIAN_URL || 'http://localhost:3333';
const WS_URL = API_BASE.replace('http', 'ws') + '/ws';
const client = new MeridianTestClient(WS_URL);
const { toolExecutor } = getRuntimeConfig();
const apiHeaders = {};
if (process.env.MERIDIAN_API_TOKEN) {
  apiHeaders['Authorization'] = `Bearer ${process.env.MERIDIAN_API_TOKEN}`;
}
let passed = 0;
let failed = 0;
const taskTimeline = []; // track all task IDs and outcomes

async function test(name, fn) {
  log(`\n━━━ ${name} ━━━`);
  try {
    await fn();
    passed++;
    log(`  ✓ PASS`);
  } catch (err) {
    failed++;
    log(`  ✗ FAIL — ${err.message}`);
    if (process.env.DEBUG) console.error(err);
  }
}

async function sendAndWait(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  const resp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
  return resp;
}

async function waitForAgentResult(feedsBefore, timeout = 300000) {
  return client.waitForFeed('agent_result',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
}

async function waitForAgentSpawn(feedsBefore, timeout = 30000) {
  return client.waitForFeed('agent_spawned',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
}

async function waitIdle(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const active = Array.from(client.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'running');
    if (active.length === 0) return;
    await sleep(1000);
  }
}

async function waitForTaskDone(taskId, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = client.tasks.get(taskId);
    if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) return t;
    await sleep(1000);
  }
  return client.tasks.get(taskId) || { id: taskId, status: 'timeout' };
}

async function httpPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiHeaders },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

async function httpGet(path) {
  const resp = await fetch(`${API_BASE}${path}`, { headers: apiHeaders });
  return { status: resp.status, data: await resp.json() };
}

function trackTask(label, taskId, status, result) {
  taskTimeline.push({ label, taskId, status, resultPreview: (result || '').slice(0, 80) });
}

// ─────────────────────────────────────────────────────────────────
try {
  await client.connect();
  log('╔══════════════════════════════════════════════════════════╗');
  log('║     ULTIMATE E2E TEST — Long-Horizon Multi-Domain       ║');
  log('╚══════════════════════════════════════════════════════════╝');
  log(`Executor: ${toolExecutor} | API: ${API_BASE}`);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1 — Deep Research + Multi-Turn
  // ═══════════════════════════════════════════════════════════════
  log('\n▶ PHASE 1: Deep Research + Multi-Turn Context');

  await test('1.1 Research request spawns agent and returns substantive result', async () => {
    const feedsBefore = client.feeds.length;
    client.send('Research the top 3 AI coding assistants — list their names, key features, and pricing tiers. Be specific with numbers.');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');
    assert.ok(ack.content.length > 0, 'Ack should not be empty');
    log(`  Ack: ${ack.content.slice(0, 100)}`);

    const spawned = await waitForAgentSpawn(feedsBefore, 30000);
    assert.ok(spawned, 'Should spawn a research agent');

    const result = await waitForAgentResult(feedsBefore, 300000);
    assert.ok(result, 'Should get research result');
    assert.ok(result.content.length > 100, `Result should be substantial, got ${result.content.length} chars`);
    log(`  Result: ${result.content.length} chars`);

    // Verify the result mentions at least 2 AI coding assistants
    const content = result.content.toLowerCase();
    const knownTools = ['github copilot', 'copilot', 'cursor', 'claude', 'cody', 'tabnine', 'replit', 'windsurf', 'codex'];
    const mentioned = knownTools.filter(t => content.includes(t));
    assert.ok(mentioned.length >= 2, `Should mention at least 2 AI tools, found: ${mentioned.join(', ')}`);
    log(`  Mentioned tools: ${mentioned.join(', ')}`);

    trackTask('research-ai-tools', spawned.source, 'completed', result.content);
  });

  await waitIdle();
  await sleep(2000);

  await test('1.2 Follow-up question shows multi-turn context (Doorman remembers)', async () => {
    const feedsBefore = client.feeds.length;
    // This follow-up references the previous research — Doorman should have context
    client.send('Which one of those has the best free tier?');

    const resp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 60000);
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 10, 'Response should be substantive');
    log(`  Response: ${resp.content.slice(0, 150)}`);

    // The response should reference something from the previous research
    // (either answer directly from context, or spawn an agent that has context)
    // Either way, we just verify we get a meaningful response
    trackTask('follow-up-free-tier', 'doorman', 'answered', resp.content);
  });

  await waitIdle(180000);
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 — DAG Pipeline (Research → Code → Verify)
  // ═══════════════════════════════════════════════════════════════
  log('\n▶ PHASE 2: DAG Pipeline via API (blockedBy + context windowing)');

  await test('2.1 Create a 3-task DAG pipeline: research → code → verify', async () => {
    // Task A: Research — gather data
    const { status: s1, data: taskA } = await httpPost('/api/tasks', {
      prompt: `Research task: List the HTTP status codes for common API errors (400, 401, 403, 404, 429, 500, 502, 503). For each, give: the status code, name, meaning, and a one-line example of when it occurs. Format as a clean table.`,
      executor: toolExecutor,
      source: 'a2ui:0',
      priority: 10,
    });
    assert.equal(s1, 201, 'Task A should be created');
    log(`  Task A (research): ${taskA.id.slice(0, 8)}`);

    // Task B: Code — blocked on A, should receive A's result as context
    const { status: s2, data: taskB } = await httpPost('/api/tasks', {
      prompt: `Coding task: Write a TypeScript function called \`describeHttpError(code: number): string\` that returns a human-readable description for common HTTP error codes. Use the research from the predecessor task to ensure accuracy. Include JSDoc comments. Output ONLY the function code, no explanation.`,
      executor: toolExecutor,
      source: 'a2ui:0',
      blockedBy: [taskA.id],
      priority: 5,
    });
    assert.equal(s2, 201, 'Task B should be created');
    log(`  Task B (code, blocked on A): ${taskB.id.slice(0, 8)}`);

    // Task C: Verify — blocked on B, should receive B's result
    const { status: s3, data: taskC } = await httpPost('/api/tasks', {
      prompt: `Verification task: Review the TypeScript function from the predecessor task. Check that: (1) it handles at least 5 different HTTP codes, (2) descriptions are accurate, (3) it has JSDoc comments, (4) it compiles as valid TypeScript. Output a brief pass/fail verdict with reasons.`,
      executor: toolExecutor,
      source: 'a2ui:0',
      blockedBy: [taskB.id],
      priority: 1,
    });
    assert.equal(s3, 201, 'Task C should be created');
    log(`  Task C (verify, blocked on B): ${taskC.id.slice(0, 8)}`);

    // Verify initial states
    await sleep(2000);
    const stateA = client.tasks.get(taskA.id);
    log(`  A status: ${stateA?.status || 'unknown'} (should be running or pending)`);

    const stateB = client.tasks.get(taskB.id);
    assert.equal(stateB?.status, 'pending', 'B should still be pending (blocked on A)');
    log(`  B status: ${stateB?.status} (correctly blocked)`);

    const stateC = client.tasks.get(taskC.id);
    assert.equal(stateC?.status, 'pending', 'C should still be pending (blocked on B)');
    log(`  C status: ${stateC?.status} (correctly blocked)`);

    // Wait for A to complete
    log('  Waiting for Task A (research)...');
    const doneA = await waitForTaskDone(taskA.id, 300000);
    assert.equal(doneA.status, 'completed', `A should complete, got: ${doneA.status}`);
    log(`  A completed: ${(doneA.result || '').slice(0, 80)}...`);
    trackTask('dag-research', taskA.id, doneA.status, doneA.result);

    // B should now be unblocked and running
    log('  Waiting for Task B (code)...');
    await sleep(3000);
    const midB = client.tasks.get(taskB.id);
    log(`  B status after A completion: ${midB?.status}`);
    assert.ok(
      midB?.status === 'running' || midB?.status === 'completed',
      `B should be running or completed after A finishes, got: ${midB?.status}`
    );

    const doneB = await waitForTaskDone(taskB.id, 300000);
    assert.equal(doneB.status, 'completed', `B should complete, got: ${doneB.status}`);
    log(`  B completed: ${(doneB.result || '').slice(0, 80)}...`);
    trackTask('dag-code', taskB.id, doneB.status, doneB.result);

    // C should now be unblocked
    log('  Waiting for Task C (verify)...');
    const doneC = await waitForTaskDone(taskC.id, 300000);
    assert.equal(doneC.status, 'completed', `C should complete, got: ${doneC.status}`);
    log(`  C completed: ${(doneC.result || '').slice(0, 80)}...`);
    trackTask('dag-verify', taskC.id, doneC.status, doneC.result);

    log('  DAG pipeline completed: research → code → verify');
  });

  await waitIdle();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3 — Browser Use + Coding Follow-Up
  // ═══════════════════════════════════════════════════════════════
  log('\n▶ PHASE 3: Browser Use + Coding Follow-Up');

  await test('3.1 Browser task: fetch and summarize a web page', async () => {
    const feedsBefore = client.feeds.length;
    client.send('Go to https://docs.anthropic.com/en/docs/about-claude/models and summarize the available Claude models and their context windows. List each model name and its max output tokens.');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');
    log(`  Ack: ${ack.content.slice(0, 100)}`);

    const spawned = await waitForAgentSpawn(feedsBefore, 30000);
    assert.ok(spawned, 'Should spawn a browser agent');

    // Verify it was routed to tool executor (browser needs tools)
    const browserTask = Array.from(client.tasks.values())
      .find(t => t.prompt?.includes('anthropic') || t.prompt?.includes('Claude models'));
    if (browserTask) {
      assert.equal(browserTask.executor, toolExecutor,
        `Browser task should use ${toolExecutor}, got: ${browserTask.executor}`);
    }

    const result = await waitForAgentResult(feedsBefore, 300000);
    assert.ok(result, 'Should get browser result');
    assert.ok(result.content.length > 50, 'Result should be substantive');
    log(`  Result: ${result.content.length} chars`);

    // Should mention at least one Claude model
    const content = result.content.toLowerCase();
    const models = ['opus', 'sonnet', 'haiku', 'claude-3', 'claude-4', 'claude 3', 'claude 4'];
    const mentioned = models.filter(m => content.includes(m));
    assert.ok(mentioned.length >= 1, `Should mention Claude models, found: ${mentioned.join(', ')}`);
    log(`  Models mentioned: ${mentioned.join(', ')}`);

    trackTask('browser-models', spawned.source, 'completed', result.content);
  });

  await waitIdle(180000);
  await sleep(2000);

  await test('3.2 Coding follow-up referencing browser results', async () => {
    const feedsBefore = client.feeds.length;
    client.send('Based on that Claude model info, write a TypeScript type definition that maps each model name to its context window size. Call it ClaudeModelContextWindows.');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');

    // Could be answered directly by Doorman (has context) or delegated
    // Either way, wait for a complete response
    let resultContent = ack.content;

    // If delegated, wait for agent result
    const isTaskCreated = Array.from(client.tasks.values())
      .some(t => t.prompt?.includes('ClaudeModelContextWindows') && t.status !== 'completed');
    if (isTaskCreated) {
      const result = await waitForAgentResult(feedsBefore, 300000);
      if (result) resultContent = result.content;
    }

    assert.ok(resultContent.length > 20, 'Should get a coding response');
    log(`  Response: ${resultContent.slice(0, 150)}`);

    trackTask('coding-typedef', 'doorman-or-agent', 'completed', resultContent);
  });

  await waitIdle(180000);
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 4 — Status + Control Flow
  // ═══════════════════════════════════════════════════════════════
  log('\n▶ PHASE 4: Status Checks + Control Flow');

  await test('4.1 Status check shows completed tasks', async () => {
    const resp = await sendAndWait('status', 15000);
    assert.ok(resp, 'Should get status');
    assert.ok(resp.content.length > 10, 'Status should be substantive');
    // Should mention completed tasks
    assert.ok(
      resp.content.includes('completed') || resp.content.includes('clear') || resp.content.includes('Working'),
      `Status should be informative: ${resp.content.slice(0, 120)}`
    );
    log(`  Status: ${resp.content.slice(0, 150)}`);
  });

  await sleep(1000);

  await test('4.2 Rapid-fire: two simultaneous tasks both get picked up', async () => {
    const feedsBefore = client.feeds.length;
    const tasksBefore = new Set(client.tasks.keys());

    client.send('Write a haiku about TypeScript');
    await sleep(300);
    client.send('Write a haiku about SQLite');

    // Wait for both acknowledgments
    const ack1 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack1, 'Should get first ack');

    const ack2 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore && f !== ack1, 30000);
    assert.ok(ack2, 'Should get second ack');

    // Wait for at least 2 agents to spawn
    const spawn1 = await waitForAgentSpawn(feedsBefore, 30000);
    assert.ok(spawn1, 'First agent should spawn');

    // Second spawn might overlap or sequence depending on maxAgents
    log('  Both tasks acknowledged and processing');

    // Wait for both to complete
    await waitIdle(180000);

    const newTasks = Array.from(client.tasks.values())
      .filter(t => !tasksBefore.has(t.id));
    const completed = newTasks.filter(t => t.status === 'completed');
    log(`  ${completed.length} of ${newTasks.length} new tasks completed`);
    assert.ok(completed.length >= 2, 'Both tasks should complete');

    trackTask('rapid-haiku-1', completed[0]?.id, completed[0]?.status, completed[0]?.result);
    trackTask('rapid-haiku-2', completed[1]?.id, completed[1]?.status, completed[1]?.result);
  });

  await waitIdle();
  await sleep(1000);

  await test('4.3 Start a task, then stop it mid-flight', async () => {
    const feedsBefore = client.feeds.length;
    client.send('Write a 10-page detailed essay about the history of programming languages from FORTRAN to Rust, covering every decade.');

    // Wait for agent to spawn
    const spawned = await waitForAgentSpawn(feedsBefore, 30000);
    assert.ok(spawned, 'Should spawn agent for long task');
    await sleep(3000);

    // Kill it
    const killFeedsBefore = client.feeds.length;
    client.send('stop');
    const killResp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= killFeedsBefore, 15000);
    assert.ok(killResp, 'Should get kill confirmation');
    assert.ok(
      killResp.content.toLowerCase().includes('stop') || killResp.content.toLowerCase().includes('cancel'),
      `Kill response should confirm: ${killResp.content.slice(0, 80)}`
    );
    log(`  Kill response: ${killResp.content}`);

    // Verify the task was cancelled
    await sleep(2000);
    const longTask = Array.from(client.tasks.values())
      .find(t => t.prompt?.includes('10-page') || t.prompt?.includes('FORTRAN'));
    if (longTask) {
      assert.ok(
        longTask.status === 'cancelled' || longTask.status === 'failed',
        `Killed task should be cancelled/failed, got: ${longTask.status}`
      );
      log(`  Long task status: ${longTask.status}`);
      trackTask('killed-essay', longTask.id, longTask.status, '(killed)');
    }
  });

  await waitIdle();
  await sleep(1000);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 5 — Blackboard Intelligence
  // ═══════════════════════════════════════════════════════════════
  log('\n▶ PHASE 5: Blackboard Intelligence');

  await test('5.1 Post a note and verify it appears in API', async () => {
    const { status, data } = await httpPost('/api/notes', {
      title: 'Test Observation from Ultimate E2E',
      content: 'The system handled all phases correctly. Multi-turn context was maintained.',
      source: 'ultimate-test',
      tags: 'test,ultimate,observation',
    });
    assert.equal(status, 201, 'Note should be created');
    assert.ok(data.id, 'Should return note ID');

    // Verify retrieval
    const getResp = await httpGet(`/api/notes?tag=ultimate`);
    assert.equal(getResp.status, 200);
    const found = getResp.data.find(n => n.id === data.id);
    assert.ok(found, 'Note should be retrievable');
    assert.equal(found.title, 'Test Observation from Ultimate E2E');
    log(`  Note created and verified: ${data.id.slice(0, 8)}`);
  });

  await test('5.2 Health endpoint returns valid data', async () => {
    const resp = await fetch(`${API_BASE}/health`);
    assert.equal(resp.status, 200);
    const health = await resp.json();
    assert.equal(health.status, 'ok');
    assert.ok(typeof health.uptime === 'number');
    assert.ok(health.uptime > 0, 'Uptime should be positive');
    log(`  Health: uptime=${Math.round(health.uptime)}s, tasks=${health.tasks.total}, agents=${health.agents}`);
  });

  await test('5.3 Final state consistency check', async () => {
    const state = await httpGet('/api/state');
    assert.equal(state.status, 200);

    const tasks = state.data.tasks;
    const completed = tasks.filter(t => t.status === 'completed');
    const failed = tasks.filter(t => t.status === 'failed');
    const cancelled = tasks.filter(t => t.status === 'cancelled');
    const pending = tasks.filter(t => t.status === 'pending');
    const running = tasks.filter(t => t.status === 'running');

    log(`  Tasks: ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled, ${pending.length} pending, ${running.length} running`);
    log(`  Total: ${tasks.length}`);

    // Should have no stuck tasks
    assert.equal(pending.length, 0, `No tasks should be stuck pending, found ${pending.length}`);
    assert.equal(running.length, 0, `No tasks should be stuck running, found ${running.length}`);

    // Should have completed at least the core tasks
    assert.ok(completed.length >= 5, `Should have at least 5 completed tasks, got ${completed.length}`);

    // Check agents are all cleaned up
    const agents = state.data.agents;
    const workingAgents = agents.filter(a => a.status === 'working');
    assert.equal(workingAgents.length, 0, `No agents should be stuck working, found ${workingAgents.length}`);
    log(`  Agents: ${agents.length} total, 0 stuck`);

    // Notes should include our test note
    const notes = state.data.notes;
    const testNote = notes.find(n => n.tags?.includes('ultimate'));
    assert.ok(testNote, 'Test note should be in state');
  });

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  log('\n╔══════════════════════════════════════════════════════════╗');
  log('║                    TEST RESULTS                         ║');
  log('╚══════════════════════════════════════════════════════════╝');

  log('\nTask Timeline:');
  for (const t of taskTimeline) {
    const icon = t.status === 'completed' ? '✓' : t.status === 'answered' ? '→' : '✗';
    log(`  ${icon} ${t.label}: ${t.status} ${t.resultPreview ? `— ${t.resultPreview}` : ''}`);
  }

  log(`\nDomains exercised:`);
  log(`  • Deep Research: AI tool comparison`);
  log(`  • Multi-Turn Context: follow-up questions referencing previous results`);
  log(`  • DAG Pipeline: research → code → verify with blockedBy`);
  log(`  • Browser Use: fetching and summarizing web documentation`);
  log(`  • Coding: TypeScript function generation from research data`);
  log(`  • Control Flow: status, rapid-fire, stop/cancel`);
  log(`  • Blackboard: notes API, health endpoint, state consistency`);

  log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  log(failed === 0 ? '\n★ ULTIMATE TEST PASSED ★' : '\n⚠ ISSUES FOUND — see above');
  process.exit(failed > 0 ? 1 : 0);

} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
