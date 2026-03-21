import { Bot, InputFile } from 'grammy';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Channel, OnInboundMessage, UserMessage, Attachment } from '../types.js';
import { saveMedia } from '../media.js';
import { logger } from '../logger.js';

/** Buffered media group: collects photos/docs with the same media_group_id */
interface MediaGroupBuffer {
  chatId: string;
  pmKey: string;       // pending media key (per-user in groups)
  channelId: string;   // full channelId including userId for groups
  sender: string;
  caption: string;
  attachments: Attachment[];
  timestamp: string;
  timer: NodeJS.Timeout;
}

/** Pending media: waiting for a follow-up text instruction before dispatching */
interface PendingMedia {
  chatId: string;
  sender: string;
  caption: string;
  attachments: Attachment[];
  timestamp: string;
  timer: NodeJS.Timeout;
}

const MEDIA_FOLLOWUP_MS = 300_000; // wait 5 minutes for follow-up text after media

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private onMessage: OnInboundMessage;
  private botToken: string;
  private chatId: string | null;
  private proxy: string | null;
  private mediaGroups = new Map<string, MediaGroupBuffer>();
  private pendingMedia = new Map<string, PendingMedia>(); // per-chat pending media waiting for follow-up text

  constructor(botToken: string, onMessage: OnInboundMessage, chatId?: string, proxy?: string) {
    this.botToken = botToken;
    this.onMessage = onMessage;
    this.chatId = chatId ?? null;
    this.proxy = proxy ?? null;
  }

  async connect(): Promise<void> {
    const effectiveProxy = await this.resolveProxy();
    const botConfig = effectiveProxy
      ? { client: { baseFetchConfig: { agent: new HttpsProxyAgent(effectiveProxy), compress: true } } }
      : undefined;
    this.bot = new Bot(this.botToken, botConfig);

    // /chatid command — useful for setup
    this.bot.command('chatid', (ctx) => {
      ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
    });

    // /ping command
    this.bot.command('ping', (ctx) => {
      ctx.reply('Meridian is online.');
    });

    // Debug: log ALL incoming messages to diagnose photo issues
    this.bot.on('message', (ctx, next) => {
      const m = ctx.message;
      logger.info({
        chatId: ctx.chat.id,
        msgId: m.message_id,
        hasText: !!m.text,
        hasPhoto: !!(m as any).photo,
        hasDocument: !!(m as any).document,
        hasCaption: !!m.caption,
        mediaGroupId: (m as any).media_group_id || null,
      }, 'Telegram message received (debug)');
      return next();
    });

    // Text messages — check for pending media to combine
    this.bot.on('message:text', (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const channelId = this.buildChannelId(ctx);
      const pmKey = this.pendingMediaKey(ctx);
      const messageId = ctx.message.message_id;

      // Extract reply-to context from the quoted message
      let content = ctx.message.text;
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const quoted = (reply.text || reply.caption || '').slice(0, 500);
        if (quoted) {
          const isBot = reply.from?.id === this.bot!.botInfo.id;
          const label = isBot ? 'Meridian' : (reply.from?.first_name || reply.from?.username || 'user');
          content = `[Replying to ${label}: "${quoted}"]\n\n${content}`;
          logger.info({ chatId, messageId, replyTo: reply.message_id, fromBot: isBot }, 'Injecting reply-to context');
        }
      }

      // Check if there's pending media waiting for a follow-up text instruction
      const pending = this.pendingMedia.get(pmKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMedia.delete(pmKey);
        logger.info({ chatId, pmKey, attachments: pending.attachments.length, text: content.slice(0, 80) },
          'Combining follow-up text with pending media');
        this.onMessage({
          id: crypto.randomUUID(),
          channelId,
          sender: this.getSenderName(ctx),
          content,
          attachments: pending.attachments,
          sourceMessageId: messageId,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
        });
        return;
      }

      this.onMessage({
        id: crypto.randomUUID(),
        channelId,
        sender: this.getSenderName(ctx),
        content,
        sourceMessageId: messageId,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
      });
    });

    // Photo messages (single or media group)
    this.bot.on('message:photo', async (ctx) => {
      logger.info({ chatId: ctx.chat.id, photoSizes: ctx.message.photo.length, caption: ctx.message.caption?.slice(0, 50) }, 'Received Telegram photo');
      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const channelId = this.buildChannelId(ctx);
      const pmKey = this.pendingMediaKey(ctx);

      try {
        // Take largest photo size (last in array)
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const attachment = await this.downloadFile(photo.file_id, 'image/jpeg');

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
          this.bufferMediaGroup(mediaGroupId, {
            chatId,
            pmKey,
            channelId,
            sender: this.getSenderName(ctx),
            caption: ctx.message.caption || '',
            attachment,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        } else {
          // Single photo: if has caption, dispatch immediately; otherwise wait for follow-up text
          const caption = ctx.message.caption || '';
          if (caption) {
            this.onMessage({
              id: crypto.randomUUID(),
              channelId,
              sender: this.getSenderName(ctx),
              content: caption,
              attachments: [attachment],
              sourceMessageId: ctx.message.message_id,
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
            });
          } else {
            this.enqueuePendingMedia(pmKey, chatId, this.getSenderName(ctx), [attachment],
              new Date(ctx.message.date * 1000).toISOString());
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
      }
    });

    // Document messages (PDF, Word, etc.)
    this.bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const channelId = this.buildChannelId(ctx);
      const pmKey = this.pendingMediaKey(ctx);

      try {
        const doc = ctx.message.document;
        const contentType = doc.mime_type || 'application/octet-stream';
        const attachment = await this.downloadFile(doc.file_id, contentType, doc.file_name);

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
          this.bufferMediaGroup(mediaGroupId, {
            chatId,
            pmKey,
            channelId,
            sender: this.getSenderName(ctx),
            caption: ctx.message.caption || '',
            attachment,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        } else {
          const caption = ctx.message.caption || '';
          if (caption) {
            this.onMessage({
              id: crypto.randomUUID(),
              channelId,
              sender: this.getSenderName(ctx),
              content: caption,
              attachments: [attachment],
              sourceMessageId: ctx.message.message_id,
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
            });
          } else {
            this.enqueuePendingMedia(pmKey, chatId, this.getSenderName(ctx), [attachment],
              new Date(ctx.message.date * 1000).toISOString());
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram document');
      }
    });

    // Voice messages — transcribe via Whisper API, then treat as text
    this.bot.on('message:voice', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const channelId = this.buildChannelId(ctx);
      const pmKey = this.pendingMediaKey(ctx);
      const messageId = ctx.message.message_id;

      try {
        const voice = ctx.message.voice;
        const attachment = await this.downloadFile(voice.file_id, 'audio/ogg', 'voice.ogg');

        const transcript = await this.transcribeVoice(attachment.path);
        if (transcript) {
          logger.info({ chatId, messageId, chars: transcript.length }, 'Voice transcribed');

          // Voice transcript consumes pending media (same as text)
          const pending = this.pendingMedia.get(pmKey);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingMedia.delete(pmKey);
            this.onMessage({
              id: crypto.randomUUID(),
              channelId,
              sender: this.getSenderName(ctx),
              content: transcript,
              attachments: pending.attachments,
              sourceMessageId: messageId,
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
            });
          } else {
            this.onMessage({
              id: crypto.randomUUID(),
              channelId,
              sender: this.getSenderName(ctx),
              content: `[voice transcript] ${transcript}`,
              sourceMessageId: messageId,
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
            });
          }
        } else {
          // STT unavailable — treat voice as audio attachment
          logger.info({ chatId, messageId }, 'Voice STT unavailable, treating as audio attachment');
          this.onMessage({
            id: crypto.randomUUID(),
            channelId,
            sender: this.getSenderName(ctx),
            content: '',
            attachments: [attachment],
            sourceMessageId: messageId,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to handle voice message');
      }
    });

    // Edited messages — cancel/replace the original task
    this.bot.on('edited_message:text', (ctx) => {
      const chatId = ctx.editedMessage.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const channelId = this.buildChannelId({ chat: ctx.editedMessage.chat, from: ctx.editedMessage.from });

      this.onMessage({
        id: crypto.randomUUID(),
        channelId,
        sender: ctx.editedMessage.from?.first_name || ctx.editedMessage.from?.username || 'Unknown',
        content: ctx.editedMessage.text,
        sourceMessageId: ctx.editedMessage.message_id,
        isEdit: true,
        timestamp: new Date(ctx.editedMessage.date * 1000).toISOString(),
      });
    });

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    await this.bot.init();
    logger.info({ username: this.bot.botInfo.username, id: this.bot.botInfo.id }, 'Telegram bot connected');
    this.bot.start({ drop_pending_updates: true });
  }

  async setTyping(active: boolean, targetChannelId?: string): Promise<void> {
    if (!this.bot || !active) return;
    const chatId = this.resolveTargetChatId(targetChannelId);
    if (!chatId) return;
    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch {
      // Typing indicator is best-effort
    }
  }

  async setReaction(messageId: number, emoji: string, targetChannelId?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = this.resolveTargetChatId(targetChannelId);
    if (!chatId) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji } as any]);
    } catch {
      // Reaction is best-effort — may fail if bot lacks permission or emoji unsupported
    }
  }

  async sendMessage(text: string, targetChannelId?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = this.resolveTargetChatId(targetChannelId);
    if (!chatId) return;

    try {
      // Extract image file paths from text and send them as photos
      const { cleanText, imagePaths } = this.extractImagePaths(text);

      for (const imgPath of imagePaths) {
        try {
          await this.bot.api.sendPhoto(chatId, new InputFile(imgPath));
          logger.info({ chatId, path: imgPath }, 'Telegram photo sent');
        } catch (err) {
          logger.error({ chatId, path: imgPath, err }, 'Failed to send Telegram photo');
        }
      }

      // Send remaining text if any
      const finalText = cleanText.trim();
      if (!finalText) return;

      const html = markdownToTelegramHtml(finalText);
      const MAX = 4096;
      const chunks = html.length <= MAX ? [html] : splitHtmlChunks(html, MAX);

      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
          logger.info({ chatId, length: chunk.length }, 'Telegram message sent');
        } catch {
          await this.bot.api.sendMessage(chatId, stripHtml(chunk));
          logger.info({ chatId, length: stripHtml(chunk).length }, 'Telegram message sent (plain text fallback)');
        }
      }
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Extract local image file paths from agent output text.
   * Agents may reference images as ![alt](path) or bare file paths.
   */
  private extractImagePaths(text: string): { cleanText: string; imagePaths: string[] } {
    const imagePaths: string[] = [];
    const imageExts = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

    // Match markdown images: ![...](/path/to/image.png)
    let cleanText = text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, path) => {
      if (imageExts.test(path) && fs.existsSync(path)) {
        imagePaths.push(path);
        return '';
      }
      return match;
    });

    // Match bare file paths on their own line: /path/to/image.png
    cleanText = cleanText.replace(/^(\/[^\s]+(?:\.png|\.jpg|\.jpeg|\.gif|\.webp))$/gim, (match, path) => {
      if (fs.existsSync(path)) {
        imagePaths.push(path);
        return '';
      }
      return match;
    });

    return { cleanText, imagePaths };
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  // --- Private helpers ---

  private getSenderName(ctx: any): string {
    return (
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown'
    );
  }

  /** Build channelId — includes userId for group chats to isolate per-user sessions */
  private buildChannelId(ctx: any): string {
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type; // 'private', 'group', 'supergroup', 'channel'
    if (chatType === 'group' || chatType === 'supergroup') {
      const userId = ctx.from?.id?.toString() || '0';
      return `tg:${chatId}:${userId}`;
    }
    return `tg:${chatId}`;
  }

  /** Key for pending media — per-user in groups, per-chat in private */
  private pendingMediaKey(ctx: any): string {
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      return `${chatId}:${ctx.from?.id || 0}`;
    }
    return chatId;
  }

  /**
   * Download a file from Telegram by file_id, save to data/media/.
   */
  private async downloadFile(fileId: string, contentType: string, fileName?: string): Promise<Attachment> {
    if (!this.bot) throw new Error('Bot not connected');

    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram returned no file_path');

    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    logger.info({ url: url.replace(this.botToken, '***'), fileId }, 'Downloading Telegram file');

    // Try with proxy first, fall back to direct (bypassing global proxy dispatcher)
    let response: Response;
    const undici = await import('undici');
    if (this.proxy) {
      try {
        response = await fetch(url, { dispatcher: new undici.ProxyAgent(this.proxy) } as any);
      } catch {
        logger.info({ fileId }, 'Proxy unavailable for file download, trying direct');
        // Use undici.fetch with a fresh Agent to bypass setGlobalDispatcher
        response = await (undici.fetch as typeof fetch)(url, { dispatcher: new undici.Agent() } as any);
      }
    } else {
      response = await fetch(url);
    }
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    logger.info({ fileId, size: buffer.length, contentType }, 'Telegram file downloaded');

    // Detect filename from file_path if not provided
    const name = fileName || file.file_path.split('/').pop() || undefined;

    return saveMedia(buffer, contentType, name);
  }

  /**
   * Buffer media group items (photos/docs sent together).
   * Telegram sends each item as a separate update with the same media_group_id.
   * We buffer for 500ms after the last item, then emit one UserMessage.
   */
  private bufferMediaGroup(
    mediaGroupId: string,
    item: { chatId: string; pmKey: string; channelId: string; sender: string; caption: string; attachment: Attachment; timestamp: string },
  ): void {
    const existing = this.mediaGroups.get(mediaGroupId);

    if (existing) {
      existing.attachments.push(item.attachment);
      // Use first non-empty caption
      if (!existing.caption && item.caption) {
        existing.caption = item.caption;
      }
      // Reset timer
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), 500);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), 500);
      this.mediaGroups.set(mediaGroupId, {
        chatId: item.chatId,
        pmKey: item.pmKey,
        channelId: item.channelId,
        sender: item.sender,
        caption: item.caption,
        attachments: [item.attachment],
        timestamp: item.timestamp,
        timer,
      });
    }
  }

  private flushMediaGroup(mediaGroupId: string): void {
    const group = this.mediaGroups.get(mediaGroupId);
    if (!group) return;
    this.mediaGroups.delete(mediaGroupId);

    logger.info({ mediaGroupId, count: group.attachments.length }, 'Flushing media group');

    // If media group has a caption, dispatch immediately.
    // If no caption, wait for follow-up text instruction.
    if (group.caption) {
      this.onMessage({
        id: crypto.randomUUID(),
        channelId: group.channelId,
        sender: group.sender,
        content: group.caption,
        attachments: group.attachments,
        timestamp: group.timestamp,
      });
    } else {
      this.enqueuePendingMedia(group.pmKey, group.chatId, group.sender, group.attachments, group.timestamp);
    }
  }

  /**
   * Enqueue media attachments waiting for a follow-up text instruction.
   * If no text arrives within MEDIA_FOLLOWUP_MS, discard and notify user.
   * @param pmKey  pending-media key (per-user in groups, per-chat in private)
   * @param chatId raw Telegram chat ID (for sending notifications)
   */
  private enqueuePendingMedia(pmKey: string, chatId: string, sender: string, attachments: Attachment[], timestamp: string): void {
    const existing = this.pendingMedia.get(pmKey);
    if (existing) {
      // Append to existing pending media
      clearTimeout(existing.timer);
      existing.attachments.push(...attachments);
    }

    const timer = setTimeout(() => {
      const pending = this.pendingMedia.get(pmKey);
      if (!pending) return;
      this.pendingMedia.delete(pmKey);
      const n = pending.attachments.length;
      logger.info({ chatId, pmKey, attachments: n }, 'Pending media expired (no follow-up text)');
      // Notify user instead of creating a task with empty prompt
      if (this.bot) {
        this.bot.api.sendMessage(Number(chatId),
          `${n} file${n > 1 ? 's' : ''} expired — no instruction received within ${MEDIA_FOLLOWUP_MS / 60_000} min. Send again with your instruction.`,
        ).catch(() => {});
      }
    }, MEDIA_FOLLOWUP_MS);

    if (existing) {
      existing.timer = timer;
    } else {
      this.pendingMedia.set(pmKey, { chatId, sender, caption: '', attachments, timestamp, timer });
    }

    const totalCount = existing ? existing.attachments.length : attachments.length;
    logger.info({ chatId, pmKey, attachments: totalCount },
      `Media queued — waiting ${MEDIA_FOLLOWUP_MS / 60_000} min for follow-up text`);

    // Notify user that media is buffered and awaiting instructions
    if (this.bot) {
      const label = totalCount === 1 ? '1 file received' : `${totalCount} files received`;
      this.bot.api.sendMessage(Number(chatId),
        `${label} — send me a text instruction to process ${totalCount > 1 ? 'them' : 'it'}.`,
      ).catch(() => {});
    }
  }

  private resolveTargetChatId(targetChannelId?: string): string | null {
    if (!targetChannelId) return this.chatId;
    if (!targetChannelId.startsWith('tg:')) return null;
    // Handle both tg:{chatId} and tg:{chatId}:{userId} — extract only chatId
    const rest = targetChannelId.slice(3);
    const colonIdx = rest.indexOf(':');
    return colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  }

  /**
   * Transcribe voice audio to text using OpenAI Whisper API.
   * Returns null if OPENAI_API_KEY is not set or transcription fails.
   */
  private async transcribeVoice(filePath: string): Promise<string | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.info('OPENAI_API_KEY not set — voice transcription unavailable');
      return null;
    }

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: 'audio/ogg' }), 'voice.ogg');
      formData.append('model', 'whisper-1');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      if (!response.ok) {
        logger.error({ status: response.status }, 'Whisper API transcription failed');
        return null;
      }

      const result = await response.json() as { text?: string };
      return result.text?.trim() || null;
    } catch (err) {
      logger.error({ err }, 'Voice transcription error');
      return null;
    }
  }

  private async resolveProxy(): Promise<string | null> {
    if (!this.proxy) return null;
    const reachable = await isProxyReachable(this.proxy);
    if (reachable) return this.proxy;
    logger.warn({ proxy: this.proxy }, 'Telegram proxy is unreachable; falling back to direct/default network path');
    return null;
  }
}

async function isProxyReachable(proxyUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return false;
  }

  const hostname = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (!hostname || !Number.isFinite(port) || port <= 0) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: 1500 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Convert markdown tables to scannable list format for Telegram readability.
 * Tables with 2 columns → key: value pairs; 3+ columns → indented entries per row.
 * Exported for testing.
 */
export function convertMarkdownTables(text: string): string {
  // Match markdown tables: header row, separator row, data rows
  const tableRe = /^(\|[^\n]+\|)\n(\|[\s:|-]+\|)\n((?:\|[^\n]+\|\n?)+)/gm;

  return text.replace(tableRe, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 3) return match; // need header + separator + at least 1 data row

    const parseRow = (line: string) =>
      line.split('|').slice(1, -1).map(cell => cell.trim());

    const headers = parseRow(lines[0]);
    // lines[1] is the separator row — skip it
    const rows = lines.slice(2).map(parseRow);

    if (headers.length === 0 || rows.length === 0) return match;

    if (headers.length === 2) {
      // Two-column table → compact key: value pairs
      return rows
        .filter(r => r.length >= 2)
        .map(r => `${r[0]}: ${r[1]}`)
        .join('\n') + '\n';
    }

    // 3+ column table → entry blocks with header labels
    return rows
      .filter(r => r.length >= headers.length)
      .map(r => {
        const firstCell = r[0];
        const rest = headers.slice(1)
          .map((h, i) => `  ${h}: ${r[i + 1]}`)
          .join('\n');
        return `${firstCell}\n${rest}`;
      })
      .join('\n\n') + '\n';
  });
}

function markdownToTelegramHtml(text: string): string {
  // Convert tables to lists before HTML conversion
  let processed = convertMarkdownTables(text);
  let html = escapeHtml(processed);
  html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  html = html.replace(/^[\s]*[-*]\s+/gm, '• ');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function splitHtmlChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}
