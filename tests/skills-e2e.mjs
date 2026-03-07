import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

const repoRoot = process.cwd();
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;
let serverProcess = null;
let client = null;

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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function writeSkill(dir, name, description, body, frontmatter = []) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: ${description}`,
    ...frontmatter,
  ];
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n${body}\n`);
  return skillDir;
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

async function waitForHttp(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function httpGet(apiBase, route) {
  const resp = await fetch(`${apiBase}${route}`);
  return { status: resp.status, data: await resp.json() };
}

async function waitForTaskCompletion(client, matcher, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = Array.from(client.tasks.values()).find(matcher);
    if (task && (task.status === 'completed' || task.status === 'failed')) {
      return task;
    }
    await sleep(100);
  }
  return null;
}

function collectOutput(child, label) {
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) log(`${label}: ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) log(`${label} [stderr]: ${text}`);
  });
}

async function shutdownServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;

  await new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000).unref();
  });
}

try {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-skills-e2e-'));
  const primarySkillsDir = path.join(tmpRoot, 'skills');
  const extraSkillsDir = path.join(tmpRoot, 'openclaw-skills');
  const pathSkillRoot = path.join(tmpRoot, 'local-skill-source');
  const binDir = path.join(tmpRoot, 'bin');
  const dataDir = path.join(tmpRoot, 'data');

  fs.mkdirSync(primarySkillsDir, { recursive: true });
  fs.mkdirSync(extraSkillsDir, { recursive: true });
  fs.mkdirSync(pathSkillRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const weatherSourceDir = writeSkill(
    extraSkillsDir,
    'weather',
    'Weather research skill',
    'WEATHER_MARKER',
    ['executor: codex-cli'],
  );
  const localPathSkillDir = writeSkill(
    pathSkillRoot,
    'path-skill',
    'Path-installed skill',
    'PATH_MARKER',
    ['executor: codex-cli'],
  );

  const fakeCodexPath = path.join(binDir, 'codex');
  writeExecutable(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const prompt = args[args.length - 1] || '';
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'thread.started', thread_id: 'fake-session' });
emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
let content = 'generic-result';
if (prompt.includes('Respond with a JSON object')) {
  const userMessageMatch = prompt.match(/User message:\\s*([\\s\\S]*)$/);
  const userMessage = userMessageMatch ? userMessageMatch[1].trim() : '';
  if (/weather/i.test(userMessage)) {
    content = JSON.stringify({
      response: 'Checking weather now.',
      tasks: [{ prompt: userMessage }]
    });
  } else if (/path-skill/i.test(userMessage)) {
    content = JSON.stringify({
      response: 'Running path skill.',
      tasks: [{ prompt: userMessage }]
    });
  } else if (/remote-skill/i.test(userMessage)) {
    content = JSON.stringify({
      response: 'Running remote skill.',
      tasks: [{ prompt: userMessage }]
    });
  } else if (/terminal-skill/i.test(userMessage)) {
    content = JSON.stringify({
      response: 'Running terminal skill.',
      tasks: [{ prompt: userMessage }]
    });
  } else {
    content = JSON.stringify({ response: 'Okay.' });
  }
} else if (prompt.includes('WEATHER_MARKER')) {
  content = 'weather-skill-result';
} else if (prompt.includes('PATH_MARKER')) {
  content = 'path-skill-result';
} else if (prompt.includes('REMOTE_MARKER')) {
  content = 'remote-skill-result';
}
if (outputPath) fs.writeFileSync(outputPath, content);
`);

  const fakeClawhubPath = path.join(binDir, 'clawhub');
  writeExecutable(fakeClawhubPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let workdir = process.cwd();
let commandArgs = args;
if (args[0] === '--workdir' && args[1]) {
  workdir = path.resolve(args[1]);
  commandArgs = args.slice(2);
}
if (commandArgs[0] !== 'install' || !commandArgs[1]) {
  console.error('usage: clawhub install <slug>');
  process.exit(1);
}
const slug = commandArgs[1];
const skillDir = path.join(workdir, 'skills', slug);
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
  '---',
  'name: ' + slug,
  'description: Installed by fake clawhub',
  'executor: codex-cli',
  '---',
  'REMOTE_MARKER',
  ''
].join('\\n'));
`);

  const port = await getFreePort();
  const apiBase = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const workdir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'meridian.json'), JSON.stringify({
    provider: {
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-chat',
      apiKey: 'test',
      authHeader: false,
      models: [{ id: 'fake-model', contextWindow: 128000, maxTokens: 4096 }],
    },
    model: 'fake-model',
    port,
    dataDir,
    skillsDir: primarySkillsDir,
    extraSkillsDirs: [extraSkillsDir],
    codexCliPath: fakeCodexPath,
    doormanExecutor: 'codex-cli',
    toolExecutor: 'codex-cli',
    maxAgents: 2,
    agentTimeoutMs: 30000,
  }, null, 2));

  serverProcess = spawn(process.execPath, [distEntry], {
    cwd: workdir,
    env: {
      ...process.env,
      CHANNEL: 'cli',
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  collectOutput(serverProcess, 'meridian');

  serverProcess.once('exit', (code, signal) => {
    if (serverProcess) {
      log(`meridian exited unexpectedly: code=${code} signal=${signal}`);
    }
  });

  await waitForHttp(`${apiBase}/api/state`);
  client = new MeridianTestClient(wsUrl);
  await client.connect();
  fs.mkdirSync(path.join(workdir, '.clawhub'), { recursive: true });
  const meridianSkillCli = path.join(repoRoot, 'bin', 'meridian-skill');
  log('=== Skills E2E Test (5 cases) ===');

  await test('natural-language skill install resolves from configured extraSkillsDirs', async () => {
    const feedsBefore = client.feeds.length;
    client.send('please install the weather skill');

    const resp = await client.waitForFeed('doorman_response',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(resp.content.includes('Installed skill'), `Unexpected response: ${resp.content}`);
    assert.ok(resp.content.includes('from extra skills dir'), `Unexpected response: ${resp.content}`);

    const skillsResp = await httpGet(apiBase, '/api/skills');
    assert.equal(skillsResp.status, 200);
    const weather = skillsResp.data.find((skill) => skill.name === 'weather');
    assert.ok(weather, 'weather skill should be listed');
    assert.equal(weather.baseDir, path.join(primarySkillsDir, 'weather'));
    assert.equal(weather.eligibility.eligible, true);
    assert.equal(weather.install.source.kind, 'extra-skills-dir');
  });

  await test('installed skill is used by end-to-end task routing and execution', async () => {
    const feedsBefore = client.feeds.length;
    client.send('check weather in shanghai with the weather skill');

    const ack = await client.waitForFeed('doorman_response',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(ack.content.includes('weather'), `Unexpected ack: ${ack.content}`);

    const spawned = await client.waitForFeed('agent_spawned',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(spawned, 'should spawn an agent');

    const deadline = Date.now() + 10000;
    let runningAgent = null;
    while (Date.now() < deadline) {
      const task = Array.from(client.tasks.values()).find((entry) =>
        typeof entry.prompt === 'string' && entry.prompt.includes('weather')
      );
      runningAgent = Array.from(client.agents.values()).find((agent) => agent.currentTaskId === task?.id);
      if (runningAgent) break;
      await sleep(100);
    }
    assert.ok(runningAgent, 'should have a running agent for the weather task');
    assert.equal(runningAgent.executor, 'codex-cli');

    const result = await client.waitForFeed('agent_result',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(result.content.includes('weather-skill-result'), `Unexpected result: ${result.content}`);
  });

  await test('natural-language install accepts an absolute skill path', async () => {
    const feedsBefore = client.feeds.length;
    client.send(`please install skill "${localPathSkillDir}"`);

    const resp = await client.waitForFeed('doorman_response',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(resp.content.includes('path-skill'), `Unexpected response: ${resp.content}`);
    assert.ok(resp.content.includes('from local path'), `Unexpected response: ${resp.content}`);

    const skillsResp = await httpGet(apiBase, '/api/skills');
    const installed = skillsResp.data.find((skill) => skill.name === 'path-skill');
    assert.ok(installed, 'path-skill should be listed');
    assert.equal(installed.baseDir, path.join(primarySkillsDir, 'path-skill'));
    assert.equal(installed.install.source.kind, 'local-path');
  });

  await test('natural-language install falls back to the clawhub CLI when needed', async () => {
    const feedsBefore = client.feeds.length;
    client.send('please install the remote-skill skill');

    const resp = await client.waitForFeed('doorman_response',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(resp.content.includes('remote-skill'), `Unexpected response: ${resp.content}`);
    assert.ok(resp.content.includes('from ClawHub'), `Unexpected response: ${resp.content}`);

    const skillsResp = await httpGet(apiBase, '/api/skills');
    const installed = skillsResp.data.find((skill) => skill.name === 'remote-skill');
    assert.ok(installed, 'remote-skill should be listed');
    assert.equal(installed.baseDir, path.join(primarySkillsDir, 'remote-skill'));
    assert.equal(installed.install.source.kind, 'clawhub');
    assert.equal(installed.install.source.slug, 'remote-skill');
  });

  await test('terminal clawhub install writes into the Meridian workspace skills dir', async () => {
    const { stdout, stderr } = await execFileAsync(meridianSkillCli, ['install', 'terminal-skill', '--workdir', workdir, '--clawhub', fakeClawhubPath], {
      cwd: workdir,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    assert.ok(`${stdout}${stderr}`.includes('clawhub slug=terminal-skill'), `Unexpected CLI output: ${stdout}${stderr}`);

    const feedsBefore = client.feeds.length;
    client.send('use the terminal-skill skill right now');
    const ack = await client.waitForFeed('doorman_response',
      (feed) => client.feeds.indexOf(feed) >= feedsBefore, 10000);
    assert.ok(ack, 'Expected response for terminal-skill task');

    const completedTask = await waitForTaskCompletion(
      client,
      (task) => typeof task.prompt === 'string' && task.prompt.includes('terminal-skill'),
      10000,
    );
    assert.ok(completedTask, 'terminal-skill task should complete');

    const skillsResp = await httpGet(apiBase, '/api/skills');
    const installed = skillsResp.data.find((skill) => skill.name === 'terminal-skill');
    assert.ok(installed, 'terminal-skill should be listed after terminal install');
    assert.equal(installed.baseDir, path.join(primarySkillsDir, 'terminal-skill'));
    assert.equal(installed.install.source.kind, 'clawhub');
    assert.equal(installed.install.source.slug, 'terminal-skill');
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
} finally {
  client?.disconnect();
  await shutdownServer();
}
