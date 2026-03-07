import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import yaml from 'yaml';
import { Skill } from '../types.js';

type JsonLike = Record<string, unknown>;

export function parseOpenClawMetadata(metadata: unknown): Skill['openclaw'] {
  if (!metadata) return undefined;

  let parsed = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = yaml.parse(metadata);
    } catch {
      return undefined;
    }
  }

  if (!parsed || typeof parsed !== 'object') return undefined;

  const openclaw = (parsed as JsonLike).openclaw;
  if (!openclaw || typeof openclaw !== 'object') return undefined;

  const record = openclaw as JsonLike;
  return {
    always: record.always === true,
    os: normalizeStringList(record.os),
    skillKey: normalizeString(record.skillKey),
    primaryEnv: normalizeString(record.primaryEnv),
    requires: record.requires && typeof record.requires === 'object'
      ? {
          bins: normalizeStringList((record.requires as JsonLike).bins),
          anyBins: normalizeStringList((record.requires as JsonLike).anyBins),
          env: normalizeStringList((record.requires as JsonLike).env),
          config: normalizeStringList((record.requires as JsonLike).config),
        }
      : undefined,
  };
}

export function evaluateSkillEligibility(skill: Pick<Skill, 'name' | 'openclaw'>): Skill['eligibility'] {
  const openclaw = skill.openclaw;
  if (!openclaw) {
    return { eligible: true, missing: [], satisfied: [], source: 'none' };
  }

  if (openclaw.always) {
    return { eligible: true, missing: [], satisfied: ['openclaw.always'], source: 'openclaw' };
  }

  const compatibilityConfig = loadCompatibilityConfig();
  const skillKey = openclaw.skillKey || skill.name;
  const skillEntry = getSkillEntry(compatibilityConfig.openclawConfig, skillKey);

  const missing: string[] = [];
  const satisfied: string[] = [];

  if (skillEntry?.enabled === false) {
    missing.push(`disabled:${skillKey}`);
  } else {
    satisfied.push(`enabled:${skillKey}`);
  }

  if (openclaw.os && openclaw.os.length > 0) {
    if (openclaw.os.includes(process.platform)) {
      satisfied.push(`os:${process.platform}`);
    } else {
      missing.push(`os:${process.platform}`);
    }
  }

  for (const bin of openclaw.requires?.bins || []) {
    if (hasBinary(bin)) {
      satisfied.push(`bin:${bin}`);
    } else {
      missing.push(`bin:${bin}`);
    }
  }

  const anyBins = openclaw.requires?.anyBins || [];
  if (anyBins.length > 0) {
    const available = anyBins.filter(hasBinary);
    if (available.length > 0) {
      satisfied.push(`anyBin:${available.join('|')}`);
    } else {
      missing.push(`anyBin:${anyBins.join('|')}`);
    }
  }

  for (const envName of openclaw.requires?.env || []) {
    if (hasEnvRequirement(envName, openclaw.primaryEnv, skillEntry)) {
      satisfied.push(`env:${envName}`);
    } else {
      missing.push(`env:${envName}`);
    }
  }

  for (const configPath of openclaw.requires?.config || []) {
    if (hasTruthyPath(compatibilityConfig.meridianConfig, configPath)
      || hasTruthyPath(compatibilityConfig.openclawConfig, configPath)
      || hasTruthyPath(skillEntry?.config as JsonLike | undefined, configPath)) {
      satisfied.push(`config:${configPath}`);
    } else {
      missing.push(`config:${configPath}`);
    }
  }

  return {
    eligible: missing.length === 0,
    missing,
    satisfied,
    source: 'openclaw',
  };
}

function loadCompatibilityConfig(): { meridianConfig: JsonLike; openclawConfig: JsonLike } {
  return {
    meridianConfig: readStructuredFile(path.join(process.cwd(), 'meridian.json')),
    openclawConfig: readStructuredFile(path.join(os.homedir(), '.openclaw', 'openclaw.json')),
  };
}

function readStructuredFile(filePath: string): JsonLike {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as JsonLike : {};
  } catch {
    return {};
  }
}

function getSkillEntry(openclawConfig: JsonLike, skillKey: string): JsonLike | undefined {
  const entries = getPath(openclawConfig, 'skills.entries');
  if (!entries || typeof entries !== 'object') return undefined;
  const entry = (entries as JsonLike)[skillKey];
  return entry && typeof entry === 'object' ? entry as JsonLike : undefined;
}

function hasEnvRequirement(envName: string, primaryEnv: string | undefined, skillEntry: JsonLike | undefined): boolean {
  if (process.env[envName]) return true;

  const envValues = skillEntry?.env;
  if (envValues && typeof envValues === 'object' && (envValues as JsonLike)[envName]) {
    return true;
  }

  if (primaryEnv === envName && typeof skillEntry?.apiKey === 'string' && skillEntry.apiKey.length > 0) {
    return true;
  }

  return false;
}

function hasTruthyPath(source: JsonLike | undefined, dottedPath: string): boolean {
  if (!source) return false;
  const value = getPath(source, dottedPath);
  return Boolean(value);
}

function getPath(source: JsonLike, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as JsonLike)[segment];
  }, source);
}

function hasBinary(bin: string): boolean {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(which, [bin], { stdio: 'ignore' });
  return result.status === 0;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
}
