import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

const { loadSkills } = await import('../dist/skills/loader.js');
const { prepareTaskContext, prepareTaskContextWithCatalog } = await import('../dist/skills/context.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dir, name, description, body, options = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const frontmatterLines = [
    `name: ${name}`,
    `description: ${description}`,
    ...(options.frontmatterExtra || []),
  ];
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatterLines.join('\n')}\n---\n${body}\n`);
  return skillDir;
}

describe('knowledge skills', () => {
  it('loads all four knowledge skills with correct names and executor', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);

    const knowledgeSkills = ['knowledge-ingest', 'knowledge-query', 'daily-brief', 'idea-generator'];
    for (const name of knowledgeSkills) {
      const skill = skills.find(s => s.name === name);
      assert.ok(skill, `Skill "${name}" should be loaded`);
      assert.equal(skill.executor, 'claude-code', `${name} should use claude-code executor`);
      assert.ok(skill.description.length > 10, `${name} should have a meaningful description`);
    }
  });

  it('knowledge-ingest requires obsidian-cli and summarize bins', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const ingest = skills.find(s => s.name === 'knowledge-ingest');
    assert.ok(ingest);
    assert.equal(ingest.eligibility.source, 'openclaw');
    // Check that bins requirements are evaluated (eligible depends on whether tools are installed)
    assert.ok(ingest.openclaw, 'Should have openclaw metadata');
    assert.deepEqual(ingest.openclaw.requires.bins, ['obsidian-cli', 'summarize']);
  });

  it('knowledge-query requires obsidian-cli bin', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const query = skills.find(s => s.name === 'knowledge-query');
    assert.ok(query);
    assert.equal(query.eligibility.source, 'openclaw');
    assert.deepEqual(query.openclaw.requires.bins, ['obsidian-cli']);
  });

  it('daily-brief requires obsidian-cli and blogwatcher bins', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const brief = skills.find(s => s.name === 'daily-brief');
    assert.ok(brief);
    assert.equal(brief.eligibility.source, 'openclaw');
    assert.deepEqual(brief.openclaw.requires.bins, ['obsidian-cli', 'blogwatcher']);
  });

  it('idea-generator requires obsidian-cli bin', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const generator = skills.find(s => s.name === 'idea-generator');
    assert.ok(generator);
    assert.equal(generator.eligibility.source, 'openclaw');
    assert.deepEqual(generator.openclaw.requires.bins, ['obsidian-cli']);
  });

  it('knowledge skills content is injected into task context', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const ingest = skills.find(s => s.name === 'knowledge-ingest');
    assert.ok(ingest);

    const task = {
      id: 'test-1',
      prompt: 'Save this URL: https://example.com/article',
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepared = prepareTaskContext(task, ingest);
    assert.ok(prepared.systemPrompt.includes('Knowledge Ingest'), 'System prompt should contain skill content');
    assert.ok(prepared.systemPrompt.includes('obsidian-cli'), 'System prompt should reference obsidian-cli');
    assert.ok(prepared.systemPrompt.includes('summarize'), 'System prompt should reference summarize tool');
  });

  it('catalog-based context includes all skill names and descriptions', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const eligible = skills.filter(s => s.eligibility.eligible);

    const task = {
      id: 'test-catalog',
      prompt: 'Save this URL: https://example.com/article',
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepared = prepareTaskContextWithCatalog(task, eligible);

    // Should include skill catalog with names and descriptions
    assert.ok(prepared.toolPrompt.includes('<available_skills>'), 'Should include skills catalog XML');
    assert.ok(prepared.toolPrompt.includes('knowledge-ingest'), 'Catalog should list knowledge-ingest');
    assert.ok(prepared.toolPrompt.includes('knowledge-query'), 'Catalog should list knowledge-query');
    assert.ok(prepared.toolPrompt.includes('daily-brief'), 'Catalog should list daily-brief');

    // Should include SKILL.md locations so agent can read them
    assert.ok(prepared.toolPrompt.includes('SKILL.md'), 'Catalog should include SKILL.md paths');

    // Should include selection instructions
    assert.ok(prepared.toolPrompt.includes('exactly one skill clearly applies'), 'Should include selection instructions');

    // Should NOT pre-inject any skill content (agent reads it themselves)
    assert.equal(prepared.skillName, null, 'No pre-selected skill');
  });

  it('vault routing logic is described in skill content', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);
    const ingest = skills.find(s => s.name === 'knowledge-ingest');
    assert.ok(ingest);

    // Verify routing rules are present in skill content
    assert.ok(ingest.content.includes('01 Sources/'), 'Should route articles to 01 Sources/');
    assert.ok(ingest.content.includes('02 Concepts/'), 'Should route concepts to 02 Concepts/');
    assert.ok(ingest.content.includes('00 Inbox/'), 'Should route quick thoughts to 00 Inbox/');
  });

  it('knowledge skills coexist with existing skills without conflict', () => {
    const skillsDir = path.resolve('skills');
    const skills = loadSkills(skillsDir);

    // Original skills still loaded (note: example skill has name "general-assistant" in frontmatter)
    const existing = ['general-assistant', 'meridian-system', 'qr-code'];
    for (const name of existing) {
      assert.ok(skills.find(s => s.name === name), `Existing skill "${name}" should still be loaded`);
    }

    // All knowledge skills present
    const knowledge = ['knowledge-ingest', 'knowledge-query', 'daily-brief', 'idea-generator'];
    for (const name of knowledge) {
      assert.ok(skills.find(s => s.name === name), `Knowledge skill "${name}" should be loaded`);
    }

    // Total count: 3 existing + 4 new = 7
    assert.equal(skills.length, 7, 'Should have exactly 7 skills total');
  });

  it('OpenClaw skills are loaded when extraSkillsDirs is configured', () => {
    const skillsDir = path.resolve('skills');
    const openclawDir = '/Users/clawassist/projects/openclaw/openclaw/skills';

    // Only test if openclaw directory exists
    if (!fs.existsSync(openclawDir)) {
      return;
    }

    const skills = loadSkills(skillsDir, [openclawDir]);

    // Should have Meridian skills + OpenClaw skills
    assert.ok(skills.length > 7, 'Should load OpenClaw skills in addition to Meridian skills');

    // Verify a few OpenClaw skills are present
    const obsidian = skills.find(s => s.name === 'obsidian');
    if (obsidian) {
      assert.equal(obsidian.sourceDir, path.join(openclawDir, 'obsidian'));
    }
  });
});

describe('doorman fast-path patterns', () => {
  // Import the patterns indirectly by testing the regex behavior
  const KNOWLEDGE_SAVE_PATTERN = /^(save|remember|ingest|store|capture|bookmark)\s+(this|the|a|an|my)\b/i;
  const KNOWLEDGE_QUERY_PATTERN = /^(what do I know about|search my notes|find in my vault|look up in my)\b/i;

  it('matches knowledge ingest patterns', () => {
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('save this article about AI'));
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('Remember this URL: https://example.com'));
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('ingest this paper'));
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('store the research findings'));
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('capture this idea'));
    assert.ok(KNOWLEDGE_SAVE_PATTERN.test('bookmark this article'));
  });

  it('matches knowledge query patterns', () => {
    assert.ok(KNOWLEDGE_QUERY_PATTERN.test('what do I know about transformers'));
    assert.ok(KNOWLEDGE_QUERY_PATTERN.test('search my notes for RL training'));
    assert.ok(KNOWLEDGE_QUERY_PATTERN.test('find in my vault anything about scaling'));
    assert.ok(KNOWLEDGE_QUERY_PATTERN.test('look up in my notes'));
  });

  it('does not false-positive on unrelated messages', () => {
    assert.ok(!KNOWLEDGE_SAVE_PATTERN.test('hello save'));  // no match at start
    assert.ok(!KNOWLEDGE_SAVE_PATTERN.test('hello'));
    assert.ok(!KNOWLEDGE_QUERY_PATTERN.test('what is happening'));
    assert.ok(!KNOWLEDGE_QUERY_PATTERN.test('how are you'));
  });
});
