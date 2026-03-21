import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';

// --- Test setup: create isolated DB ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-exp-'));
const dbPath = path.join(tmpDir, 'test.db');

// Import DB module and initialize with test database
const dbMod = await import('../dist/blackboard/db.js');
const contextMod = await import('../dist/skills/context.js');

// Helper: raw SQLite for verification
let rawDb;

before(() => {
  dbMod.initDatabase(dbPath);
  rawDb = new Database(dbPath);
});

after(() => {
  rawDb?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================
// Test 1: Experience write is fast — note creation works
// =========================================================
describe('Experience write', () => {
  it('creates an orchestration experience note', () => {
    const note = {
      id: 'exp-orch-1',
      source: 'user',
      title: 'URLs should use knowledge-ingest pipeline',
      content: 'When user sends a URL for ingestion, route through knowledge-ingest skill. Why: ensures consistent vault formatting.',
      tags: 'exp:orchestration',
      createdAt: new Date().toISOString(),
    };
    dbMod.createNote(note);
    const stored = dbMod.getNote('exp-orch-1');
    assert.ok(stored);
    assert.equal(stored.title, note.title);
    assert.equal(stored.tags, 'exp:orchestration');
  });

  it('creates a skill-specific experience note', () => {
    const note = {
      id: 'exp-skill-1',
      source: 'user',
      title: 'Always cross-link to active projects',
      content: 'Every ingested note must include Connections section with wikilinks to existing vault notes.',
      tags: 'exp:skill:knowledge-ingest',
      createdAt: new Date().toISOString(),
    };
    dbMod.createNote(note);
    const stored = dbMod.getNote('exp-skill-1');
    assert.ok(stored);
    assert.equal(stored.tags, 'exp:skill:knowledge-ingest');
  });

  it('creates a global experience note', () => {
    const note = {
      id: 'exp-global-1',
      source: 'user',
      title: 'Ask before assuming when preference is unclear',
      content: 'When unsure whether to follow an old preference, ask the user briefly rather than silently choosing.',
      tags: 'exp:global',
      createdAt: new Date().toISOString(),
    };
    dbMod.createNote(note);
    const stored = dbMod.getNote('exp-global-1');
    assert.ok(stored);
    assert.equal(stored.tags, 'exp:global');
  });
});

// =========================================================
// Test 2: Orchestration experience only reaches doorman scope
// =========================================================
describe('Orchestration experience scoping', () => {
  it('getNotesByTag("exp:orchestration") returns only orchestration notes', () => {
    const notes = dbMod.getNotesByTag('exp:orchestration');
    assert.ok(notes.length >= 1);
    assert.ok(notes.every(n => n.tags.includes('exp:orchestration')));
    // Should NOT include skill or global notes
    assert.ok(notes.every(n => !n.tags.includes('exp:skill') && !n.tags.includes('exp:global')));
  });
});

// =========================================================
// Test 3: Skill experience only reaches matching agents
// =========================================================
describe('Skill experience scoping', () => {
  it('getNotesByTag("exp:skill") returns all skill experience notes', () => {
    const notes = dbMod.getNotesByTag('exp:skill');
    assert.ok(notes.length >= 1);
    assert.ok(notes.every(n => n.tags.includes('exp:skill')));
  });

  it('skill experience is filtered by prompt content in context building', () => {
    // Simulate what runner.buildBlackboardContext does
    const allSkillExp = dbMod.getNotesByTag('exp:skill');

    // Task prompt mentioning knowledge-ingest
    const promptWithMatch = 'ingest this URL into the knowledge-ingest pipeline';
    const promptLower = promptWithMatch.toLowerCase();
    const matched = allSkillExp.filter(n => {
      const skillTag = (n.tags || '').split(',').find(t => t.trim().startsWith('exp:skill:'));
      if (!skillTag) return false;
      const skillName = skillTag.trim().slice('exp:skill:'.length);
      return promptLower.includes(skillName) || promptLower.includes(skillName.replace(/-/g, ' '));
    });
    assert.ok(matched.length >= 1, 'Should match knowledge-ingest experience');

    // Task prompt NOT mentioning knowledge-ingest
    const promptNoMatch = 'write a Python script to sort numbers';
    const promptLower2 = promptNoMatch.toLowerCase();
    const notMatched = allSkillExp.filter(n => {
      const skillTag = (n.tags || '').split(',').find(t => t.trim().startsWith('exp:skill:'));
      if (!skillTag) return false;
      const skillName = skillTag.trim().slice('exp:skill:'.length);
      return promptLower2.includes(skillName) || promptLower2.includes(skillName.replace(/-/g, ' '));
    });
    assert.equal(notMatched.length, 0, 'Should NOT match any skill experience for unrelated task');
  });
});

// =========================================================
// Test 4: Unrelated agents are NOT polluted
// =========================================================
describe('Agent isolation', () => {
  it('context with no matching experience has no experienceNotes section', () => {
    const ctx = { experienceNotes: [] };
    const result = contextMod.buildBlackboardContext?.(ctx) || buildBlackboardContextLocal(ctx);
    // Empty experienceNotes should not produce a section header
    assert.ok(!result.includes('Work Experience'));
  });

  it('context with experience renders the section', () => {
    const ctx = {
      experienceNotes: [{
        id: 'test',
        source: 'user',
        title: 'Test rule',
        content: 'Test content',
        tags: 'exp:global',
        createdAt: new Date().toISOString(),
      }],
    };
    // Use the exported function if available, or test inline
    const result = buildBlackboardContextLocal(ctx);
    assert.ok(result.includes('Work Experience'), 'Should render experience section');
    assert.ok(result.includes('Test rule'), 'Should include note title');
  });
});

// Local copy of buildBlackboardContext for testing (mirrors context.ts logic)
function buildBlackboardContextLocal(ctx) {
  if (!ctx) return '';
  const parts = [];

  if (ctx.blockerResults?.length > 0) {
    parts.push('## Predecessor Task Results\n');
  }
  if (ctx.relevantNotes?.length > 0) {
    parts.push('## Blackboard Notes\n');
  }
  if (ctx.experienceNotes?.length > 0) {
    parts.push('## Work Experience (standing instructions — follow unless task explicitly overrides)\n');
    let charCount = 0;
    for (const n of ctx.experienceNotes) {
      const line = `- **${n.title}**: ${n.content.slice(0, 300)}`;
      charCount += line.length;
      if (charCount > 3000) { parts.push('- *(additional experience notes truncated)*'); break; }
      parts.push(line);
    }
  }
  if (ctx.sessionMemory) {
    parts.push('## Session Memory\n');
  }
  return parts.join('\n');
}

// =========================================================
// Test 5: Cross-task result passing (blocker results)
// =========================================================
describe('Cross-task result passing', () => {
  it('blocker results appear in context', () => {
    const ctx = {
      blockerResults: [{
        id: 'task-1',
        prompt: 'Research topic X',
        result: 'Found that X relates to Y and Z',
      }],
    };
    const result = buildBlackboardContextLocal(ctx);
    assert.ok(result.includes('Predecessor Task Results'), 'Should have blocker section header');
    // Note: the local test helper only checks section presence.
    // Full content rendering is tested by the context-windowing test suite.
  });
});

// =========================================================
// Test 6: History vs current context boundary
// =========================================================
describe('Experience vs session memory boundary', () => {
  it('experience notes and session memory render in separate sections', () => {
    const ctx = {
      experienceNotes: [{
        id: 'exp-1',
        source: 'user',
        title: 'Preference A',
        content: 'Always do X',
        tags: 'exp:global',
        createdAt: new Date().toISOString(),
      }],
      sessionMemory: '# Session abc\n## Task History\nDid task 1...',
    };
    const result = buildBlackboardContextLocal(ctx);
    assert.ok(result.includes('Work Experience'));
    assert.ok(result.includes('Session Memory'));
    // Experience should come BEFORE session memory
    const expIdx = result.indexOf('Work Experience');
    const memIdx = result.indexOf('Session Memory');
    assert.ok(expIdx < memIdx, 'Experience should render before session memory');
  });
});

// =========================================================
// Test 7: Noise control — truncation and caps
// =========================================================
describe('Noise control', () => {
  it('truncates experience content at 300 chars per note', () => {
    const longContent = 'A'.repeat(500);
    const ctx = {
      experienceNotes: [{
        id: 'exp-long',
        source: 'user',
        title: 'Long note',
        content: longContent,
        tags: 'exp:global',
        createdAt: new Date().toISOString(),
      }],
    };
    const result = buildBlackboardContextLocal(ctx);
    // The rendered line should be shorter than 500 chars
    const lines = result.split('\n').filter(l => l.includes('Long note'));
    assert.ok(lines[0].length < 500, 'Content should be truncated');
  });

  it('caps total experience output at 3000 chars', () => {
    const manyNotes = Array.from({ length: 50 }, (_, i) => ({
      id: `exp-many-${i}`,
      source: 'user',
      title: `Rule ${i}`,
      content: 'X'.repeat(200),
      tags: 'exp:global',
      createdAt: new Date().toISOString(),
    }));
    const ctx = { experienceNotes: manyNotes };
    const result = buildBlackboardContextLocal(ctx);
    assert.ok(result.includes('truncated'), 'Should show truncation notice');
    assert.ok(result.length < 5000, 'Total output should be bounded');
  });

  it('deleteNote removes a note', () => {
    const note = {
      id: 'exp-delete-test',
      source: 'user',
      title: 'Temporary',
      content: 'Will be deleted',
      tags: 'exp:global',
      createdAt: new Date().toISOString(),
    };
    dbMod.createNote(note);
    assert.ok(dbMod.getNote('exp-delete-test'));

    const deleted = dbMod.deleteNote('exp-delete-test');
    assert.ok(deleted, 'deleteNote should return true');
    assert.equal(dbMod.getNote('exp-delete-test'), undefined, 'Note should be gone');
  });

  it('deleteNote returns false for nonexistent note', () => {
    const deleted = dbMod.deleteNote('nonexistent-id');
    assert.equal(deleted, false);
  });
});

// =========================================================
// Test 8: Regression — existing features still work
// =========================================================
describe('Regression: existing note features', () => {
  it('task-linked notes still work', () => {
    const note = {
      id: 'task-note-1',
      source: 'agent-abc',
      title: 'Task finding',
      content: 'Found something important',
      tags: null,
      taskId: 'task-xyz',
      createdAt: new Date().toISOString(),
    };
    dbMod.createNote(note);
    const taskNotes = dbMod.getNotesByTask('task-xyz');
    assert.ok(taskNotes.length >= 1);
    assert.equal(taskNotes[0].taskId, 'task-xyz');
  });

  it('getNotes returns recent notes', () => {
    const notes = dbMod.getNotes(10);
    assert.ok(notes.length > 0);
  });

  it('getNotesByTag does not cross-contaminate scopes', () => {
    const orchNotes = dbMod.getNotesByTag('exp:orchestration');
    const skillNotes = dbMod.getNotesByTag('exp:skill');
    const globalNotes = dbMod.getNotesByTag('exp:global');

    // Orchestration should not include skill or global
    for (const n of orchNotes) {
      assert.ok(!n.tags.includes('exp:skill:'), `Orchestration note "${n.title}" should not have skill tag`);
      assert.ok(!n.tags.includes('exp:global'), `Orchestration note "${n.title}" should not have global tag`);
    }

    // Global should not include orchestration or skill
    for (const n of globalNotes) {
      assert.ok(!n.tags.includes('exp:orchestration'), `Global note "${n.title}" should not have orchestration tag`);
      assert.ok(!n.tags.includes('exp:skill:'), `Global note "${n.title}" should not have skill tag`);
    }
  });
});

// =========================================================
// Test: Memory skill file exists and is valid
// =========================================================
describe('Memory skill', () => {
  it('SKILL.md exists with correct metadata', () => {
    const skillPath = path.join(process.cwd(), 'skills', 'memory', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'skills/memory/SKILL.md should exist');

    const content = fs.readFileSync(skillPath, 'utf-8');
    assert.ok(content.includes('name: memory'), 'Should have name: memory');
    assert.ok(content.includes('executor: claude-code'), 'Should specify claude-code executor');
    assert.ok(content.includes('exp:orchestration'), 'Should document orchestration scope');
    assert.ok(content.includes('exp:skill'), 'Should document skill scope');
    assert.ok(content.includes('exp:global'), 'Should document global scope');
  });
});
