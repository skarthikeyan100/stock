/**
 * Shoonya OAuth login helper.
 *
 * Shoonya's OAuth login endpoint hangs/black-holes automated (headless and
 * non-headless CDP-driven) browser connections, so this doesn't automate the
 * login itself — it prints the login URL, waits for you to complete login
 * manually and paste back the `code` from the resulting URL, then finishes
 * the exchange via the already-running local server.
 *
 * Usage:
 *   npm run shoonya:login
 *
 * Prerequisites:
 *   - Local server running on port 3000
 */

import axios from 'axios';
import * as readline from 'readline';
import NorenRestApi from '../prism/RestAPI';

const LOCAL_SERVER = 'http://localhost:3000';

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  try {
    const loginUrl = NorenRestApi.getOAuthURL();
    console.log('[Shoonya Login] Open this URL in your browser and log in:');
    console.log(loginUrl);
    console.log('[Shoonya Login] After login, Shoonya shows an "Access restricted" page —');
    console.log('[Shoonya Login] copy the "code" value from the browser\'s address bar.');

    const code = await promptUser('Enter code: ');
    if (!code) {
      throw new Error('code cannot be empty');
    }

    console.log('[Shoonya Login] Completing token exchange with local server...');
    const tokenExchangeUrl = `${LOCAL_SERVER}/prism/token?code=${code}`;
    const tokenResponse = await axios.get(tokenExchangeUrl);
    console.log(`[Shoonya Login] Token exchange status: ${tokenResponse.status}`);

    console.log('[Shoonya Login] Re-establishing WebSocket connection...');
    const connectResponse = await axios.get(`${LOCAL_SERVER}/connect`);
    console.log(`[Shoonya Login] WebSocket connection status: ${connectResponse.status}`);

    console.log('[Shoonya Login] SUCCESS - Login completed and WebSocket connected');
    process.exit(0);
  } catch (error: any) {
    console.error('[Shoonya Login] ERROR:', error.message || error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
