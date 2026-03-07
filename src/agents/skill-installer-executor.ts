import { AgentExecutor, ExecuteParams, ExecuteResult } from './executor.js';
import { config } from '../config.js';
import {
  executeSkillInstallCommand,
  formatInstalledSkillSummary,
  parseSkillInstallTaskPrompt,
} from '../skills/commands.js';

export class SkillInstallerExecutor implements AgentExecutor {
  name = 'skill-installer';

  constructor(
    private onInstalled?: () => void,
  ) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const command = parseSkillInstallTaskPrompt(params.task.prompt);
    if (!command) {
      throw new Error('Invalid skill install task payload');
    }

    params.onProgress(`Installing skill reference: ${command.reference}`);
    const installed = await executeSkillInstallCommand({
      reference: command.reference,
      targetRoot: config.skillsDir,
      extraSkillsDirs: config.extraSkillsDirs,
      overwrite: true,
    });
    this.onInstalled?.();

    return {
      content: `Installed skill${installed.length > 1 ? 's' : ''}: ${formatInstalledSkillSummary(installed)}`,
      meta: {
        executor: this.name,
        installedSkills: installed.map((entry) => entry.name),
      },
    };
  }
}
