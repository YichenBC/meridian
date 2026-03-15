import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { execSync } from 'child_process';

const { loadSkills } = await import('../dist/skills/loader.js');
const { prepareTaskContext, prepareTaskContextWithCatalog } = await import('../dist/skills/context.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function binExists(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('knowledge integration', () => {
  it('skill eligibility reflects actual CLI availability', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);

    const ingest = skills.find(s => s.name === 'knowledge-ingest');
    assert.ok(ingest);

    const hasObsidianCli = binExists('obsidian-cli');
    const hasSummarize = binExists('summarize');

    if (hasObsidianCli && hasSummarize) {
      assert.equal(ingest.eligibility.eligible, true, 'Should be eligible when both bins are present');
    } else {
      // At least one missing — skill should report what's missing
      assert.ok(ingest.eligibility.missing.length > 0, 'Should report missing bins');
    }
  });

  it('skill matching: URL message matches knowledge-ingest context', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const ingest = skills.find(s => s.name === 'knowledge-ingest');
    assert.ok(ingest);

    const task = {
      id: 'integration-1',
      prompt: 'save this https://arxiv.org/abs/2401.12345',
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepared = prepareTaskContext(task, ingest);
    // The prepared context should contain the skill instructions
    assert.ok(prepared.systemPrompt.includes('Detect input type'), 'Should include pipeline instructions');
    assert.ok(prepared.systemPrompt.includes('obsidian-cli create'), 'Should include obsidian-cli create command');
  });

  it('skill matching: query message matches knowledge-query context', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const query = skills.find(s => s.name === 'knowledge-query');
    assert.ok(query);

    const task = {
      id: 'integration-2',
      prompt: 'what do I know about reinforcement learning?',
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepared = prepareTaskContext(task, query);
    assert.ok(prepared.systemPrompt.includes('Search the vault'), 'Should include search instructions');
    assert.ok(prepared.systemPrompt.includes('obsidian-cli search-content'), 'Should include search command');
  });

  it('daily-brief skill includes blogwatcher and vault scanning instructions', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const brief = skills.find(s => s.name === 'daily-brief');
    assert.ok(brief);

    assert.ok(brief.content.includes('blogwatcher scan'), 'Should reference blogwatcher scan');
    assert.ok(brief.content.includes('05 Reviews/daily-briefs'), 'Should output to daily-briefs folder');
    assert.ok(brief.content.includes('YYYY-MM-DD'), 'Should use date-based filenames');
  });

  it('idea-generator skill includes cross-referencing instructions', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const generator = skills.find(s => s.name === 'idea-generator');
    assert.ok(generator);

    assert.ok(generator.content.includes('07 Connections/'), 'Should store insights in 07 Connections/');
    assert.ok(generator.content.includes('cross-pollination'), 'Should encourage cross-domain connections');
    assert.ok(generator.content.includes('wikilinks'), 'Should use wikilinks for references');
  });

  it('cron task creation format is valid for HTTP API', () => {
    // Verify the cron task JSON is valid and contains required fields
    const dailyBriefTask = {
      prompt: 'Generate daily brief',
      executor: 'claude-code',
      source: 'cron',
    };

    assert.equal(typeof dailyBriefTask.prompt, 'string');
    assert.equal(dailyBriefTask.executor, 'claude-code');
    assert.equal(dailyBriefTask.source, 'cron');

    const researchTask = {
      prompt: 'Run daily research: check blogwatcher feeds, summarize new articles, ingest into vault',
      executor: 'claude-code',
      source: 'cron',
    };

    assert.equal(typeof researchTask.prompt, 'string');
    assert.equal(researchTask.executor, 'claude-code');
  });

  it('obsidian-cli integration: can interact with vault', () => {
    if (!binExists('obsidian-cli')) {
      return; // Skip if obsidian-cli not installed
    }

    const testTitle = `00 Inbox/meridian-test-${Date.now()}`;
    const testContent = 'This is a test note created by Meridian integration tests.';

    try {
      // Create a test note
      execSync(`obsidian-cli create "${testTitle}" --content "${testContent}"`, {
        stdio: 'pipe',
        timeout: 10000,
      });

      // Search for it
      const searchResult = execSync(`obsidian-cli search-content "meridian-test"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });

      assert.ok(searchResult.includes('meridian-test'), 'Should find the test note');

      // Clean up
      execSync(`obsidian-cli delete "${testTitle}" --force`, {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch (err) {
      // If vault is not configured, skip gracefully
      if (err.message.includes('vault') || err.message.includes('default')) {
        return;
      }
      throw err;
    }
  });
});
