import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { installSkill } from './install.js';
import { SkillInstallMetadata } from '../types.js';

export interface SkillInstallCommand {
  reference: string;
}

export interface InstalledSkillRecord {
  name: string;
  sourcePath: string;
  targetPath: string;
  installMetadata?: SkillInstallMetadata;
}

export interface ExecuteSkillInstallCommandParams {
  reference: string;
  targetRoot: string;
  extraSkillsDirs?: string[];
  overwrite?: boolean;
  clawhubPath?: string;
}

const SKILL_INSTALL_TASK_PREFIX = '__MERIDIAN_INSTALL_SKILL__';

export function parseSkillInstallIntent(input: string): SkillInstallCommand | null {
  const trimmed = input.trim();

  const candidatePatterns = [
    /(?:^|\b)(?:install|add|enable)\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/-]+))\s+skill\b/i,
    /(?:^|\b)(?:install|add|enable)\s+skill\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/-]+))(?:\s|$|[,.!?])/i,
    /(?:安装|装上|装一下|添加)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/-]+))(?:\s*这个)?\s*skill/i,
    /(?:安装|装上|装一下|添加)\s*skill\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/-]+))(?:\s|$|[,.!?])/i,
  ];

  for (const pattern of candidatePatterns) {
    const match = trimmed.match(pattern);
    const reference = firstNonEmpty(match?.[1], match?.[2], match?.[3]);
    if (reference && !/^(a|an|the)$/i.test(reference)) {
      return { reference: stripWrappingQuotes(reference) };
    }
  }

  return null;
}

export function buildSkillInstallTaskPrompt(reference: string): string {
  return `${SKILL_INSTALL_TASK_PREFIX} ${JSON.stringify({ reference })}`;
}

export function parseSkillInstallTaskPrompt(prompt: string): SkillInstallCommand | null {
  if (!prompt.startsWith(SKILL_INSTALL_TASK_PREFIX)) return null;
  const payload = prompt.slice(SKILL_INSTALL_TASK_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed.reference === 'string' && parsed.reference.trim().length > 0) {
      return { reference: parsed.reference.trim() };
    }
  } catch {}
  return null;
}

export async function executeSkillInstallCommand(
  params: ExecuteSkillInstallCommandParams,
): Promise<InstalledSkillRecord[]> {
  const resolvedSource = resolveInstallSource(params.reference, params.extraSkillsDirs || []);
  if (resolvedSource) {
    const installMetadata = buildInstallMetadata({
      kind: resolvedSource.kind,
      reference: params.reference,
      resolvedPath: resolvedSource.path,
    });
    return [installSkill({
      sourcePath: resolvedSource.path,
      targetRoot: params.targetRoot,
      overwrite: params.overwrite,
      installMetadata,
    })];
  }

  const clawhubPath = params.clawhubPath || 'clawhub';
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-clawhub-'));
  try {
    await runClawhubInstall(clawhubPath, params.reference, workspace);
    const installedFromWorkspace = discoverInstalledSkills(path.join(workspace, 'skills'));
    if (installedFromWorkspace.length === 0) {
      throw new Error(`clawhub install completed but no skills were found in ${path.join(workspace, 'skills')}`);
    }

    return installedFromWorkspace.map((sourcePath) => installSkill({
      sourcePath,
      targetRoot: params.targetRoot,
      overwrite: params.overwrite,
      installMetadata: buildInstallMetadata({
        kind: 'clawhub',
        reference: params.reference,
        resolvedPath: sourcePath,
        slug: params.reference,
        downloadedVia: 'clawhub',
      }),
    }));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function resolveInstallSource(reference: string, extraSkillsDirs: string[]): { path: string; kind: 'local-path' | 'extra-skills-dir' } | null {
  const explicitPath = path.resolve(reference);
  if (hasSkillMd(explicitPath)) return { path: explicitPath, kind: 'local-path' };

  for (const skillsDir of extraSkillsDirs) {
    const candidate = path.resolve(skillsDir, reference);
    if (hasSkillMd(candidate)) return { path: candidate, kind: 'extra-skills-dir' };
  }

  return null;
}

function hasSkillMd(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, 'SKILL.md'));
}

function discoverInstalledSkills(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasSkillMd(path.join(skillsRoot, entry.name)))
    .map((entry) => path.join(skillsRoot, entry.name));
}

function runClawhubInstall(clawhubPath: string, reference: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(clawhubPath, ['--workdir', cwd, 'install', reference], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderr = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run clawhub install: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `clawhub install exited with code ${code}`));
    });
  });
}

function buildInstallMetadata(source: SkillInstallMetadata['source']): SkillInstallMetadata {
  return {
    installer: 'meridian',
    installedAt: new Date().toISOString(),
    source,
  };
}

export function formatInstalledSkillSummary(installed: InstalledSkillRecord[]): string {
  return installed
    .map((skill) => {
      const source = skill.installMetadata?.source;
      if (!source) return skill.name;
      if (source.kind === 'clawhub') return `${skill.name} (from ClawHub${source.slug ? `: ${source.slug}` : ''})`;
      if (source.kind === 'extra-skills-dir') return `${skill.name} (from extra skills dir)`;
      return `${skill.name} (from local path)`;
    })
    .join(', ');
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
