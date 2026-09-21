import fs from 'fs';
import path from 'path';
import moment from 'moment';
import Log from './Log';

const SECURITY_LOG_PATH = path.join(process.cwd(), 'security.log');

export default class SecurityLog {
  static log(event: string, details: Record<string, any>) {
    const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    const detailStr = Object.entries(details)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const line = `${timestamp} [${event}] ${detailStr}`;

    Log.log(`[security] ${line}`);
    fs.appendFile(SECURITY_LOG_PATH, line + '\n', (err) => {
      if (err) Log.log(`[security] failed to write security.log:`, err);
    });
  }
}
