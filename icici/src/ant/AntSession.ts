import axiosModule from 'axios';
import { createHash } from 'crypto';
import Log from '../util/Log';
import ANT from './ANT';

// Separate instance to avoid the global axios response interceptor registered
// by src/prism/RestAPI.ts (Shoonya), which unwraps response.data and returns
// it in place of the full AxiosResponse - see ANT.ts for the same workaround.
const axios = axiosModule.create();

class AntSession {
  private static instance: AntSession;
  private oauthBaseUrl = 'https://a3.aliceblueonline.com/open-api/od/v1/';

  static getInstance(): AntSession {
    if (!AntSession.instance) {
      AntSession.instance = new AntSession();
    }
    return AntSession.instance;
  }

  // This account is on AliceBlue's OAuth-only platform (no classic userId+apiKey
  // was ever provisioned - getAPIEncpkey returns "API key not available" regardless
  // of input). The websocket session_id for this platform is the OAuth userSession
  // itself, not a value returned by createWsSess (whose response body is discarded,
  // matching pya3's classic createSocketSess which also returns no new token -
  // it's a "prepare" call, not a token source).
  async getSessionId(): Promise<string> {
    const ant = ANT.getInstance();
    const userSession = ant.getUserSession();

    if (!userSession) {
      throw new Error('ANT userSession not available. Complete OAuth login first (/ant/login).');
    }

    return userSession;
  }

  async prepareWsSession(sessionId: string): Promise<void> {
    const ant = ANT.getInstance();
    const userId = ant.getUserId();

    if (!userId) {
      throw new Error('ANT userId not available');
    }

    const headers = {
      Authorization: `Bearer ${sessionId}`,
      'Content-Type': 'application/json',
    };

    const payload = { source: 'API', userId };

    Log.log('[AntSession] Creating WS session (createWsSess)...');
    const createResp = await axios.post(this.oauthBaseUrl + 'profile/createWsSess', payload, {
      headers,
    });
    Log.log('[AntSession] createWsSess response:', createResp.data);
    if (createResp.data?.status !== 'Ok') {
      throw new Error('Failed to create WS session: ' + JSON.stringify(createResp.data));
    }

    Log.log('[AntSession] WS session prepared successfully');
  }

  getSusertoken(sessionId: string): string {
    const hash1 = createHash('sha256').update(sessionId).digest('hex');
    const hash2 = createHash('sha256').update(hash1).digest('hex');
    return hash2;
  }
}

export default AntSession;
