import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log, sleep } from './lib/helpers.mjs';

const execFileAsync = promisify(execFile);
const clawhubPath = process.env.CLAWHUB_PATH || 'clawhub';
const slug = process.env.CLAWHUB_LIVE_SLUG || 'weather';
const meridianSkillCli = path.join(process.cwd(), 'bin', 'meridian-skill');

let passed = 0;
let failed = 0;
let downloadedSkillPath = null;

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

async function runClawhub(args, cwd) {
  const { stdout, stderr } = await execFileAsync(clawhubPath, args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
    timeout: 45000,
  });
  return `${stdout}${stderr}`;
}

async function runClawhubWithRetry(args, cwd, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await runClawhub(args, cwd);
    } catch (err) {
      lastError = err;
      const stderr = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (!/timeout|rate limit exceeded/i.test(stderr) || attempt === retries) {
        throw err;
      }
      log(`clawhub ${args.join(' ')} failed on attempt ${attempt}/${retries}; retrying...`);
      await sleep(3000 * attempt);
    }
  }
  throw lastError;
}

async function installWithRetry(workdir, retries = 8) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await runClawhub(['--workdir', workdir, 'install', slug, '--no-input', '--force'], workdir);
    } catch (err) {
      lastError = err;
      const stderr = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (!/rate limit exceeded/i.test(stderr) || attempt === retries) {
        throw err;
      }
      log(`Install rate-limited on attempt ${attempt}/${retries}; retrying...`);
      await sleep(5000 * attempt);
    }
  }
  throw lastError;
}

async function runMeridianSkillWithRetry(workdir, retries = 6) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await execFileAsync(
        meridianSkillCli,
        ['install', slug, '--workdir', workdir, '--clawhub', clawhubPath, '--overwrite'],
        {
          cwd: workdir,
          env: process.env,
          maxBuffer: 1024 * 1024 * 10,
          timeout: 180000,
        },
      );
    } catch (err) {
      lastError = err;
      const stderr = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (!/rate limit exceeded/i.test(stderr) || attempt === retries) {
        throw err;
      }
      log(`Meridian skill install rate-limited on attempt ${attempt}/${retries}; retrying...`);
      await sleep(5000 * attempt);
    }
  }
  throw lastError;
}

try {
  log(`=== ClawHub Live Test (${slug}) ===`);

  await test('clawhub is authenticated', async () => {
    const output = await runClawhubWithRetry(['whoami'], process.cwd());
    assert.ok(output.includes('Checking token') || output.trim().length > 0, 'Expected whoami output');
    assert.ok(!/not logged in|unauthorized|invalid token/i.test(output), `Unexpected whoami output: ${output}`);
  });

  await test('clawhub inspect fetches live registry metadata', async () => {
    const output = await runClawhubWithRetry(['inspect', slug, '--no-input'], process.cwd());
    assert.ok(new RegExp(`^${slug}\\b`, 'mi').test(output), `Expected slug in inspect output: ${output}`);
    assert.ok(/Summary:|Latest:/i.test(output), `Expected metadata fields in inspect output: ${output}`);
  });

  await test('clawhub install downloads a live skill into a temp workspace', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-clawhub-live-'));
    fs.mkdirSync(path.join(workdir, '.clawhub'), { recursive: true });
    const output = await installWithRetry(workdir);
    const skillMd = path.join(workdir, 'skills', slug, 'SKILL.md');

    assert.ok(/Installing|Installed|Resolving/i.test(output), `Unexpected install output: ${output}`);
    assert.ok(fs.existsSync(skillMd), `Expected installed SKILL.md at ${skillMd}. Install output:\n${output}`);
    downloadedSkillPath = path.join(workdir, 'skills', slug);
  });

  await test('meridian-skill install copies a real ClawHub-downloaded skill into Meridian skillsDir', async () => {
    assert.ok(downloadedSkillPath, 'Expected a downloaded skill path from the live clawhub install test');
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-skill-live-'));
    const skillsDir = path.join(workdir, 'skills');
    fs.writeFileSync(path.join(workdir, 'meridian.json'), JSON.stringify({
      skillsDir,
      extraSkillsDirs: [],
    }, null, 2));

    const { stdout, stderr } = await execFileAsync(
      meridianSkillCli,
      ['install', downloadedSkillPath, '--workdir', workdir, '--clawhub', clawhubPath],
      {
        cwd: workdir,
        env: process.env,
        maxBuffer: 1024 * 1024 * 10,
      },
    );

    const combined = `${stdout}${stderr}`;
    const skillMd = path.join(skillsDir, slug, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), `Expected Meridian-installed skill at ${skillMd}. Output:\n${combined}`);
    assert.ok(combined.includes(`path=${downloadedSkillPath}`), `Expected source path in CLI output: ${combined}`);

    const installMetaPath = path.join(skillsDir, slug, '.meridian-skill.json');
    assert.ok(fs.existsSync(installMetaPath), `Expected install metadata at ${installMetaPath}`);
    const installMeta = JSON.parse(fs.readFileSync(installMetaPath, 'utf-8'));
    assert.equal(installMeta.installer, 'meridian');
    assert.equal(installMeta.source.kind, 'local-path');
    assert.equal(installMeta.source.reference, downloadedSkillPath);
  });

  await test('meridian-skill install <slug> downloads from ClawHub and records provenance', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-skill-live-remote-'));
    const skillsDir = path.join(workdir, 'skills');
    fs.writeFileSync(path.join(workdir, 'meridian.json'), JSON.stringify({
      skillsDir,
      extraSkillsDirs: [],
    }, null, 2));

    const { stdout, stderr } = await runMeridianSkillWithRetry(workdir);
    const combined = `${stdout}${stderr}`;
    const skillMd = path.join(skillsDir, slug, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), `Expected Meridian-installed skill at ${skillMd}. Output:\n${combined}`);
    assert.ok(combined.includes(`clawhub slug=${slug}`), `Expected ClawHub provenance in CLI output: ${combined}`);

    const installMetaPath = path.join(skillsDir, slug, '.meridian-skill.json');
    assert.ok(fs.existsSync(installMetaPath), `Expected install metadata at ${installMetaPath}`);
    const installMeta = JSON.parse(fs.readFileSync(installMetaPath, 'utf-8'));
    assert.equal(installMeta.installer, 'meridian');
    assert.equal(installMeta.source.kind, 'clawhub');
    assert.equal(installMeta.source.slug, slug);
    assert.equal(installMeta.source.downloadedVia, 'clawhub');
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
}
