import { AnthropicMessagesProvider } from './anthropic-messages.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { ModelProvider, ProviderConfig } from './types.js';

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.api) {
    case 'anthropic-messages':
      return new AnthropicMessagesProvider(config);
    case 'openai-chat':
      return new OpenAIChatProvider(config);
    default:
      throw new Error(`Unknown provider API format: ${config.api}. Supported: anthropic-messages, openai-chat`);
  }
}

export type { ModelProvider, ProviderConfig } from './types.js';
