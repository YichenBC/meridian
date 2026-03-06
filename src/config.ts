import fs from 'fs';
import path from 'path';
import { MeridianConfig, AuditorMode } from './types.js';
import { ProviderConfig } from './providers/types.js';

interface TelegramConfig {
  botToken: string;
  chatId?: string;
}

interface FeishuJsonConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

interface MeridianJsonConfig {
  proxy?: string;
  provider: ProviderConfig;
  model: string;
  port?: number;
  dataDir?: string;
  skillsDir?: string;
  maxAgents?: number;
  agentTimeoutMs?: number;
  telegram?: TelegramConfig;
  feishu?: FeishuJsonConfig;
  claudeCliPath?: string;
  auditorMode?: AuditorMode;
  auditorOverrides?: Record<string, AuditorMode>;
}

function loadMeridianJson(): MeridianJsonConfig {
  const configPath = path.join(process.cwd(), 'meridian.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing meridian.json at ${configPath}. Create it with provider configuration.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as MeridianJsonConfig;
}

const jsonConfig = loadMeridianJson();

export const proxyUrl: string | null = jsonConfig.proxy || null;
export const providerConfig: ProviderConfig = jsonConfig.provider;
export const telegramConfig = jsonConfig.telegram ?? null;
export const feishuConfig = jsonConfig.feishu ?? null;

// Channel mode: run a single channel per instance (defaults to 'telegram' for backward compat)
export const channelMode: string = process.env.CHANNEL || 'telegram';

export const config: MeridianConfig = {
  port: parseInt(process.env.PORT || process.env.MERIDIAN_PORT || String(jsonConfig.port || 3333), 10),
  dataDir: process.env.MERIDIAN_DATA_DIR || jsonConfig.dataDir || path.join(process.cwd(), 'data'),
  skillsDir: process.env.MERIDIAN_SKILLS_DIR || jsonConfig.skillsDir || path.join(process.cwd(), 'skills'),
  maxAgents: parseInt(process.env.MERIDIAN_MAX_AGENTS || String(jsonConfig.maxAgents || 3), 10),
  agentTimeoutMs: parseInt(process.env.MERIDIAN_AGENT_TIMEOUT || String(jsonConfig.agentTimeoutMs || 300000), 10),
  model: jsonConfig.model,
  claudeCliPath: process.env.MERIDIAN_CLAUDE_CLI || jsonConfig.claudeCliPath || undefined,
  auditorMode: (process.env.MERIDIAN_AUDITOR_MODE || jsonConfig.auditorMode || 'passthrough') as AuditorMode,
  auditorOverrides: jsonConfig.auditorOverrides || {},
};

// Per-channel SQLite DB path (e.g., data/telegram.db, data/feishu.db)
export const channelDbPath: string = path.join(config.dataDir, `${channelMode}.db`);
