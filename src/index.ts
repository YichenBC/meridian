import path from 'path';
import fs from 'fs';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { Blackboard } from './blackboard/blackboard.js';
import { loadSkills } from './skills/loader.js';
import { AgentRegistry } from './agents/registry.js';
import { AgentRunner } from './agents/runner.js';
import { LLMExecutor } from './agents/executor.js';
import { ClaudeCodeExecutor } from './agents/claude-code-executor.js';
import { Doorman } from './doorman/doorman.js';
import { HttpServer } from './doorman/http-server.js';
import { CliChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { FeishuChannel } from './channels/feishu.js';
import { createProvider } from './providers/index.js';
import { config, providerConfig, telegramConfig, feishuConfig, proxyUrl, channelMode, channelDbPath } from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    logger.info({ proxy: proxyUrl }, 'Proxy configured');
  }

  logger.info('Starting Meridian...');

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 1. Initialize blackboard (SQLite-backed pub/sub) — per-channel DB
  const blackboard = new Blackboard(channelDbPath);
  logger.info({ dbPath: channelDbPath, channel: channelMode }, 'Blackboard initialized');

  // 2. Load skills
  const skills = loadSkills(config.skillsDir);
  logger.info({ count: skills.length, names: skills.map(s => s.name) }, 'Skills loaded');

  // 3. Create model provider
  const provider = createProvider(providerConfig);
  logger.info({ api: providerConfig.api, model: config.model, baseUrl: providerConfig.baseUrl }, 'Model provider initialized');

  // 4. Create agent infrastructure
  const registry = new AgentRegistry(blackboard);
  const runner = new AgentRunner(blackboard, registry, skills);

  // Register executors — unified interface, diverse implementations
  runner.registerExecutor(new LLMExecutor(provider, config.model));
  if (config.claudeCliPath) {
    runner.registerExecutor(new ClaudeCodeExecutor(config.claudeCliPath));
    logger.info({ path: config.claudeCliPath }, 'Claude Code executor registered');
  }

  // 5. Create Doorman
  const doorman = new Doorman(blackboard, runner, registry);

  // 6. Start HTTP server (A2UI + WebSocket)
  const httpServer = new HttpServer(blackboard, doorman);
  await httpServer.start();

  // 7. Connect channel based on CHANNEL env var (instance-per-channel mode)
  let cli: CliChannel | null = null;
  let telegram: TelegramChannel | null = null;
  let feishu: FeishuChannel | null = null;

  if (channelMode === 'cli') {
    cli = new CliChannel((msg) => doorman.handleMessage(msg));
    doorman.addChannel(cli);
    await cli.connect();
    logger.info('CLI channel connected');
  } else if (channelMode === 'telegram') {
    if (!telegramConfig?.botToken) {
      throw new Error('CHANNEL=telegram but no telegram.botToken in meridian.json');
    }
    telegram = new TelegramChannel(
      telegramConfig.botToken,
      (msg) => doorman.handleMessage(msg),
      telegramConfig.chatId,
      proxyUrl ?? undefined,
    );
    doorman.addChannel(telegram);
    await telegram.connect();
    logger.info('Telegram channel connected');
  } else if (channelMode === 'feishu') {
    if (!feishuConfig?.appId || !feishuConfig?.appSecret) {
      throw new Error('CHANNEL=feishu but no feishu config in meridian.json');
    }
    feishu = new FeishuChannel(
      feishuConfig,
      (msg) => doorman.handleMessage(msg),
    );
    doorman.addChannel(feishu);
    await feishu.connect();
    logger.info('Feishu channel connected');
  } else {
    throw new Error(`Unknown CHANNEL: ${channelMode}. Supported: cli, telegram, feishu`);
  }

  // 10. Ensure per-agent data directory exists
  fs.mkdirSync(path.join(config.dataDir, 'agents'), { recursive: true });

  // 10. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    runner.killAll();
    if (cli) await cli.disconnect();
    if (telegram) await telegram.disconnect();
    if (feishu) await feishu.disconnect();
    await httpServer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ port: config.port, model: config.model }, 'Meridian is ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
