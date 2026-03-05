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
import { createProvider } from './providers/index.js';
import { Scheduler } from './scheduler.js';
import { config, providerConfig, telegramConfig, proxyUrl } from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    logger.info({ proxy: proxyUrl }, 'Proxy configured');
  }

  logger.info('Starting Meridian...');

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 1. Initialize blackboard (SQLite-backed pub/sub)
  const dbPath = path.join(config.dataDir, 'meridian.db');
  const blackboard = new Blackboard(dbPath);
  logger.info({ dbPath }, 'Blackboard initialized');

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
  const doorman = new Doorman(blackboard, runner, registry, provider);

  // 6. Start HTTP server (A2UI + WebSocket)
  const httpServer = new HttpServer(blackboard, doorman);
  await httpServer.start();

  // 7. Connect CLI channel
  const cli = new CliChannel((msg) => doorman.handleMessage(msg));
  doorman.addChannel(cli);
  await cli.connect();
  logger.info('CLI channel connected');

  // 8. Connect Telegram channel (if configured)
  let telegram: TelegramChannel | null = null;
  if (telegramConfig?.botToken) {
    telegram = new TelegramChannel(
      telegramConfig.botToken,
      (msg) => doorman.handleMessage(msg),
      telegramConfig.chatId,
      proxyUrl ?? undefined,
    );
    doorman.addChannel(telegram);
    await telegram.connect();
    logger.info('Telegram channel connected');
  }

  // 9. Start proactive scheduler (posts tasks to blackboard on cron)
  const scheduler = new Scheduler(blackboard, config.schedules || []);
  scheduler.start();

  // 10. Ensure per-agent data directory exists
  fs.mkdirSync(path.join(config.dataDir, 'agents'), { recursive: true });

  // 11. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    scheduler.stop();
    runner.killAll();
    await cli.disconnect();
    if (telegram) await telegram.disconnect();
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
