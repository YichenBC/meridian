import { logger } from '../logger.js';
import {
  ModelProvider,
  ProviderConfig,
  SendMessageParams,
  StreamMessageParams,
  MessageResult,
} from './types.js';

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface OpenAIChatChoice {
  message?: { content?: unknown };
  delta?: { content?: string };
}

interface OpenAIChatResponse {
  model: string;
  usage?: OpenAIChatUsage;
  choices: OpenAIChatChoice[];
}

export class OpenAIChatProvider implements ModelProvider {
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
    };
    if (this.authHeader) {
      headers['x-api-key'] = this.apiKey;
    } else {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildBody(params: SendMessageParams, stream: boolean): string {
    const messages = params.system
      ? [{ role: 'system', content: params.system }, ...params.messages]
      : params.messages;

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens || 4096,
      stream,
    };
    return JSON.stringify(body);
  }

  async sendMessage(params: SendMessageParams): Promise<MessageResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;
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

    const data = await res.json() as OpenAIChatResponse;
    const usage = data.usage || {};
    const content = extractChoiceContent(data.choices);

    return {
      content,
      model: data.model || params.model,
      inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    };
  }

  async streamMessage(params: StreamMessageParams): Promise<MessageResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;
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
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr) as OpenAIChatResponse;
            if (data.model) model = data.model;

            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              content += delta;
              params.onText(delta);
            }

            const usage = data.usage;
            if (usage) {
              inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? inputTokens;
              outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
            }
          } catch (err) {
            logger.debug({ err, line: line.slice(0, 200) }, 'Skipping malformed OpenAI stream chunk');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content, model, inputTokens, outputTokens };
  }
}

function extractChoiceContent(choices: OpenAIChatChoice[]): string {
  const value = choices?.[0]?.message?.content;
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value
      .map((item: any) => {
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (item.type === 'text' && typeof item.content === 'string') return item.content;
        return '';
      })
      .join('');
  }

  if (value && typeof value === 'object' && typeof (value as { text?: string }).text === 'string') {
    return (value as { text: string }).text;
  }

  return '';
}
