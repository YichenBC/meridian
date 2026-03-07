import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach } from 'node:test';

const { initDatabase, createTask, getTask, updateTask, createNote } = await import('../dist/blackboard/db.js');
const { prepareTaskContext } = await import('../dist/skills/context.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

function makeTask(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    prompt: 'test task',
    role: 'general',
    status: 'pending',
    agentId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Context windowing (BlackboardContext) ──────────────────────────────

describe('Context windowing', () => {
  beforeEach(() => freshDb());

  it('produces base context without blackboard context', () => {
    const task = makeTask({ prompt: 'write a poem' });
    const prepared = prepareTaskContext(task, null);
    assert.ok(prepared.toolPrompt.includes('write a poem'));
    assert.ok(!prepared.toolPrompt.includes('Predecessor'));
  });

  it('includes blocker results in tool prompt', () => {
    const task = makeTask({ prompt: 'synthesize findings', blockedBy: ['r1', 'r2'] });
    const bbContext = {
      blockerResults: [
        { id: 'r1', prompt: 'research topic A', result: 'Finding A: important data' },
        { id: 'r2', prompt: 'research topic B', result: 'Finding B: more data' },
      ],
    };
    const prepared = prepareTaskContext(task, null, bbContext);
    assert.ok(prepared.toolPrompt.includes('Predecessor Task Results'));
    assert.ok(prepared.toolPrompt.includes('Finding A: important data'));
    assert.ok(prepared.toolPrompt.includes('Finding B: more data'));
    assert.ok(prepared.toolPrompt.includes('synthesize findings'));
  });

  it('includes relevant notes in tool prompt', () => {
    const task = makeTask({ prompt: 'continue work' });
    const bbContext = {
      relevantNotes: [
        { id: 'n1', source: 'agent-abc', title: 'Key insight', content: 'The API uses OAuth2', createdAt: new Date().toISOString() },
      ],
    };
    const prepared = prepareTaskContext(task, null, bbContext);
    assert.ok(prepared.toolPrompt.includes('Blackboard Notes'));
    assert.ok(prepared.toolPrompt.includes('Key insight'));
    assert.ok(prepared.toolPrompt.includes('OAuth2'));
  });

  it('includes both blockers and notes together', () => {
    const task = makeTask({ prompt: 'final step' });
    const bbContext = {
      blockerResults: [
        { id: 'r1', prompt: 'step 1', result: 'Step 1 done' },
      ],
      relevantNotes: [
        { id: 'n1', source: 'user', title: 'Hint', content: 'Use the v2 API', createdAt: new Date().toISOString() },
      ],
    };
    const prepared = prepareTaskContext(task, null, bbContext);
    assert.ok(prepared.toolPrompt.includes('Predecessor Task Results'));
    assert.ok(prepared.toolPrompt.includes('Blackboard Notes'));
    assert.ok(prepared.toolPrompt.includes('final step'));
  });

  it('truncates long blocker results', () => {
    const longResult = 'x'.repeat(2000);
    const bbContext = {
      blockerResults: [
        { id: 'r1', prompt: 'big task', result: longResult },
      ],
    };
    const prepared = prepareTaskContext(makeTask(), null, bbContext);
    // Should be truncated to 1000 chars + '...'
    assert.ok(prepared.toolPrompt.includes('...'));
    assert.ok(!prepared.toolPrompt.includes(longResult)); // Not the full 2000
  });

  it('works with skill context too', () => {
    const skill = {
      name: 'test-skill',
      description: 'A test skill',
      content: '# Instructions\nDo things.',
      baseDir: '/tmp/skill',
      sourceDir: '/tmp',
      eligibility: { eligible: true, missing: [], satisfied: [], source: 'none' },
    };
    const bbContext = {
      blockerResults: [
        { id: 'r1', prompt: 'prereq', result: 'prereq done' },
      ],
    };
    const prepared = prepareTaskContext(makeTask({ prompt: 'skill task' }), skill, bbContext);
    assert.ok(prepared.toolPrompt.includes('test-skill'));
    assert.ok(prepared.toolPrompt.includes('Predecessor Task Results'));
    assert.ok(prepared.toolPrompt.includes('skill task'));
  });

  it('returns no context section when bbContext is undefined', () => {
    const prepared = prepareTaskContext(makeTask({ prompt: 'simple' }), null, undefined);
    assert.ok(!prepared.toolPrompt.includes('Predecessor'));
    assert.ok(!prepared.toolPrompt.includes('Blackboard'));
    assert.equal(prepared.toolPrompt, 'simple');
  });

  it('returns no context section when bbContext is empty', () => {
    const prepared = prepareTaskContext(makeTask({ prompt: 'simple' }), null, {});
    assert.equal(prepared.toolPrompt, 'simple');
  });
});
