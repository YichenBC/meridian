import fs from 'fs';
import path from 'path';
import { MeridianConfig, ScheduledTask } from './types.js';
import { ProviderConfig } from './providers/types.js';

interface TelegramConfig {
  botToken: string;
  chatId?: string;
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
  claudeCliPath?: string;
  schedules?: ScheduledTask[];
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

export const config: MeridianConfig = {
  port: parseInt(process.env.MERIDIAN_PORT || String(jsonConfig.port || 3333), 10),
  dataDir: process.env.MERIDIAN_DATA_DIR || jsonConfig.dataDir || path.join(process.cwd(), 'data'),
  skillsDir: process.env.MERIDIAN_SKILLS_DIR || jsonConfig.skillsDir || path.join(process.cwd(), 'skills'),
  maxAgents: parseInt(process.env.MERIDIAN_MAX_AGENTS || String(jsonConfig.maxAgents || 3), 10),
  agentTimeoutMs: parseInt(process.env.MERIDIAN_AGENT_TIMEOUT || String(jsonConfig.agentTimeoutMs || 300000), 10),
  model: jsonConfig.model,
  claudeCliPath: process.env.MERIDIAN_CLAUDE_CLI || jsonConfig.claudeCliPath || undefined,
  schedules: jsonConfig.schedules || [],
};
