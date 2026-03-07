import { Bot } from 'grammy';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Channel, OnInboundMessage, UserMessage } from '../types.js';
import { logger } from '../logger.js';

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private onMessage: OnInboundMessage;
  private botToken: string;
  private chatId: string | null;
  private proxy: string | null;

  constructor(botToken: string, onMessage: OnInboundMessage, chatId?: string, proxy?: string) {
    this.botToken = botToken;
    this.onMessage = onMessage;
    this.chatId = chatId ?? null;
    this.proxy = proxy ?? null;
  }

  async connect(): Promise<void> {
    const botConfig = this.proxy
      ? { client: { baseFetchConfig: { agent: new HttpsProxyAgent(this.proxy), compress: true } } }
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

      // If restricted to a specific chat, ignore others
      if (this.chatId && chatId !== this.chatId) return;

      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';

      const msg: UserMessage = {
        id: crypto.randomUUID(),
        channelId: `tg:${chatId}`,
        sender: senderName,
        content: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
      };

      this.onMessage(msg);
    });

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Init fetches bot info, start begins long polling
    await this.bot.init();
    logger.info({ username: this.bot.botInfo.username, id: this.bot.botInfo.id }, 'Telegram bot connected');
    this.bot.start({ drop_pending_updates: true });
  }

  async setTyping(active: boolean): Promise<void> {
    if (!this.bot || !this.chatId || !active) return;
    try {
      await this.bot.api.sendChatAction(this.chatId, 'typing');
    } catch {
      // Typing indicator is best-effort
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;

    try {
      const html = markdownToTelegramHtml(text);
      const MAX = 4096;
      const chunks = html.length <= MAX ? [html] : splitHtmlChunks(html, MAX);

      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(this.chatId, chunk, { parse_mode: 'HTML' });
          logger.info({ chatId: this.chatId, length: chunk.length }, 'Telegram message sent');
        } catch {
          // Fallback: send as plain text if HTML parsing fails
          await this.bot.api.sendMessage(this.chatId, stripHtml(chunk));
          logger.info({ chatId: this.chatId, length: stripHtml(chunk).length }, 'Telegram message sent (plain text fallback)');
        }
      }
    } catch (err) {
      logger.error({ chatId: this.chatId, err }, 'Failed to send Telegram message');
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
}

/**
 * Convert common markdown to Telegram-supported HTML.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a>, <s>, <u>
 */
function markdownToTelegramHtml(text: string): string {
  let html = escapeHtml(text);

  // Code blocks: ```lang\ncode\n``` → <pre>code</pre>
  html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, '<pre>$1</pre>');

  // Inline code: `code` → <code>code</code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words like file_name)
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Headers: # Title → <b>Title</b> (Telegram has no headers)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bullet lists: - item or * item → • item
  html = html.replace(/^[\s]*[-*]\s+/gm, '• ');

  // Links: [text](url) → <a href="url">text</a>
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
