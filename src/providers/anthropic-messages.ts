import { logger } from '../logger.js';
import {
  ModelProvider,
  ProviderConfig,
  SendMessageParams,
  StreamMessageParams,
  MessageResult,
} from './types.js';

export class AnthropicMessagesProvider implements ModelProvider {
  private baseUrl: string;
  private apiKey: string;
  private authHeader: boolean;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.authHeader = config.authHeader;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.authHeader) {
      headers['x-api-key'] = this.apiKey;
    } else {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildBody(params: SendMessageParams, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens || 4096,
    };
    if (params.system) {
      body.system = params.system;
    }
    if (stream) {
      body.stream = true;
    }
    return JSON.stringify(body);
  }

  async sendMessage(params: SendMessageParams): Promise<MessageResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: this.buildBody(params, false),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provider API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');

    return {
      content,
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }

  async streamMessage(params: StreamMessageParams): Promise<MessageResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: this.buildBody(params, true),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provider API error ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('No response body for streaming');
    }

    let content = '';
    let model = params.model;
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data) as {
                type: string;
                delta?: { type: string; text?: string };
                message?: { model: string };
                usage?: { input_tokens: number; output_tokens: number };
              };

              if (event.type === 'message_start' && event.message) {
                model = event.message.model;
              } else if (event.type === 'content_block_delta' && event.delta?.text) {
                content += event.delta.text;
                params.onText(event.delta.text);
              } else if (event.type === 'message_delta' && event.usage) {
                outputTokens = event.usage.output_tokens;
              } else if (event.type === 'message_start') {
                const msg = event as { type: string; message?: { usage?: { input_tokens: number } } };
                if (msg.message?.usage) {
                  inputTokens = msg.message.usage.input_tokens;
                }
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content, model, inputTokens, outputTokens };
  }
}
