import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import crypto from 'crypto';
import { Channel, OnInboundMessage, UserMessage } from '../types.js';
import { logger } from '../logger.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private onMessage: OnInboundMessage;
  private config: FeishuConfig;
  private seenMessages = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 30 * 60 * 1000;
  private lastChatId: string | null = null;
  private lastMessageId: string | null = null;
  private typingReactionId: string | null = null;

  constructor(feishuConfig: FeishuConfig, onMessage: OnInboundMessage) {
    this.config = feishuConfig;
    this.onMessage = onMessage;
    // Disable env-var proxy for Lark Client (http_proxy causes HTTPS issues)
    const clientHttp = axios.create({ proxy: false });
    clientHttp.interceptors.request.use((req) => {
      if (req.headers) req.headers['User-Agent'] = 'oapi-node-sdk/1.0.0';
      return req;
    });
    clientHttp.interceptors.response.use((resp) => {
      if (resp.config.headers?.['$return_headers']) {
        return { data: resp.data, headers: resp.headers };
      }
      return resp.data;
    });

    this.client = new Lark.Client({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      httpInstance: clientHttp,
    } as any);
  }

  async connect(): Promise<void> {
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: this.config.encryptKey,
      verificationToken: this.config.verificationToken,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          this.handleMessageEvent(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu message event');
        }
      },
    });

    // The Lark SDK's axios picks up http_proxy/https_proxy env vars, which can
    // cause "plain HTTP request sent to HTTPS port" errors. Create a no-proxy
    // axios instance with the SDK's expected interceptors.
    const httpInstance = axios.create({ proxy: false });
    httpInstance.interceptors.request.use((req) => {
      if (req.headers) req.headers['User-Agent'] = 'oapi-node-sdk/1.0.0';
      return req;
    });
    httpInstance.interceptors.response.use((resp) => resp.data);

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      httpInstance,
    } as any);

    await this.wsClient.start({ eventDispatcher });
    logger.info('Feishu bot connected via WebSocket');
  }

  private handleMessageEvent(data: any): void {
    const message = data?.message;
    if (!message) return;

    const messageId = message.message_id;
    logger.debug({ messageId, chatId: message.chat_id, type: message.message_type }, 'Feishu event received');

    // Deduplicate — Feishu may deliver the same event multiple times
    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) {
      this.seenMessages.set(messageId, Date.now());
      this.pruneDedup();
    }

    // Handle text and post message types
    if (message.message_type !== 'text' && message.message_type !== 'post') return;

    let text: string;
    try {
      const content = JSON.parse(message.content);
      if (message.message_type === 'text') {
        text = content.text;
      } else {
        // Post (rich text): extract text from content blocks
        const blocks = content.content || content.zh_cn?.content || [];
        text = blocks.flat().filter((el: any) => el.tag === 'text' || el.tag === 'md').map((el: any) => el.text).join('');
      }
    } catch {
      return;
    }

    if (!text || !text.trim()) return;

    // Strip @bot mentions (format: @_user_1 or similar)
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return;

    const chatId = message.chat_id;
    this.lastChatId = chatId;  // Track for broadcast replies
    this.lastMessageId = messageId;  // Track for typing indicator
    const sender = data?.sender;
    const senderName =
      sender?.sender_id?.open_id ||
      sender?.sender_id?.user_id ||
      'Unknown';

    const timestamp = message.create_time
      ? new Date(parseInt(message.create_time, 10)).toISOString()
      : new Date().toISOString();

    const msg: UserMessage = {
      id: crypto.randomUUID(),
      channelId: `feishu:${chatId}`,
      sender: senderName,
      content: text,
      timestamp,
    };

    logger.info({ chatId, sender: senderName, textLen: text.length }, 'Feishu message received');
    this.onMessage(msg);
  }

  private pruneDedup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > this.DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }

  async setTyping(active: boolean): Promise<void> {
    if (active && this.lastMessageId) {
      // Add a "Typing" emoji reaction to the user's message
      try {
        const response: any = await this.client.im.messageReaction.create({
          path: { message_id: this.lastMessageId },
          data: { reaction_type: { emoji_type: 'Typing' } },
        });
        this.typingReactionId = response?.data?.reaction_id ?? null;
      } catch {
        // Not critical — silently ignore
      }
    } else {
      await this.removeTypingIndicator();
    }
  }

  private async removeTypingIndicator(): Promise<void> {
    if (this.typingReactionId && this.lastMessageId) {
      try {
        await this.client.im.messageReaction.delete({
          path: {
            message_id: this.lastMessageId,
            reaction_id: this.typingReactionId,
          },
        });
      } catch {
        // Not critical
      }
      this.typingReactionId = null;
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.lastChatId) {
      logger.warn('FeishuChannel.sendMessage: no chat_id yet (no inbound message received)');
      return;
    }
    await this.removeTypingIndicator();
    await this.sendToChat(this.lastChatId, text);
  }

  /**
   * Resolve receive_id_type based on ID prefix, matching Feishu's conventions.
   * oc_ = chat_id, ou_ = open_id, otherwise user_id.
   */
  private resolveReceiveIdType(id: string): 'chat_id' | 'open_id' | 'user_id' {
    if (id.startsWith('oc_')) return 'chat_id';
    if (id.startsWith('ou_')) return 'open_id';
    return 'user_id';
  }

  /**
   * Build Feishu post message payload (rich text format).
   * Feishu's 'post' type with zh_cn.content renders markdown properly,
   * unlike plain 'text' which has limited formatting.
   */
  private buildPostPayload(messageText: string): { content: string; msgType: string } {
    return {
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text: messageText }]],
        },
      }),
      msgType: 'post',
    };
  }

  async sendToChat(chatId: string, text: string): Promise<void> {
    try {
      const receiveIdType = this.resolveReceiveIdType(chatId);
      const { content, msgType } = this.buildPostPayload(text);

      const response: any = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content,
        },
      });

      if (response?.code !== 0) {
        logger.error({ chatId, code: response?.code, msg: response?.msg }, 'Feishu API error');
      }
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
      this.seenMessages.clear();
      logger.info('Feishu bot stopped');
    }
  }
}
