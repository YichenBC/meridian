import fs from 'fs';
import path from 'path';
import { SkillInstallMetadata } from '../types.js';

const INSTALL_METADATA_FILE = '.meridian-skill.json';

export interface InstallSkillParams {
  sourcePath: string;
  targetRoot: string;
  name?: string;
  overwrite?: boolean;
  installMetadata?: SkillInstallMetadata;
}

export interface InstalledSkill {
  name: string;
  sourcePath: string;
  targetPath: string;
  installMetadata?: SkillInstallMetadata;
}

export function installSkill(params: InstallSkillParams): InstalledSkill {
  const sourcePath = path.resolve(params.sourcePath);
  const sourceSkillMd = path.join(sourcePath, 'SKILL.md');
  if (!fs.existsSync(sourceSkillMd)) {
    throw new Error(`Skill source is invalid: missing SKILL.md at ${sourceSkillMd}`);
  }

  const targetRoot = path.resolve(params.targetRoot);
  fs.mkdirSync(targetRoot, { recursive: true });

  const name = params.name?.trim() || path.basename(sourcePath);
  const targetPath = path.join(targetRoot, name);
  if (fs.existsSync(targetPath)) {
    if (!params.overwrite) {
      throw new Error(`Skill already exists at ${targetPath}`);
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.cpSync(sourcePath, targetPath, { recursive: true });
  if (params.installMetadata) {
    fs.writeFileSync(
      path.join(targetPath, INSTALL_METADATA_FILE),
      JSON.stringify(params.installMetadata, null, 2),
    );
  }

  return { name, sourcePath, targetPath, installMetadata: params.installMetadata };
}

export function readInstallMetadata(skillDir: string): SkillInstallMetadata | undefined {
  const metadataPath = path.join(skillDir, INSTALL_METADATA_FILE);
  if (!fs.existsSync(metadataPath)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    if (parsed?.installer !== 'meridian' || !parsed?.installedAt || !parsed?.source?.kind || !parsed?.source?.reference) {
      return undefined;
    }
    return parsed as SkillInstallMetadata;
  } catch {
    return undefined;
  }
}
