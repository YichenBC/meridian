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
      // Telegram 4096 char limit
      const MAX = 4096;
      if (text.length <= MAX) {
        await this.bot.api.sendMessage(this.chatId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX) {
          await this.bot.api.sendMessage(this.chatId, text.slice(i, i + MAX));
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
