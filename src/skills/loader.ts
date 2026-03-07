import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { Skill } from '../types.js';
import { logger } from '../logger.js';
import { evaluateSkillEligibility, parseOpenClawMetadata } from './compatibility.js';
import { readInstallMetadata } from './install.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  executor?: string;
  model?: string;
  metadata?: unknown;
}

export function loadSkills(skillsDir: string, extraSkillsDirs: string[] = []): Skill[] {
  const orderedDirs = [
    ...extraSkillsDirs.map((dir) => path.resolve(dir)),
    path.resolve(skillsDir),
  ];

  const byName = new Map<string, Skill>();
  for (const dir of orderedDirs) {
    for (const skill of scanSkillsDirectory(dir)) {
      byName.set(skill.name, skill);
    }
  }

  const skills = Array.from(byName.values());
  logger.info({ count: skills.length, dirs: orderedDirs }, 'Skills loaded');
  return skills;
}

function scanSkillsDirectory(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  if (!fs.existsSync(skillsDir)) {
    logger.warn({ skillsDir }, 'Skills directory does not exist');
    return skills;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const raw = fs.readFileSync(skillMdPath, 'utf-8');
      const skill = parseSkillMd(raw, skillDir);
      if (skill) {
        skills.push(skill);
        logger.info({ name: skill.name, dir: skillDir }, 'Loaded skill');
      }
    } catch (err) {
      logger.error({ err, skillMdPath }, 'Failed to load skill');
    }
  }

  return skills;
}

function parseSkillMd(raw: string, skillDir: string): Skill | null {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = raw.match(frontmatterRegex);

  if (!match) {
    logger.warn({ skillDir }, 'SKILL.md missing valid YAML frontmatter');
    return null;
  }

  const frontmatterStr = match[1];
  const body = match[2];

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = yaml.parse(frontmatterStr);
  } catch (err) {
    logger.error({ err, skillDir }, 'Failed to parse YAML frontmatter');
    return null;
  }

  if (!frontmatter.name || !frontmatter.description) {
    logger.warn({ skillDir }, 'SKILL.md frontmatter missing name or description');
    return null;
  }

  const absoluteDir = path.resolve(skillDir);
  const content = body.replace(/\{baseDir\}\//g, absoluteDir + '/');
  const openclaw = parseOpenClawMetadata(frontmatter.metadata);
  const eligibility = evaluateSkillEligibility({
    name: frontmatter.name,
    openclaw,
  });
  const install = readInstallMetadata(absoluteDir);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    content,
    baseDir: absoluteDir,
    sourceDir: absoluteDir,
    install,
    executor: frontmatter.executor,
    model: frontmatter.model,
    openclaw,
    eligibility,
  };
}
