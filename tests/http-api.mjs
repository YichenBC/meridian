import assert from 'node:assert/strict';
import http from 'http';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';

// We test the HttpServer directly by constructing it with a mock blackboard/doorman/runner.
// This avoids needing a full Meridian instance.

const { initDatabase } = await import('../dist/blackboard/db.js');
const { Blackboard } = await import('../dist/blackboard/blackboard.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-http-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

function fetch(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Minimal mock for Doorman and Runner — we only test HTTP routes
class MockDoorman {
  async handleMessage() { return { response: 'ok' }; }
}

class MockRunner {
  getSkills() { return []; }
  reloadSkills() {}
}

describe('HTTP API', () => {
  let blackboard, server, port;

  beforeEach(async () => {
    freshDb();
    blackboard = new Blackboard(
      path.join(os.tmpdir(), `meridian-http-bb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    );

    // Dynamically import HttpServer and temporarily patch config
    const { config } = await import('../dist/config.js');
    // Find a free port
    port = 10000 + Math.floor(Math.random() * 50000);
    config.port = port;
    config.apiToken = undefined;

    const { HttpServer } = await import('../dist/doorman/http-server.js');
    server = new HttpServer(blackboard, new MockDoorman(), new MockRunner());
    await server.start();
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('GET /health returns status and uptime', async () => {
    const res = await fetch(port, '/health');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, 'ok');
    assert.ok(typeof data.uptime === 'number');
    assert.ok('tasks' in data);
    assert.ok('agents' in data);
  });

  it('GET /api/state returns blackboard state', async () => {
    const res = await fetch(port, '/api/state');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.tasks));
    assert.ok(Array.isArray(data.agents));
  });

  it('GET /api/skills returns empty array from mock', async () => {
    const res = await fetch(port, '/api/skills');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/tasks creates a task', async () => {
    const res = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test task', role: 'general' }),
    });
    assert.equal(res.status, 201);
    const data = res.json();
    assert.ok(data.id);
    assert.equal(data.status, 'pending');
  });

  it('POST /api/tasks with DAG fields', async () => {
    // Create a root task first
    const r1 = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'root', role: 'general' }),
    });
    const rootId = r1.json().id;

    const res = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'child', blockedBy: [rootId], priority: 5 }),
    });
    assert.equal(res.status, 201);
  });

  it('POST /api/tasks rejects missing prompt', async () => {
    const res = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'general' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/notes creates a note', async () => {
    const res = await fetch(port, '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', content: 'body', tags: 'test' }),
    });
    assert.equal(res.status, 201);
    const data = res.json();
    assert.ok(data.id);
  });

  it('GET /api/notes returns notes', async () => {
    // Create a note first
    await fetch(port, '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', content: 'body' }),
    });
    const res = await fetch(port, '/api/notes');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 1);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(port, '/api/nonexistent');
    assert.equal(res.status, 404);
  });
});

describe('HTTP API auth', () => {
  let blackboard, server, port;

  beforeEach(async () => {
    freshDb();
    blackboard = new Blackboard(
      path.join(os.tmpdir(), `meridian-http-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    );

    const { config } = await import('../dist/config.js');
    port = 10000 + Math.floor(Math.random() * 50000);
    config.port = port;
    config.apiToken = 'test-secret-token';

    const { HttpServer } = await import('../dist/doorman/http-server.js');
    server = new HttpServer(blackboard, new MockDoorman(), new MockRunner());
    await server.start();
  });

  afterEach(async () => {
    if (server) await server.stop();
    // Reset token so other test suites aren't affected
    const { config } = await import('../dist/config.js');
    config.apiToken = undefined;
  });

  it('GET /health does not require auth', async () => {
    const res = await fetch(port, '/health');
    assert.equal(res.status, 200);
  });

  it('GET /api/state requires auth', async () => {
    const res = await fetch(port, '/api/state');
    assert.equal(res.status, 401);
  });

  it('GET /api/state with wrong token returns 401', async () => {
    const res = await fetch(port, '/api/state', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/state with correct token returns 200', async () => {
    const res = await fetch(port, '/api/state', {
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    assert.equal(res.status, 200);
  });

  it('POST /api/tasks requires auth', async () => {
    const res = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/tasks with correct token works', async () => {
    const res = await fetch(port, '/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-token',
      },
      body: JSON.stringify({ prompt: 'authed task' }),
    });
    assert.equal(res.status, 201);
  });
});
