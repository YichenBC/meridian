export interface ProviderModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderConfig {
  baseUrl: string;
  api: string;          // "anthropic-messages" | "openai-chat" (future)
  apiKey: string;
  authHeader: boolean;  // true = x-api-key header, false = Authorization: Bearer
  models: ProviderModelConfig[];
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

export interface SendMessageParams {
  model: string;
  system?: string;
  messages: MessageParam[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamMessageParams extends SendMessageParams {
  onText: (chunk: string) => void;
}

export interface MessageResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  sendMessage(params: SendMessageParams): Promise<MessageResult>;
  streamMessage(params: StreamMessageParams): Promise<MessageResult>;
}
