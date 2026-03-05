import { AnthropicMessagesProvider } from './anthropic-messages.js';
import { ModelProvider, ProviderConfig } from './types.js';

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.api) {
    case 'anthropic-messages':
      return new AnthropicMessagesProvider(config);
    default:
      throw new Error(`Unknown provider API format: ${config.api}`);
  }
}

export type { ModelProvider, ProviderConfig } from './types.js';
