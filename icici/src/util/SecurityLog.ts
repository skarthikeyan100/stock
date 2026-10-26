import fs from 'fs';
import path from 'path';
import moment from 'moment';
import Log from './Log';

const SECURITY_LOG_PATH = path.join(process.cwd(), 'security.log');

const MAX_SECURITY_LOG_BYTES = 5 * 1024 * 1024;
let writesSinceCheck = 0;
// Keeps security.log bounded: past 5MB it becomes security.log.1 (one generation kept). Checked every 50 writes.
function rotateIfLarge(): void {
  if (++writesSinceCheck < 50) return;
  writesSinceCheck = 0;
  try {
    if (fs.statSync(SECURITY_LOG_PATH).size > MAX_SECURITY_LOG_BYTES) fs.renameSync(SECURITY_LOG_PATH, `${SECURITY_LOG_PATH}.1`);
  } catch { /* file may not exist yet */ }
}

export default class SecurityLog {
  static log(event: string, details: Record<string, any>) {
    const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    const detailStr = Object.entries(details)
      // CR/LF in a logged request field (path, ip) would let a caller forge extra log lines.
      .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, ' ')}`)
      .join(' ');
    const line = `${timestamp} [${event}] ${detailStr}`;

    Log.log(`[security] ${line}`);
    rotateIfLarge();
    fs.appendFile(SECURITY_LOG_PATH, line + '\n', (err) => {
      if (err) Log.log(`[security] failed to write security.log:`, err);
    });
  }
}
