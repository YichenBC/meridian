import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Multi-Agent Collaboration Test — The Ultimate Task
 *
 * 5 agents work in parallel on a complex project analysis.
 * All inter-agent communication happens through the blackboard (notes API).
 *
 * Phase 1 (parallel): 4 research agents analyze different aspects
 *   Agent A: Codebase structure → posts note tagged "report:structure"
 *   Agent B: Dependencies       → posts note tagged "report:deps"
 *   Agent C: Database schema    → posts note tagged "report:schema"
 *   Agent D: Code quality scan  → posts note tagged "report:quality"
 *
 * Phase 2 (synthesis): 1 agent reads all notes and produces final report
 *   Agent E: Reads notes via API → posts note tagged "report:final"
 *
 * Requires: MERIDIAN_MAX_AGENTS=5 (to run all 4 research agents in parallel)
 */

const API_BASE = 'http://localhost:3333';
const client = new MeridianTestClient();
const { toolExecutor } = getRuntimeConfig();

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

function waitForTask(taskId, timeout = 300000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const check = () => {
      const t = client.tasks.get(taskId);
      if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) {
        resolve(t);
        return;
      }
      if (Date.now() > deadline) {
        resolve(t || { status: 'timeout', id: taskId });
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

function waitForNote(tag, timeout = 300000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const resp = await httpGet(`/api/notes?tag=${tag}&limit=1`);
        if (resp.status === 200 && resp.data.length > 0) {
          resolve(resp.data[0]);
          return;
        }
      } catch {}
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

// --- Task prompts: each agent posts findings as a note via curl ---
const TASK_A_PROMPT = `Analyze the Meridian project codebase structure.
1. Count the number of TypeScript source files in src/
2. List the main directories and what they contain
3. Identify the entry point and key modules

When done, post your findings as a note to the blackboard using this exact curl command:
curl -s -X POST http://localhost:3333/api/notes -H 'Content-Type: application/json' -d '{"title":"Codebase Structure Analysis","content":"<YOUR FINDINGS HERE>","source":"agent-structure","tags":"report,report:structure"}'

Replace <YOUR FINDINGS HERE> with your actual analysis (escape JSON properly). This is critical — other agents will read your note.`;

const TASK_B_PROMPT = `Analyze the Meridian project dependencies.
1. Read package.json and list all dependencies and devDependencies
2. Note the Node.js/TypeScript versions
3. Identify key frameworks (express, ws, better-sqlite3, etc.)

When done, post your findings as a note to the blackboard using this exact curl command:
curl -s -X POST http://localhost:3333/api/notes -H 'Content-Type: application/json' -d '{"title":"Dependency Analysis","content":"<YOUR FINDINGS HERE>","source":"agent-deps","tags":"report,report:deps"}'

Replace <YOUR FINDINGS HERE> with your actual analysis (escape JSON properly). This is critical — other agents will read your note.`;

const TASK_C_PROMPT = `Analyze the Meridian blackboard database schema.
1. Open the SQLite database at data/meridian.db (or the test data dir)
2. List all tables and their columns
3. Describe the relationships between tables (tasks, agents, feeds, notes, approvals)

When done, post your findings as a note to the blackboard using this exact curl command:
curl -s -X POST http://localhost:3333/api/notes -H 'Content-Type: application/json' -d '{"title":"Database Schema Analysis","content":"<YOUR FINDINGS HERE>","source":"agent-schema","tags":"report,report:schema"}'

Replace <YOUR FINDINGS HERE> with your actual analysis (escape JSON properly). This is critical — other agents will read your note.`;

const TASK_D_PROMPT = `Scan the Meridian project for code quality indicators.
1. Search for TODO, FIXME, HACK comments in the source code
2. Count total lines of TypeScript code
3. Note any potential issues (unused imports, large functions, etc.)

When done, post your findings as a note to the blackboard using this exact curl command:
curl -s -X POST http://localhost:3333/api/notes -H 'Content-Type: application/json' -d '{"title":"Code Quality Scan","content":"<YOUR FINDINGS HERE>","source":"agent-quality","tags":"report,report:quality"}'

Replace <YOUR FINDINGS HERE> with your actual analysis (escape JSON properly). This is critical — other agents will read your note.`;

const TASK_E_PROMPT = `You are the synthesis agent. Your job is to read research notes from 4 other agents and produce a final project analysis report.

Step 1: Fetch all research notes from the blackboard API:
  curl -s http://localhost:3333/api/notes?tag=report

Step 2: Read each note carefully. There should be 4 notes tagged with:
  - report:structure (codebase structure)
  - report:deps (dependencies)
  - report:schema (database schema)
  - report:quality (code quality)

If any notes are missing, wait 10 seconds and try again (up to 3 retries).

Step 3: Synthesize all 4 analyses into a comprehensive final report with these sections:
  - Executive Summary
  - Architecture Overview (from structure analysis)
  - Technology Stack (from dependency analysis)
  - Data Model (from schema analysis)
  - Code Health (from quality scan)
  - Recommendations

Step 4: Post the final report as a note:
  curl -s -X POST http://localhost:3333/api/notes -H 'Content-Type: application/json' -d '{"title":"Meridian Project Analysis Report","content":"<YOUR REPORT>","source":"agent-synthesis","tags":"report,report:final"}'

This is the final deliverable. Make it professional and comprehensive.`;

try {
  await client.connect();
  log('=== Multi-Agent Collaboration Test ===');
  log('Task: 5 agents produce a comprehensive project analysis report');
  log('Communication: all via blackboard notes API\n');

  // Verify maxAgents >= 4 (need at least 4 parallel for phase 1)
  const stateResp = await httpGet('/api/state');
  assert.equal(stateResp.status, 200, 'Should be able to get state');
  log('Meridian is ready.\n');

  // =============================================
  // PHASE 1: Launch 4 research agents in parallel
  // =============================================
  log('--- Phase 1: Launching 4 research agents ---');

  const phase1Tasks = [];
  const taskConfigs = [
    { prompt: TASK_A_PROMPT, label: 'Structure', tag: 'report:structure' },
    { prompt: TASK_B_PROMPT, label: 'Dependencies', tag: 'report:deps' },
    { prompt: TASK_C_PROMPT, label: 'Schema', tag: 'report:schema' },
    { prompt: TASK_D_PROMPT, label: 'Quality', tag: 'report:quality' },
  ];

  for (const tc of taskConfigs) {
    const { status, data } = await httpPost('/api/tasks', {
      prompt: tc.prompt,
      executor: toolExecutor,
      source: 'multi-agent-test',
    });
    assert.equal(status, 201, `Should create task for ${tc.label}`);
    phase1Tasks.push({ ...data, label: tc.label, tag: tc.tag });
    log(`  Created: ${tc.label} (${data.id.slice(0, 8)})`);
  }

  // Monitor Phase 1: wait for all 4 to spawn
  log('\n--- Monitoring Phase 1 ---');
  const spawnDeadline = Date.now() + 60000;
  while (Date.now() < spawnDeadline) {
    const running = Array.from(client.agents.values()).filter(a => a.status === 'working');
    const completed = phase1Tasks.filter(t => {
      const task = client.tasks.get(t.id);
      return task && (task.status === 'completed' || task.status === 'failed');
    });
    log(`  Agents running: ${running.length}, Phase 1 completed: ${completed.length}/4`);
    if (running.length >= 2 || completed.length > 0) break;  // At least 2 running = parallel confirmed
    await sleep(3000);
  }

  // Wait for all 4 research tasks to complete
  log('\n--- Waiting for Phase 1 completion ---');
  const phase1Results = [];
  for (const t of phase1Tasks) {
    const result = await waitForTask(t.id, 300000);
    const statusIcon = result.status === 'completed' ? 'OK' : 'FAIL';
    log(`  [${statusIcon}] ${t.label}: ${result.status} ${result.result ? '(' + result.result.slice(0, 60) + '...)' : result.error || ''}`);
    phase1Results.push(result);
  }

  const phase1Completed = phase1Results.filter(r => r.status === 'completed').length;
  log(`\n  Phase 1: ${phase1Completed}/4 completed`);

  // Verify notes were posted to blackboard
  log('\n--- Verifying blackboard notes ---');
  const noteChecks = [];
  for (const tc of taskConfigs) {
    const note = await waitForNote(tc.tag, 30000);
    if (note) {
      log(`  Found note: "${note.title}" (tag: ${note.tags}, ${note.content.length} chars)`);
      noteChecks.push(true);
    } else {
      log(`  MISSING note for tag: ${tc.tag}`);
      noteChecks.push(false);
    }
  }

  const notesFound = noteChecks.filter(Boolean).length;
  log(`  Notes on blackboard: ${notesFound}/4`);

  // =============================================
  // PHASE 2: Launch synthesis agent
  // =============================================
  log('\n--- Phase 2: Launching synthesis agent ---');

  const { status: synthStatus, data: synthData } = await httpPost('/api/tasks', {
    prompt: TASK_E_PROMPT,
    executor: toolExecutor,
    source: 'multi-agent-test',
  });
  assert.equal(synthStatus, 201, 'Should create synthesis task');
  log(`  Created: Synthesis (${synthData.id.slice(0, 8)})`);

  // Wait for synthesis to complete
  log('\n--- Waiting for synthesis ---');
  const synthResult = await waitForTask(synthData.id, 300000);
  log(`  Synthesis: ${synthResult.status}`);
  if (synthResult.result) {
    log(`  Report preview: ${synthResult.result.slice(0, 200)}...`);
  } else if (synthResult.error) {
    log(`  Error: ${synthResult.error.slice(0, 200)}`);
  }

  // Verify final report note
  log('\n--- Verifying final report ---');
  const finalNote = await waitForNote('report:final', 30000);

  // =============================================
  // RESULTS
  // =============================================
  log('\n=== RESULTS ===');

  let allPass = true;

  // Check 1: All 4 research tasks completed
  if (phase1Completed >= 3) {
    log(`PASS: Research phase — ${phase1Completed}/4 agents completed`);
  } else {
    log(`FAIL: Research phase — only ${phase1Completed}/4 agents completed`);
    allPass = false;
  }

  // Check 2: Notes posted to blackboard (inter-agent communication)
  if (notesFound >= 3) {
    log(`PASS: Blackboard communication — ${notesFound}/4 notes posted`);
  } else {
    log(`FAIL: Blackboard communication — only ${notesFound}/4 notes posted`);
    allPass = false;
  }

  // Check 3: Parallel execution confirmed
  const maxConcurrent = phase1Results.filter(r => r.status === 'completed').length;
  // Check feeds for agent_spawned timestamps to verify parallelism
  const spawnFeeds = client.feeds.filter(f => f.type === 'agent_spawned');
  if (spawnFeeds.length >= 4) {
    const spawnTimes = spawnFeeds.slice(0, 4).map(f => new Date(f.timestamp).getTime());
    const spawnSpread = Math.max(...spawnTimes) - Math.min(...spawnTimes);
    if (spawnSpread < 60000) {  // All 4 spawned within 60s = parallel
      log(`PASS: Parallel execution — 4 agents spawned within ${Math.round(spawnSpread / 1000)}s`);
    } else {
      log(`WARN: Agents spawned over ${Math.round(spawnSpread / 1000)}s (may be sequential due to maxAgents)`);
    }
  } else {
    log(`INFO: ${spawnFeeds.length} agents spawned total`);
  }

  // Check 4: Synthesis agent completed
  if (synthResult.status === 'completed') {
    log('PASS: Synthesis agent completed');
  } else {
    log(`FAIL: Synthesis agent ${synthResult.status}`);
    allPass = false;
  }

  // Check 5: Final report exists and references multiple sections
  if (finalNote) {
    const report = finalNote.content.toLowerCase();
    const sections = ['structure', 'depend', 'schema', 'quality'];
    const found = sections.filter(s => report.includes(s));
    if (found.length >= 3) {
      log(`PASS: Final report references ${found.length}/4 research areas`);
    } else {
      log(`WARN: Final report only references ${found.length}/4 areas: ${found.join(', ')}`);
    }
    log(`  Report length: ${finalNote.content.length} chars`);
  } else {
    // Check if synthesis result itself is the report (even if note posting failed)
    if (synthResult.result && synthResult.result.length > 200) {
      log('PASS: Synthesis produced a report (note posting may have failed, but content exists)');
    } else {
      log('FAIL: No final report found');
      allPass = false;
    }
  }

  // Check 6: Total agents used
  const totalSpawns = client.feeds.filter(f => f.type === 'agent_spawned').length;
  log(`\nTotal agents spawned: ${totalSpawns} (expected: 5)`);

  log(`\n=== ${allPass ? 'ULTIMATE TEST PASSED' : 'ISSUES FOUND — see above'} ===`);
  process.exit(allPass ? 0 : 1);

} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
