import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'messages.log');

mkdirSync(LOG_DIR, { recursive: true });

function logEvent(level: 'info' | 'error', message: string, extra?: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...extra };
  const line = JSON.stringify(entry);
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}

export function logInfo(message: string, extra?: Record<string, unknown>): void {
  logEvent('info', message, extra);
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  logEvent('error', message, extra);
}
