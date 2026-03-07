import fs from 'fs';
import path from 'path';

function loadMeridianJson() {
  const configPath = path.join(process.cwd(), 'meridian.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function getRuntimeConfig() {
  const json = loadMeridianJson();
  const toolExecutor = process.env.MERIDIAN_TOOL_EXECUTOR
    || json.toolExecutor
    || (json.claudeCliPath ? 'claude-code' : json.codexCliPath ? 'codex-cli' : 'llm');
  const doormanExecutor = process.env.MERIDIAN_DOORMAN_EXECUTOR
    || json.doormanExecutor
    || (json.codexCliPath ? 'codex-cli' : json.claudeCliPath ? 'claude-code' : 'llm');
  return { toolExecutor, doormanExecutor };
}

export function getDoormanHints(doormanExecutor) {
  if (doormanExecutor === 'codex-cli') {
    return ['codex', 'gpt', 'openai', 'gpt-5'];
  }
  if (doormanExecutor === 'claude-code') {
    return ['claude', 'anthropic', 'sonnet', 'opus', 'haiku'];
  }
  return ['model', 'provider', 'llm'];
}
