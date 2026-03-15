import { Bot } from 'grammy';
import crypto from 'crypto';
import net from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Channel, OnInboundMessage, UserMessage, Attachment } from '../types.js';
import { saveMedia } from '../media.js';
import { logger } from '../logger.js';

/** Buffered media group: collects photos/docs with the same media_group_id */
interface MediaGroupBuffer {
  chatId: string;
  sender: string;
  caption: string;
  attachments: Attachment[];
  timestamp: string;
  timer: NodeJS.Timeout;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private onMessage: OnInboundMessage;
  private botToken: string;
  private chatId: string | null;
  private proxy: string | null;
  private mediaGroups = new Map<string, MediaGroupBuffer>();

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

    // Text messages
    this.bot.on('message:text', (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      const msg: UserMessage = {
        id: crypto.randomUUID(),
        channelId: `tg:${chatId}`,
        sender: this.getSenderName(ctx),
        content: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
      };

      this.onMessage(msg);
    });

    // Photo messages (single or media group)
    this.bot.on('message:photo', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      try {
        // Take largest photo size (last in array)
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const attachment = await this.downloadFile(photo.file_id, 'image/jpeg');

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
          this.bufferMediaGroup(mediaGroupId, {
            chatId,
            sender: this.getSenderName(ctx),
            caption: ctx.message.caption || '',
            attachment,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        } else {
          // Single photo
          this.onMessage({
            id: crypto.randomUUID(),
            channelId: `tg:${chatId}`,
            sender: this.getSenderName(ctx),
            content: ctx.message.caption || '',
            attachments: [attachment],
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
      }
    });

    // Document messages (PDF, Word, etc.)
    this.bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (this.chatId && chatId !== this.chatId) return;

      try {
        const doc = ctx.message.document;
        const contentType = doc.mime_type || 'application/octet-stream';
        const attachment = await this.downloadFile(doc.file_id, contentType, doc.file_name);

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
          this.bufferMediaGroup(mediaGroupId, {
            chatId,
            sender: this.getSenderName(ctx),
            caption: ctx.message.caption || '',
            attachment,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        } else {
          this.onMessage({
            id: crypto.randomUUID(),
            channelId: `tg:${chatId}`,
            sender: this.getSenderName(ctx),
            content: ctx.message.caption || '',
            attachments: [attachment],
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
          });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram document');
      }
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

  async sendMessage(text: string, targetChannelId?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = this.resolveTargetChatId(targetChannelId);
    if (!chatId) return;

    try {
      const html = markdownToTelegramHtml(text);
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

  /**
   * Download a file from Telegram by file_id, save to data/media/.
   */
  private async downloadFile(fileId: string, contentType: string, fileName?: string): Promise<Attachment> {
    if (!this.bot) throw new Error('Bot not connected');

    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram returned no file_path');

    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());

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
    item: { chatId: string; sender: string; caption: string; attachment: Attachment; timestamp: string },
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

    this.onMessage({
      id: crypto.randomUUID(),
      channelId: `tg:${group.chatId}`,
      sender: group.sender,
      content: group.caption,
      attachments: group.attachments,
      timestamp: group.timestamp,
    });
  }

  private resolveTargetChatId(targetChannelId?: string): string | null {
    if (!targetChannelId) return this.chatId;
    if (!targetChannelId.startsWith('tg:')) return null;
    return targetChannelId.slice(3);
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

function markdownToTelegramHtml(text: string): string {
  let html = escapeHtml(text);
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
