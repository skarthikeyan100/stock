import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, OffsetRule } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function positive(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  if (typeof value !== 'number' || !(value > 0)) throw new Error(`Invalid config: ${field} must be a positive number`);
  return value;
}

function withDefault(raw: Record<string, unknown>, field: string, fallback: number): number {
  return raw[field] === undefined ? fallback : positive(raw, field);
}

function rule(raw: Record<string, unknown>, field: string): OffsetRule | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new Error(`Invalid config: ${field} must be {percent?, points?}`);
  const { percent, points } = value as OffsetRule;
  if (percent !== undefined && !(percent > 0)) throw new Error(`Invalid config: ${field}.percent must be positive`);
  if (points !== undefined && !(points > 0)) throw new Error(`Invalid config: ${field}.points must be positive`);
  return { ...(percent !== undefined ? { percent } : {}), ...(points !== undefined ? { points } : {}) };
}

export function parseConfig(input: unknown): Config {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid config: expected an object');
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.allowedSenders)) throw new Error('Invalid config: allowedSenders must be a string[]');

  const target = rule(raw, 'target');
  const stop = rule(raw, 'stop');
  return {
    allowedSenders: raw.allowedSenders as string[],
    investment: positive(raw, 'investment'),
    lotSize: positive(raw, 'lotSize'),
    ...(target ? { target } : {}),
    ...(stop ? { stop } : {}),
    strikeBandPercent: withDefault(raw, 'strikeBandPercent', 10),
    priceMin: withDefault(raw, 'priceMin', 1),
    priceMax: withDefault(raw, 'priceMax', 1500),
    dedupeWindowSeconds: withDefault(raw, 'dedupeWindowSeconds', 300),
    headless: raw.headless === undefined ? true : raw.headless === true,
    dryRun: raw.dryRun === undefined ? true : raw.dryRun !== false,
    profileDir: typeof raw.profileDir === 'string' ? raw.profileDir : 'browser-profile',
    ...(typeof raw.claudeModel === 'string' ? { claudeModel: raw.claudeModel } : {}),
  };
}

export function loadConfig(): Config {
  return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
}
