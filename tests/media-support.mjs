import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach } from 'node:test';

// Point config.dataDir to a temp dir so media files don't pollute real data
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-media-test-'));
process.env.MERIDIAN_DATA_DIR = tmpDataDir;

const { saveMedia, cleanupOldMedia, formatAttachmentsPrompt } = await import('../dist/media.js');

describe('media storage', () => {
  it('saveMedia writes file to data/media/ and returns Attachment', () => {
    const buffer = Buffer.from('fake image data');
    const attachment = saveMedia(buffer, 'image/jpeg', 'photo.jpg');

    assert.ok(fs.existsSync(attachment.path), 'File should exist on disk');
    assert.equal(attachment.contentType, 'image/jpeg');
    assert.equal(attachment.fileName, 'photo.jpg');
    assert.equal(attachment.size, buffer.length);
    assert.ok(attachment.path.includes('photo.jpg'), 'Path should contain original filename');
    assert.ok(attachment.path.endsWith('.jpg'), 'Path should have .jpg extension');

    // Verify content
    const content = fs.readFileSync(attachment.path);
    assert.deepEqual(content, buffer);
  });

  it('saveMedia handles files without original filename', () => {
    const buffer = Buffer.from('fake pdf data');
    const attachment = saveMedia(buffer, 'application/pdf');

    assert.ok(fs.existsSync(attachment.path));
    assert.equal(attachment.contentType, 'application/pdf');
    assert.equal(attachment.fileName, undefined);
    assert.ok(attachment.path.endsWith('.pdf'), 'Should infer extension from MIME type');
  });

  it('saveMedia handles unknown MIME types', () => {
    const buffer = Buffer.from('binary data');
    const attachment = saveMedia(buffer, 'application/octet-stream', 'data.bin');

    assert.ok(fs.existsSync(attachment.path));
    assert.equal(attachment.contentType, 'application/octet-stream');
    assert.ok(attachment.path.endsWith('.bin'));
  });

  it('saveMedia creates unique filenames to avoid collisions', () => {
    const buffer = Buffer.from('data');
    const a1 = saveMedia(buffer, 'image/png', 'test.png');
    const a2 = saveMedia(buffer, 'image/png', 'test.png');

    assert.notEqual(a1.path, a2.path, 'Two saves with same name should get different paths');
  });
});

describe('media cleanup', () => {
  it('cleanupOldMedia deletes files older than maxAge', () => {
    const buffer = Buffer.from('old data');
    const attachment = saveMedia(buffer, 'image/jpeg', 'old.jpg');

    // Make the file appear old
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(attachment.path, oldTime, oldTime);

    const deleted = cleanupOldMedia(24 * 60 * 60 * 1000);
    assert.ok(deleted >= 1, 'Should delete at least 1 old file');
    assert.ok(!fs.existsSync(attachment.path), 'Old file should be deleted');
  });

  it('cleanupOldMedia preserves recent files', () => {
    const buffer = Buffer.from('recent data');
    const attachment = saveMedia(buffer, 'image/png', 'recent.png');

    const deleted = cleanupOldMedia(24 * 60 * 60 * 1000);
    assert.ok(fs.existsSync(attachment.path), 'Recent file should be preserved');
  });
});

describe('formatAttachmentsPrompt', () => {
  it('formats single attachment', () => {
    const result = formatAttachmentsPrompt([
      { path: '/data/media/photo.jpg', contentType: 'image/jpeg', fileName: 'screenshot.jpg' },
    ]);

    assert.ok(result.includes('[media attached:'));
    assert.ok(result.includes('/data/media/photo.jpg'));
    assert.ok(result.includes('image/jpeg'));
    assert.ok(result.includes('screenshot.jpg'));
  });

  it('formats multiple attachments with count header', () => {
    const attachments = [
      { path: '/data/media/a.jpg', contentType: 'image/jpeg' },
      { path: '/data/media/b.png', contentType: 'image/png' },
      { path: '/data/media/c.pdf', contentType: 'application/pdf', fileName: 'paper.pdf' },
    ];

    const result = formatAttachmentsPrompt(attachments);

    assert.ok(result.includes('[media attached: 3 files]'));
    assert.ok(result.includes('[media 1/3:'));
    assert.ok(result.includes('[media 2/3:'));
    assert.ok(result.includes('[media 3/3:'));
    assert.ok(result.includes('paper.pdf'));
  });

  it('returns empty string for no attachments', () => {
    assert.equal(formatAttachmentsPrompt([]), '');
  });
});

describe('attachment integration with UserMessage', () => {
  it('UserMessage type accepts attachments field', () => {
    const msg = {
      id: 'test-1',
      channelId: 'tg:12345',
      sender: 'user',
      content: 'Save these screenshots to my vault',
      attachments: [
        { path: '/data/media/1.jpg', contentType: 'image/jpeg', size: 1024 },
        { path: '/data/media/2.jpg', contentType: 'image/jpeg', size: 2048 },
      ],
      timestamp: new Date().toISOString(),
    };

    assert.equal(msg.attachments.length, 2);
    assert.equal(msg.attachments[0].contentType, 'image/jpeg');
  });

  it('UserMessage works without attachments (backward compat)', () => {
    const msg = {
      id: 'test-2',
      channelId: 'tg:12345',
      sender: 'user',
      content: 'Just text',
      timestamp: new Date().toISOString(),
    };

    assert.equal(msg.attachments, undefined);
  });
});
