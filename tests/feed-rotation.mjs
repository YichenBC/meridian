import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach } from 'node:test';

const { initDatabase, addFeed, getFeeds, rotateFeeds } = await import('../dist/blackboard/db.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-feed-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

function makeFeed(i) {
  return {
    id: `feed-${i}`,
    type: 'system',
    source: 'test',
    content: `entry ${i}`,
    taskId: null,
    // Spread timestamps so ordering is deterministic
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  };
}

describe('Feed rotation', () => {
  beforeEach(() => freshDb());

  it('keeps all feeds when count is below limit', () => {
    for (let i = 0; i < 5; i++) addFeed(makeFeed(i));
    const deleted = rotateFeeds(10);
    assert.equal(deleted, 0);
    assert.equal(getFeeds(100).length, 5);
  });

  it('deletes oldest feeds when count exceeds limit', () => {
    for (let i = 0; i < 20; i++) addFeed(makeFeed(i));
    const deleted = rotateFeeds(10);
    assert.equal(deleted, 10);
    const remaining = getFeeds(100);
    assert.equal(remaining.length, 10);
    // Remaining should be the most recent (highest index)
    for (const entry of remaining) {
      const idx = parseInt(entry.id.split('-')[1]);
      assert.ok(idx >= 10, `Expected recent entry, got ${entry.id}`);
    }
  });

  it('handles rotation with keepCount of 0', () => {
    for (let i = 0; i < 5; i++) addFeed(makeFeed(i));
    const deleted = rotateFeeds(0);
    assert.equal(deleted, 5);
    assert.equal(getFeeds(100).length, 0);
  });

  it('is idempotent — second rotation deletes nothing', () => {
    for (let i = 0; i < 15; i++) addFeed(makeFeed(i));
    rotateFeeds(10);
    const deleted2 = rotateFeeds(10);
    assert.equal(deleted2, 0);
    assert.equal(getFeeds(100).length, 10);
  });
});
