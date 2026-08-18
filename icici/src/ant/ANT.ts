import { createHash } from 'crypto';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
// Use a separate axios instance to avoid Shoonya interceptors
import axiosModule from 'axios';
const axios = axiosModule.create();

class ANT {
    private static instance: ANT;

    // ANT Configuration - Update these with your actual credentials
    private appKey = 'voMvjS7seC'; // Alice Blue App Key (from developer console)
    private apiSecret = 'U6LMFnm9ZWguxyiurcr37Jd9qCyHVTsu8ZSfZ3JR6mwShz8jk7g6kDRXFu595ZRt3oxFHAtc5CbTk51j4oNmbm0yXgkJQ7TLF72z'; // Alice Blue API Secret
    private redirectUri = 'http://localhost:3000/ant/callback';
    private tokenUrl = 'https://a3.aliceblueonline.com/open-api/od/v1/vendor/getUserDetails';
    private userSession: string | null = null;
    private userId: string | null = null;
    private sessionFile = path.join(__dirname, '../../.ant_session.json');

    private constructor() {
        this.loadSession();
    }

    static getInstance(): ANT {
        if (!ANT.instance) {
            ANT.instance = new ANT();
        }
        return ANT.instance;
    }

    private loadSession(): void {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
                if (data.userSession) {
                    this.userSession = data.userSession;
                }
                if (data.userId) {
                    this.userId = data.userId;
                }
                Log.log('ANT session loaded from file');
            }
        } catch (e) {
            Log.log('Failed to load ANT session:', e);
        }
    }

    private saveSession(): void {
        try {
            fs.writeFileSync(
                this.sessionFile,
                JSON.stringify({ userSession: this.userSession, userId: this.userId })
            );
            Log.log('ANT session saved');
        } catch (e) {
            Log.log('Failed to save ANT session:', e);
        }
    }

    getAuthorizationUrl(): string {
        const url = `https://ant.aliceblueonline.com/?appcode=${encodeURIComponent(this.appKey)}`;
        Log.log('Generated ANT Authorization URL:', url);
        return url;
    }

    async exchangeAuthCodeForToken(userId: string, authCode: string): Promise<{ userSession: string }> {
        try {
            Log.log('=== ANT Token Exchange Starting ===');
            Log.log('userId:', userId);
            Log.log('authCode:', authCode.substring(0, 20) + '...');

            this.userId = userId;

            // Step 1: Compute checksum
            Log.log('\n--- Step 1: Computing checksum ---');
            const checksumInput = userId + authCode + this.apiSecret;
            const checksum = createHash('sha256')
                .update(checksumInput)
                .digest('hex');
            Log.log('✓ Checksum computed:', checksum.substring(0, 20) + '...');

            // Step 2: Exchange for userSession
            Log.log('\n--- Step 2: Exchanging authCode for userSession ---');
            Log.log('POST:', this.tokenUrl);

            const tokenResp = await axios.post(
                this.tokenUrl,
                { checkSum: checksum },
                { headers: { 'Content-Type': 'application/json' } }
            );

            Log.log('Response status:', tokenResp.status);
            Log.log('Response data:', tokenResp.data);

            this.userSession = tokenResp.data?.userSession;
            if (!this.userSession) {
                throw new Error(`Failed to get userSession. Response: ${JSON.stringify(tokenResp.data)}`);
            }

            this.saveSession();

            Log.log('✓ Step 2 Success: userSession obtained');
            Log.log('\n=== ANT Token Exchange Successful! ===\n');

            return {
                userSession: this.userSession
            };
        } catch (e: any) {
            Log.log('\n❌ ANT Token Exchange Failed!');
            Log.log('Error message:', e.message);
            Log.log('Error status:', e.response?.status);
            Log.log('Error data:', e.response?.data);

            let errorMsg = 'Unknown error';
            if (e.response) {
                errorMsg = e.response.data?.emsg || e.response.data?.error || e.message;
            } else if (e.request) {
                errorMsg = `No response from server: ${e.message}`;
            } else {
                errorMsg = e.message;
            }

            throw new Error(`ANT token exchange failed: ${errorMsg}`);
        }
    }

    getUserSession(): string | null {
        return this.userSession;
    }

    getUserId(): string | null {
        return this.userId;
    }

    getApiSecret(): string {
        return this.apiSecret;
    }

    getAppKey(): string {
        return this.appKey;
    }

    setAppKey(key: string): void {
        this.appKey = key;
    }

    setApiSecret(secret: string): void {
        this.apiSecret = secret;
    }

    setRedirectUri(uri: string): void {
        this.redirectUri = uri;
    }

    getRedirectUri(): string {
        return this.redirectUri;
    }

    async getTrades(): Promise<any[]> {
        try {
            if (!this.userSession) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching ANT trades...');

            const tradesResp = await axios.get(
                'https://a3.aliceblueonline.com/open-api/od/v1/orders/trades',
                { headers: { 'Authorization': `Bearer ${this.userSession}` } }
            );

            Log.log('ANT Trades response:', tradesResp.data?.status);
            if (tradesResp.data?.status === 'Ok' && tradesResp.data?.result) {
                return tradesResp.data.result;
            }
            return [];
        } catch (e: any) {
            Log.log('Error fetching ANT trades:', e.message);
            return [];
        }
    }

    async getPositions(): Promise<any> {
        try {
            if (!this.userSession) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching ANT positions...');

            const posResp = await axios.get(
                'https://a3.aliceblueonline.com/open-api/od/v1/positions',
                { headers: { 'Authorization': `Bearer ${this.userSession}` } }
            );

            Log.log('ANT Positions response:', posResp.data?.status);
            if (posResp.data?.status === 'Ok' && posResp.data?.result) {
                return posResp.data.result;
            }
            return [];
        } catch (e: any) {
            Log.log('Error fetching ANT positions:', e.message);
            return [];
        }
    }
}

export default ANT;
