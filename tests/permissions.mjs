import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Unit tests for the Constitutional Permission System.
 *
 * Since permissions.ts is a pure TypeScript module, we import the compiled
 * output or use tsx. These tests validate the three modes and risk assessment
 * without requiring a running Meridian instance.
 */

// Dynamic import of the TS module via tsx loader
const { decide, assessRisk } = await import('../src/blackboard/permissions.js');

// ─── Risk Assessment ───────────────────────────────────────────────────

describe('assessRisk', () => {
  it('classifies file reads as low risk', () => {
    assert.equal(assessRisk('Read file src/index.ts'), 'low');
  });

  it('classifies file writes in project as low risk', () => {
    assert.equal(assessRisk('Write to src/utils/helper.ts'), 'low');
  });

  it('classifies running tests as low risk', () => {
    assert.equal(assessRisk('Execute: npm test'), 'low');
  });

  it('classifies npm install as low risk', () => {
    assert.equal(assessRisk('Execute: npm install lodash'), 'low');
  });

  it('classifies rm commands as high risk (irreversible)', () => {
    assert.equal(assessRisk('Execute: rm -rf dist/'), 'high');
  });

  it('classifies delete operations as high risk', () => {
    assert.equal(assessRisk('Delete file: production.env'), 'high');
  });

  it('classifies git push as high risk (external)', () => {
    assert.equal(assessRisk('Execute: git push origin main'), 'high');
  });

  it('classifies force push as high risk', () => {
    assert.equal(assessRisk('Execute: git push --force origin main'), 'high');
  });

  it('classifies deploy as high risk (external)', () => {
    assert.equal(assessRisk('Deploy to production server'), 'high');
  });

  it('classifies send/email as high risk (external)', () => {
    assert.equal(assessRisk('Send email to team@company.com'), 'high');
  });

  it('classifies publish as high risk (external)', () => {
    assert.equal(assessRisk('Execute: npm publish'), 'high');
  });

  it('classifies git reset --hard as high risk (irreversible)', () => {
    assert.equal(assessRisk('Execute: git reset --hard HEAD~3'), 'high');
  });

  it('classifies DROP TABLE as high risk (irreversible)', () => {
    assert.equal(assessRisk('Execute SQL: DROP TABLE users'), 'high');
  });

  it('classifies truncate as high risk (irreversible)', () => {
    assert.equal(assessRisk('Truncate the logs table'), 'high');
  });

  it('classifies PR creation as high risk (external)', () => {
    assert.equal(assessRisk('Create a PR create for the feature branch'), 'high');
  });

  it('classifies merge as high risk (external)', () => {
    assert.equal(assessRisk('Merge feature into main'), 'high');
  });

  it('classifies generic code editing as low risk', () => {
    assert.equal(assessRisk('Edit function calculateTotal in billing.ts'), 'low');
  });

  it('classifies search/grep as low risk', () => {
    assert.equal(assessRisk('Search for TODO comments in codebase'), 'low');
  });

  it('classifies creating new files as low risk', () => {
    assert.equal(assessRisk('Create file src/utils/newHelper.ts'), 'low');
  });
});

// ─── Mode: passthrough ─────────────────────────────────────────────────

describe('decide — passthrough mode', () => {
  it('allows everything regardless of risk', () => {
    assert.equal(decide('rm -rf /', 'passthrough'), 'allow');
    assert.equal(decide('git push --force', 'passthrough'), 'allow');
    assert.equal(decide('Read file', 'passthrough'), 'allow');
    assert.equal(decide('Deploy to production', 'passthrough'), 'allow');
  });
});

// ─── Mode: supervised ──────────────────────────────────────────────────

describe('decide — supervised mode', () => {
  it('asks for everything regardless of risk', () => {
    assert.equal(decide('Read file', 'supervised'), 'ask');
    assert.equal(decide('npm test', 'supervised'), 'ask');
    assert.equal(decide('Edit a comment', 'supervised'), 'ask');
  });
});

// ─── Mode: constitutional ──────────────────────────────────────────────

describe('decide — constitutional mode', () => {
  it('allows low-risk actions (subsidiarity: agent is competent)', () => {
    assert.equal(decide('Read file src/index.ts', 'constitutional'), 'allow');
    assert.equal(decide('Write to src/utils.ts', 'constitutional'), 'allow');
    assert.equal(decide('Execute: npm test', 'constitutional'), 'allow');
    assert.equal(decide('Search codebase for pattern', 'constitutional'), 'allow');
  });

  it('escalates high-risk actions to user (proportionality)', () => {
    assert.equal(decide('Execute: rm -rf dist/', 'constitutional'), 'ask');
    assert.equal(decide('Execute: git push origin main', 'constitutional'), 'ask');
    assert.equal(decide('Deploy to production', 'constitutional'), 'ask');
    assert.equal(decide('Send email notification', 'constitutional'), 'ask');
    assert.equal(decide('Execute: git reset --hard', 'constitutional'), 'ask');
    assert.equal(decide('npm publish', 'constitutional'), 'ask');
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty description as low risk', () => {
    assert.equal(assessRisk(''), 'low');
    assert.equal(decide('', 'constitutional'), 'allow');
  });

  it('is case-insensitive for risk keywords', () => {
    assert.equal(assessRisk('DELETE the entire database'), 'high');
    assert.equal(assessRisk('DEPLOY TO PROD'), 'high');
    assert.equal(assessRisk('Git Push --Force'), 'high');
  });

  it('does not false-positive on substrings', () => {
    // "remove" should not match "rm" — rm is a separate word boundary match
    assert.equal(assessRisk('Remove unused imports'), 'low');
    // "pushing" does not match \bpush\b (word boundary) — no false positive
    assert.equal(assessRisk('Pushing the boundaries of testing'), 'low');
  });
});
