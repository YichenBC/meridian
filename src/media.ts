import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Attachment } from './types.js';
import { config } from './config.js';
import { logger } from './logger.js';

const MEDIA_DIR = path.join(config.dataDir, 'media');

const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/markdown': '.md',
};

/**
 * Save a media buffer to disk and return an Attachment.
 */
export function saveMedia(
  buffer: Buffer,
  contentType: string,
  originalFilename?: string,
): Attachment {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const ext = originalFilename
    ? path.extname(originalFilename)
    : (EXT_MAP[contentType] || '');
  const id = crypto.randomUUID().slice(0, 12);
  const safeName = originalFilename
    ? originalFilename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_')
    : id;
  const filename = `${safeName}---${id}${ext}`;
  const filePath = path.join(MEDIA_DIR, filename);

  fs.writeFileSync(filePath, buffer, { mode: 0o600 });

  logger.info({ path: filePath, contentType, size: buffer.length }, 'Media saved');

  return {
    path: filePath,
    contentType,
    fileName: originalFilename,
    size: buffer.length,
  };
}

/**
 * Delete media files older than maxAgeMs (default 24h).
 */
export function cleanupOldMedia(maxAgeMs = 24 * 60 * 60 * 1000): number {
  if (!fs.existsSync(MEDIA_DIR)) return 0;

  const now = Date.now();
  let deleted = 0;

  for (const file of fs.readdirSync(MEDIA_DIR)) {
    const filePath = path.join(MEDIA_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      // ignore
    }
  }

  if (deleted > 0) {
    logger.info({ deleted }, 'Old media files cleaned up');
  }
  return deleted;
}

/**
 * Format attachments into prompt text for the agent (OpenClaw pattern).
 */
export function formatAttachmentsPrompt(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';

  if (attachments.length === 1) {
    const a = attachments[0];
    const name = a.fileName ? ` "${a.fileName}"` : '';
    return `[media attached:${name} ${a.path} (${a.contentType})]`;
  }

  const lines = [`[media attached: ${attachments.length} files]`];
  attachments.forEach((a, i) => {
    const name = a.fileName ? ` "${a.fileName}"` : '';
    lines.push(`[media ${i + 1}/${attachments.length}:${name} ${a.path} (${a.contentType})]`);
  });
  return lines.join('\n');
}
