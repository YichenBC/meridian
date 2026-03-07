import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

const { loadSkills } = await import('../dist/skills/loader.js');
const { installSkill } = await import('../dist/skills/install.js');
const { parseSkillInstallIntent, executeSkillInstallCommand } = await import('../dist/skills/commands.js');
const { prepareTaskContext } = await import('../dist/skills/context.js');
const { LLMExecutor } = await import('../dist/agents/executor.js');
const { ClaudeCodeExecutor } = await import('../dist/agents/claude-code-executor.js');
const { CodexCliExecutor } = await import('../dist/agents/codex-cli-executor.js');

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
  for (const [relativePath, content] of Object.entries(options.extraFiles || {})) {
    const filePath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return skillDir;
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

describe('skills support', () => {
  it('loads skills from Meridian and optional OpenClaw-style directories with Meridian precedence', () => {
    const primaryDir = makeTempDir('meridian-skills-primary-');
    const extraDir = makeTempDir('meridian-skills-extra-');
    const homeDir = makeTempDir('meridian-skills-home-');
    const previousHome = process.env.HOME;

    try {
      process.env.HOME = homeDir;
      fs.mkdirSync(path.join(homeDir, '.openclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.openclaw', 'openclaw.json'),
        JSON.stringify({
          skills: {
            entries: {
              'gated-skill': { apiKey: 'secret' },
              'disabled-skill': { enabled: false },
            },
          },
        }),
      );

      writeSkill(extraDir, 'weather', 'extra weather skill', 'Extra weather body');
      writeSkill(primaryDir, 'weather', 'primary weather skill', 'Primary weather body', {
        frontmatterExtra: [
          'metadata: { "openclaw": { "requires": { "bins": ["sh"] } } }',
        ],
      });
      writeSkill(primaryDir, 'local-only', 'local skill', 'Local body');
      writeSkill(extraDir, 'gated', 'gated skill', 'Gated body', {
        frontmatterExtra: [
          'metadata: { "openclaw": { "skillKey": "gated-skill", "primaryEnv": "GATED_KEY", "requires": { "env": ["GATED_KEY"] } } }',
        ],
      });
      writeSkill(extraDir, 'disabled', 'disabled skill', 'Disabled body', {
        frontmatterExtra: [
          'metadata: { "openclaw": { "skillKey": "disabled-skill" } }',
        ],
      });

      const skills = loadSkills(primaryDir, [extraDir]);
      assert.equal(skills.length, 4);

      const weather = skills.find((skill) => skill.name === 'weather');
      assert.ok(weather);
      assert.equal(weather.description, 'primary weather skill');
      assert.equal(weather.sourceDir, path.join(primaryDir, 'weather'));
      assert.equal(weather.eligibility.eligible, true);
      assert.equal(weather.eligibility.source, 'openclaw');

      const localOnly = skills.find((skill) => skill.name === 'local-only');
      assert.ok(localOnly);
      assert.equal(localOnly.sourceDir, path.join(primaryDir, 'local-only'));
      assert.equal(localOnly.eligibility.eligible, true);

      const gated = skills.find((skill) => skill.name === 'gated');
      assert.ok(gated);
      assert.equal(gated.eligibility.eligible, true);
      assert.ok(gated.eligibility.satisfied.includes('env:GATED_KEY'));

      const disabled = skills.find((skill) => skill.name === 'disabled');
      assert.ok(disabled);
      assert.equal(disabled.eligibility.eligible, false);
      assert.ok(disabled.eligibility.missing.includes('disabled:disabled-skill'));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('installs an OpenClaw-style skill into Meridian default skills directory', () => {
    const sourceRoot = makeTempDir('meridian-skill-install-source-');
    const targetRoot = makeTempDir('meridian-skill-install-target-');
    const sourceSkill = writeSkill(
      sourceRoot,
      'weather',
      'weather skill',
      'Use curl to fetch weather.',
      {
        extraFiles: {
          'manifest.yaml': 'skill: weather\nversion: 1.0.0\n',
          'scripts/check.sh': '#!/bin/sh\necho ok\n',
        },
      },
    );

    const installed = installSkill({
      sourcePath: sourceSkill,
      targetRoot,
      installMetadata: {
        installer: 'meridian',
        installedAt: new Date().toISOString(),
        source: {
          kind: 'local-path',
          reference: sourceSkill,
          resolvedPath: sourceSkill,
        },
      },
    });

    assert.equal(installed.name, 'weather');
    assert.ok(fs.existsSync(path.join(installed.targetPath, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(installed.targetPath, 'manifest.yaml')));
    assert.ok(fs.existsSync(path.join(installed.targetPath, 'scripts', 'check.sh')));

    const skills = loadSkills(targetRoot);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'weather');
    assert.equal(skills[0].install?.source.kind, 'local-path');
  });

  it('applies installed skills across llm, claude-code, and codex-cli executors', async () => {
    const tmpDir = makeTempDir('meridian-skill-executors-');
    const marker = 'SKILL_MARKER_123';
    const skill = {
      name: 'demo-skill',
      description: 'demo skill',
      content: `Always keep this marker in mind: ${marker}`,
      baseDir: tmpDir,
      sourceDir: tmpDir,
      eligibility: { eligible: true, missing: [], satisfied: [], source: 'none' },
    };

    const mockProvider = {
      async sendMessage() {
        throw new Error('not used');
      },
      async streamMessage(params) {
        return {
          content: params.system.includes(marker) ? 'llm-skill-ok' : 'llm-missing-skill',
          model: 'mock-model',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };

    const claudePath = path.join(tmpDir, 'fake-claude');
    writeExecutable(claudePath, `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1];
const content = prompt.includes(${JSON.stringify(marker)}) ? 'claude-skill-ok' : 'claude-missing-skill';
process.stdout.write(JSON.stringify({ result: content, session_id: 'claude-session' }));
`);

    const codexPath = path.join(tmpDir, 'fake-codex');
    writeExecutable(codexPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const prompt = args[args.length - 1];
const content = prompt.includes(${JSON.stringify(marker)}) ? 'codex-skill-ok' : 'codex-missing-skill';
if (outputPath) fs.writeFileSync(outputPath, content);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
`);

    const task = {
      id: 'task-1',
      prompt: 'Do the thing',
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepared = prepareTaskContext(task, skill);

    const llmResult = await new LLMExecutor(mockProvider, 'mock-model').execute({
      task,
      prepared,
      signal: new AbortController().signal,
      onProgress: () => {},
      requestApproval: async () => true,
    });
    assert.equal(llmResult.content, 'llm-skill-ok');

    const claudeResult = await new ClaudeCodeExecutor(claudePath).execute({
      task,
      prepared,
      signal: new AbortController().signal,
      onProgress: () => {},
      requestApproval: async () => true,
    });
    assert.equal(claudeResult.content, 'claude-skill-ok');

    const codexResult = await new CodexCliExecutor(codexPath).execute({
      task,
      prepared,
      signal: new AbortController().signal,
      onProgress: () => {},
      requestApproval: async () => true,
    });
    assert.equal(codexResult.content, 'codex-skill-ok');
  });

  it('supports natural-language skill install intents against local skill sources', async () => {
    const sourceRoot = makeTempDir('meridian-clawhub-source-');
    const targetRoot = makeTempDir('meridian-clawhub-target-');

    writeSkill(sourceRoot, 'weather', 'weather skill', 'Use curl to fetch weather.');

    const parsed = parseSkillInstallIntent('please install the weather skill');
    assert.deepEqual(parsed, { reference: 'weather' });
    assert.equal(parseSkillInstallIntent('clawhub install weather'), null);

    const installed = await executeSkillInstallCommand({
      reference: parsed.reference,
      targetRoot,
      extraSkillsDirs: [sourceRoot],
    });

    assert.equal(installed.length, 1);
    assert.equal(installed[0].name, 'weather');
    assert.equal(installed[0].installMetadata?.source.kind, 'extra-skills-dir');
    assert.ok(fs.existsSync(path.join(targetRoot, 'weather', 'SKILL.md')));

    const loaded = loadSkills(targetRoot);
    assert.equal(loaded[0].install?.source.kind, 'extra-skills-dir');
  });
});
