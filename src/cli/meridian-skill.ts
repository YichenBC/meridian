#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { executeSkillInstallCommand } from '../skills/commands.js';

interface CliOptions {
  workdir: string;
  skillsDir?: string;
  extraSkillsDirs: string[];
  overwrite: boolean;
  clawhubPath?: string;
}

async function main(): Promise<void> {
  const { command, reference, options } = parseArgs(process.argv.slice(2));
  if (command !== 'install' || !reference) {
    printHelp();
    process.exit(1);
  }

  const resolved = resolveWorkspaceSettings(options);
  const installed = await executeSkillInstallCommand({
    reference,
    targetRoot: resolved.skillsDir,
    extraSkillsDirs: resolved.extraSkillsDirs,
    overwrite: options.overwrite,
    clawhubPath: options.clawhubPath,
  });

  for (const entry of installed) {
    const source = entry.installMetadata?.source;
    const origin = source
      ? `${source.kind}${source.slug ? ` slug=${source.slug}` : ''}${source.resolvedPath ? ` path=${source.resolvedPath}` : ''}`
      : 'unknown';
    process.stdout.write(`Installed skill: ${entry.name} (${origin}) -> ${entry.targetPath}\n`);
  }
}

function parseArgs(argv: string[]): { command: string | null; reference: string | null; options: CliOptions } {
  const options: CliOptions = {
    workdir: process.cwd(),
    extraSkillsDirs: [],
    overwrite: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--workdir':
        options.workdir = path.resolve(argv[++i] || '');
        break;
      case '--skills-dir':
        options.skillsDir = path.resolve(argv[++i] || '');
        break;
      case '--extra-skills-dir':
        options.extraSkillsDirs.push(path.resolve(argv[++i] || ''));
        break;
      case '--overwrite':
      case '--force':
        options.overwrite = true;
        break;
      case '--clawhub':
        options.clawhubPath = argv[++i] || '';
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        positional.push(arg);
        break;
    }
  }

  return {
    command: positional[0] || null,
    reference: positional[1] || null,
    options,
  };
}

function resolveWorkspaceSettings(options: CliOptions): { skillsDir: string; extraSkillsDirs: string[] } {
  const meridianJsonPath = path.join(options.workdir, 'meridian.json');
  let meridianJson: { skillsDir?: string; extraSkillsDirs?: string[] } = {};
  if (fs.existsSync(meridianJsonPath)) {
    meridianJson = JSON.parse(fs.readFileSync(meridianJsonPath, 'utf-8'));
  }

  const skillsDir = options.skillsDir
    || (meridianJson.skillsDir ? path.resolve(options.workdir, meridianJson.skillsDir) : path.join(options.workdir, 'skills'));

  const extraSkillsDirs = options.extraSkillsDirs.length > 0
    ? options.extraSkillsDirs
    : (meridianJson.extraSkillsDirs || []).map((dir) => path.resolve(options.workdir, dir));

  return { skillsDir, extraSkillsDirs };
}

function printHelp(): void {
  process.stdout.write(`Usage: meridian-skill install <slug-or-path> [options]

Options:
  --workdir <dir>          Meridian workspace directory (default: cwd)
  --skills-dir <dir>       Override Meridian skills directory
  --extra-skills-dir <dir> Add an extra skill source directory (repeatable)
  --overwrite              Overwrite an existing installed skill
  --clawhub <path>         Override clawhub executable path
  -h, --help               Show this help
`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`meridian-skill failed: ${message}\n`);
  process.exit(1);
});
