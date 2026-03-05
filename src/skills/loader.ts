import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { Skill } from '../types.js';
import { logger } from '../logger.js';

export function loadSkills(skillsDir: string): Skill[] {
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

  logger.info({ count: skills.length }, 'Skills loaded');
  return skills;
}

function parseSkillMd(raw: string, skillDir: string): Skill | null {
  // YAML frontmatter is enclosed between two --- markers
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = raw.match(frontmatterRegex);

  if (!match) {
    logger.warn({ skillDir }, 'SKILL.md missing valid YAML frontmatter');
    return null;
  }

  const frontmatterStr = match[1];
  const body = match[2];

  let frontmatter: { name?: string; description?: string; executor?: string; model?: string };
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

  // Resolve {baseDir}/ placeholders to the skill's absolute directory path
  const absoluteDir = path.resolve(skillDir);
  const content = body.replace(/\{baseDir\}\//g, absoluteDir + '/');

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    content,
    baseDir: absoluteDir,
    executor: frontmatter.executor,
    model: frontmatter.model,
  };
}
