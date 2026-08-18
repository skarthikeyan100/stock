import dns from 'dns';
// This machine is dual-stack; Node prefers IPv6 by default for outbound requests,
// which bypasses Zerodha/Kite's IPv4-only IP allowlist. Force IPv4 first so calls
// to api.kite.trade (and everything else) go out on the whitelisted IPv4 address.
dns.setDefaultResultOrder('ipv4first');

import Log from './util/Log';
// import http from 'http'
// import url from 'url'
// import { directionalTrade, balanceTrade, getOpenPositions, getNiftyQuote, squareOff } from './functions'
// import Icici from './trade/icici';


// Icici.getInstance() //to start a browser
// http.createServer(function (req, res) {
//     try {
//         var q = url.parse(req.url, true).query;
//         res.setHeader('Content-Type', 'application/json');
//         Log.log('Command ', q.command)
//         switch (q.command) {
//             case 'strategy':
//                 const strategy = q.strategy
//                 if (strategy == 'balance') {
//                     balanceTrade().then((result) => {
//                         res.end(JSON.stringify({ executed: 'balanceStrategy' }));
//                     }).catch((e) => {
//                         res.statusCode = 500;
//                         Log.log('Error caught in the server ', e)
//                         res.end(JSON.stringify({ error: e.message }));
//                     });
//                 } else if (strategy == 'directional') {
//                     directionalTrade().then((result) => {
//                         res.end(JSON.stringify({ executed: 'directionalStrategy' }));
//                     }).catch((e) => {
//                         res.statusCode = 500;
//                         Log.log('Error caught in the server ', e)
//                         res.end(JSON.stringify({ error: e.message }));
//                     });
//                 }
//                 break;
//             case 'open':
//                 getOpenPositions().then((result) => {
//                     res.end(JSON.stringify(result));
//                 });
//                 break;
//             case 'quote':
//                 getNiftyQuote().then((result) => {
//                     res.end(JSON.stringify(result));
//                 });
//                 break;
//             case 'squareoff':
//                 const contract = q.contract
//                 const market = q.market

//                 squareOff(contract, market).then((result) => {
//                     res.end(JSON.stringify(result));
//                 }).catch((e) => {
//                     Log.log('Error caught in the server')
//                     res.end(e);
//                 })
//                 break;

//             default:
//                 res.statusCode = 500;
//                 res.end(JSON.stringify({ 'error': 'not allowed' }))
//         }

//     } catch (e) {
//         res.statusCode = 500;
//         res.end(e)
//     }

// }).listen(8080);
// Log.log('Server is listening at 8080')
Log.log('Hello')

const mockOpenPositions = [
    {
        "stockCode": "NIFTY",
        "expiryDate": "06-Oct-2022",
        "strikePrice": "17250",
        "right": "Call",
        "action": "NA",
        "quantity": "100",
        "cost": 50,
        "ltp": 25
    }];

const mockRuntimeQuote = {
    ltp: 17480.6,
    // ltt: '23-Sep-2022 10:00:27',
    ltt: 'Thu Sep 29 08:33:20 2022',
    open: 17593.85,
    high: 17642.15,
    low: 17435.55,
    close: undefined,
    prevClose: 17629.8
}

const mockEvent = { 'symbol': '4.1!NIFTY 50', 'open': 16993.6, 'last': 16801.8, 'high': 17026.05, 'low': 16788.6, 'change': -0.34, 'bPrice': 'None', 'bQty': 'None', 'sPrice': 'None', 'sQty': 'None', 'ltq': 'None', 'avgPrice': 'None', 'quotes': 'Quotes Data', 'ttq': 'None', 'totalBuyQt': 'None', 'totalSellQ': 'None', 'ttv': '', 'trend': '-', 'lowerCktLm': 'None', 'upperCktLm': 'None', 'ltt': 'Thu Sep 29 08:33:20 2022', 'close': 16858.6, 'exchange': 'NSE Equity', 'stock_name': 'NIFTY 50' };

let prevClose: 0;

import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import Util from './util';
import axios from 'axios';
import path from 'path'
import delay from 'delay'
import moment from 'moment'
import 'moment-timezone';
import myEmitter from './tools/emitter';
import indexMap from './nse_index';
import candleManager from './candle';
import Monitor from './monitor';
import { CronJob } from 'cron';
import { Trade, Message } from './model/model';
import configService  from "./prism/ConfigService";
import { getOrCreateUser, getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole } from './user';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import Decision from './decision';



// class MyEmitter extends EventEmitter { }

// const myEmitter = new MyEmitter();

var app = express();
// var expressWs = require('express-ws')(app);

app.use(express.static('public'))
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser());
app.use(cookieParser('propfirm-secret'));
app.disable('etag');
// expressWs.ws('/echo', function(ws, req) {
//     ws.on('message', function(msg) {
//       ws.send(msg);
//     });
//   });
import fs, { watchFile } from 'fs'
import Queue from 'async-await-queue';
import Prism from './prism';
import Config from './prism/config';
import { NiftyQuote, OptionQuote } from './model/model';
import Mongo from './tools/mongo';
import { NIFTY, BANKNIFTY } from './constants';
import strategies from './strategy/strategies';
import DiffStrategy from 'strategy/DiffStrategy';
import ANT from './ant/ANT';
import AntStream from './ant/AntStream';
import Zerodha from './zerodha/Zerodha';

let apiSession = '1644073';
let sessionToken = 'U0VTSEExMDA6ODAyMDc4';

let demoLogger = (req, res, next) => {

    18601231122
    Log.log("Request: ", req.method, req.url);
    res.on("finish", () => {
        Log.log("Response: ", res.statusCode);
    });
    next();
};

// app.use(demoLogger);
const sleep = async (milliseconds) => {
    await new Promise(resolve => {
        return setTimeout(resolve, milliseconds)
    });
};

const _start = async () => {
    const prism = Prism.getInstance();
    await prism.connect();
    sleep(3000);
    // await prism.buyIndex({ user: 'Default', index: 'NIFTY' })
    // await prism.buyIndex({ user: 'Default', index: 'BANKNIFTY' })

}


// Helper: resolve user from session cookie, fallback to X-User-Id header
function resolveUser(req: express.Request): string {
    const cookieEmail = req.signedCookies?.session;
    if (cookieEmail) return cookieEmail;
    return (req.headers['x-user-id'] as string) || 'Default';
}

// Auth endpoints
app.post('/auth/login', async function (req, res) {
    try {
        const { email, name, picture } = req.body;
        if (!email) {
            res.status(400).json({ error: 'Email is required' });
            return;
        }
        const user = await getOrCreateUser(email, name || '', picture || '');
        // Cache user settings in Monitor
        Monitor.getInstance().updateUserSettings(email, { lossLimit: user.lossLimit, lotLimit: user.lotCount, investmentMode: user.investmentMode, investmentAmount: user.investmentAmount });
        res.cookie('session', email, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json(user);
    } catch (e) {
        console.error('Auth login error:', e);
        res.sendStatus(500);
    }
});

app.get('/auth/me', async function (req, res) {
    const email = req.signedCookies?.session;
    if (!email) {
        res.sendStatus(401);
        return;
    }
    try {
        const user = await getUser(email);
        if (!user) {
            res.sendStatus(401);
            return;
        }
        res.json(user);
    } catch (e) {
        console.error('Auth me error:', e);
        res.sendStatus(500);
    }
});

app.post('/auth/logout', function (req, res) {
    res.clearCookie('session');
    res.sendStatus(200);
});

app.get('/users', async function (req, res) {
    try {
        const users = await getAllUsers();
        const monitor = Monitor.getInstance();
        const result = users.map(u => ({
            ...u,
            sessionPnL: monitor.userPnL.get(u.email) || 0,
            hasActiveTrade: monitor.hasActiveTrade(u.email),
        }));
        res.json(result);
    } catch (e) {
        console.error('Get users error:', e);
        res.sendStatus(500);
    }
});

app.post('/users/:email/settings', async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, lotCount, investmentMode, investmentAmount } = req.body;
        const user = await updateUserSettings(email, { lossLimit, lotCount, investmentMode, investmentAmount });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        // Update monitor cache
        Monitor.getInstance().updateUserSettings(email, { lossLimit: user.lossLimit, lotLimit: user.lotCount, investmentMode: user.investmentMode, investmentAmount: user.investmentAmount });
        res.json(user);
    } catch (e) {
        console.error('Update settings error:', e);
        res.sendStatus(500);
    }
});

app.post('/users', async function (req, res) {
    try {
        const { email, name, lossLimit, lotCount, role } = req.body;
        if (!email || !name) {
            res.status(400).json({ error: 'Email and name are required' });
            return;
        }
        const user = await createUser(
            email,
            name,
            lossLimit || 15000,
            lotCount || 10,
            role || 'user'
        );
        // Initialize in Monitor cache
        Monitor.getInstance().updateUserSettings(email, { lossLimit: user.lossLimit, lotLimit: user.lotCount, investmentMode: user.investmentMode, investmentAmount: user.investmentAmount });
        res.json(user);
    } catch (e: any) {
        console.error('Create user error:', e);
        if (e.message === 'User already exists') {
            res.status(409).json({ error: 'User already exists' });
        } else {
            res.sendStatus(500);
        }
    }
});

app.delete('/users/:email', async function (req, res) {
    try {
        const { email } = req.params;
        const success = await deleteUser(email);
        if (!success) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Delete user error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/role', async function (req, res) {
    try {
        const { email } = req.params;
        const { role } = req.body;
        if (!role) {
            res.status(400).json({ error: 'Role is required' });
            return;
        }
        const user = await updateUserRole(email, role);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(user);
    } catch (e: any) {
        console.error('Update role error:', e);
        if (e.message.includes('Invalid role')) {
            res.status(400).json({ error: e.message });
        } else {
            res.sendStatus(500);
        }
    }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.patch('/users/:email/profile', async function (req, res) {
    try {
        const { email } = req.params;
        const { phone } = req.body;
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: { phone } });
        res.json({ ...user, phone });
    } catch (e) {
        console.error('Profile update error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/verify', async function (req, res) {
    try {
        const { email } = req.params;
        const { field, verified } = req.body;
        const validFields: Record<string, string> = {
            email: 'emailVerified', phone: 'phoneVerified',
            address: 'addressVerified', dob: 'dobVerified', pan: 'panVerified',
        };
        if (!validFields[field]) {
            res.status(400).json({ error: 'field must be email, phone, address, dob, or pan' }); return;
        }
        const update = { [validFields[field]]: verified };
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: update });
        res.json({ ...user, ...update });
    } catch (e) {
        console.error('Verify update error:', e);
        res.sendStatus(500);
    }
});

app.post('/users/:email/documents/:docType', upload.single('file'), async function (req, res) {
    try {
        const { email, docType } = req.params;
        if (docType !== 'address' && docType !== 'dob' && docType !== 'pan') {
            res.status(400).json({ error: 'docType must be address, dob, or pan' }); return;
        }
        if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
        const filename = `${email}_${docType}_${Date.now()}_${req.file.originalname}`;
        const uploadStream = bucket.openUploadStream(filename, { contentType: req.file.mimetype });
        uploadStream.end(req.file.buffer);

        await new Promise<void>((resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
        });

        const fieldMap: Record<string, string> = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId' };
        const field = fieldMap[docType];
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: { [field]: uploadStream.id.toString() } });
        res.json({ id: uploadStream.id.toString(), filename });
    } catch (e) {
        console.error('Document upload error:', e);
        res.sendStatus(500);
    }
});

app.get('/users/:email/documents/:docType', async function (req, res) {
    try {
        const { email, docType } = req.params;
        if (docType !== 'address' && docType !== 'dob' && docType !== 'pan') {
            res.status(400).json({ error: 'docType must be address, dob, or pan' }); return;
        }
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const fieldMap2: Record<string, string> = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId' };
        const fileId = (user as any)[fieldMap2[docType]];
        if (!fileId) { res.status(404).json({ error: 'Document not found' }); return; }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
        const files = await bucket.find({ _id: new ObjectId(fileId) }).toArray();
        if (!files.length) { res.status(404).json({ error: 'File not found' }); return; }

        res.setHeader('Content-Type', files[0].contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${files[0].filename}"`);
        bucket.openDownloadStream(new ObjectId(fileId)).pipe(res);
    } catch (e) {
        console.error('Document download error:', e);
        res.sendStatus(500);
    }
});

let authorizationCode = '';
let antAccessToken: string | null = null;
let zerodhaAccessToken: string | null = null;

app.get('/prism/oauthurl', function (_req, res) {
    const url = Prism.getInstance().getOAuthURL();
    res.json({ url });
})

app.get('/prism/login', async function (req, res) {
    try {
        const url = Prism.getInstance().getOAuthURL();
        Log.log('Redirecting to Shoonya authorization:', url);
        res.redirect(302, url);
    } catch (e: any) {
        Log.log('Shoonya login error:', e);
        res.status(500).json({ error: 'Failed to initiate Shoonya login' });
    }
});

app.get('/prism/callback', async function (req, res) {
    const code = req.query.code as string;

    if (!code) {
        res.status(400).json({ error: 'No authorization code received' });
        return;
    }

    try {
        authorizationCode = code;
        Log.log('Authorization code received, exchanging for token');
        await Prism.getInstance().loginWithGenAcsTok(code);
        Log.log('Shoonya authentication successful.');
        res.redirect(302, '/app');
    } catch (e: any) {
        Log.log('Shoonya callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
})

app.get('/prism/authcode', function (_req, res) {
    if (!authorizationCode) {
        res.status(404).json({ error: 'No authorization code stored' });
        return;
    }
    res.json({ code: authorizationCode });
})

app.get('/prism/quick-login', async function (req, res) {
    Log.log("Logging in with QuickAuth");
    try {
        const { otp } = req.query;
        const prism = Prism.getInstance();
        await prism.login(req.query.otp as string);
        res.sendStatus(200)

        // const breeze = await Breeze.getInstance();
        // await breeze.login();

        // await updateStatus();

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/prism/token', async function (req, res) {
    Log.log("Logging in with GenAcsTok");
    try {
        const { code } = req.query;
        if (!code) {
            res.status(400).json({ error: 'code parameter required' });
            return;
        }
        const prism = Prism.getInstance();
        await prism.loginWithGenAcsTok(req.query.code as string);
        res.sendStatus(200)
    } catch (e) {
        Log.log('GenAcsTok login error:', e)
        res.sendStatus(500)
    }
})

// ANT (Alice Blue) OAuth Endpoints
app.get('/ant/login', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const authUrl = ant.getAuthorizationUrl();
        Log.log('Redirecting to ANT authorization:', authUrl);
        res.redirect(302, authUrl);
    } catch (e: any) {
        Log.log('ANT login error:', e);
        res.status(500).json({ error: 'Failed to initiate ANT login' });
    }
});

app.get('/ant/callback', async function (req, res) {
    try {
        const authCode = req.query.authCode as string;
        const userId = req.query.userId as string;

        if (!authCode || !userId) {
            Log.log('Missing authCode or userId in callback');
            res.status(400).json({ error: 'Missing authCode or userId from Alice Blue' });
            return;
        }

        Log.log('ANT Callback received - exchanging authCode for token');
        const ant = ANT.getInstance();
        const result = await ant.exchangeAuthCodeForToken(userId, authCode);

        // Store token in memory for retrieval
        antAccessToken = result.userSession;

        // Store token in session cookie
        res.cookie('ant_session', result.userSession, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

        Log.log('ANT Authentication successful. Token stored.');

        // Redirect to app dashboard (transparent to user)
        res.redirect(302, '/app');
    } catch (e: any) {
        Log.log('ANT callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

// Get stored ANT access token (for frontend)
app.get('/ant/token', async function (req, res) {
    if (!antAccessToken) {
        res.status(401).json({ error: 'No ANT access token available. Please login first.' });
        return;
    }
    res.json({ access_token: antAccessToken });
});

// Get ANT open positions
app.get('/ant/positions', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const positions = await ant.getPositions();
        res.json({ success: true, positions, count: Array.isArray(positions) ? positions.length : 0 });
    } catch (e: any) {
        Log.log('Error fetching ANT positions:', e.message);
        res.status(500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

// Get ANT trade list
app.get('/ant/trades', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const trades = await ant.getTrades();
        res.json({ success: true, trades, count: Array.isArray(trades) ? trades.length : 0 });
    } catch (e: any) {
        Log.log('Error fetching ANT trades:', e.message);
        res.status(500).json({ error: 'Failed to fetch trades', details: e.message });
    }
});

// Zerodha OAuth Endpoints
app.get('/kite/login', async function (req, res) {
    try {
        const zerodha = Zerodha.getInstance();
        const loginUrl = zerodha.getLoginURL();
        Log.log('Redirecting to Zerodha login:', loginUrl);
        res.redirect(302, loginUrl);
    } catch (e: any) {
        Log.log('Zerodha login error:', e);
        res.status(500).json({ error: 'Failed to initiate Zerodha login' });
    }
});

app.get('/kite/callback', async function (req, res) {
    try {
        const requestToken = req.query.request_token as string;

        if (!requestToken) {
            Log.log('Missing request_token in Zerodha callback');
            res.status(400).json({ error: 'Missing request_token from Zerodha' });
            return;
        }

        Log.log('Zerodha Callback received - exchanging request_token for access_token');
        const zerodha = Zerodha.getInstance();
        const result = await zerodha.exchangeRequestTokenForSession(requestToken);

        // Store token in memory for retrieval
        zerodhaAccessToken = result.access_token;

        // Store token in session cookie
        res.cookie('zerodha_session', result.access_token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

        Log.log('Zerodha Authentication successful. Token stored.');

        // Redirect to app dashboard (transparent to user)
        res.redirect(302, '/app');
    } catch (e: any) {
        Log.log('Zerodha callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

// Get stored Zerodha access token (for frontend)
app.get('/kite/token', async function (req, res) {
    if (!zerodhaAccessToken) {
        res.status(401).json({ error: 'No Zerodha access token available. Please login first.' });
        return;
    }
    res.json({ access_token: zerodhaAccessToken });
});

// Zerodha Trading Endpoints
app.get('/kite/trades', async function (req, res) {
    try {
        const zerodha = Zerodha.getInstance();
        const trades = await zerodha.getTrades();
        res.json({ trades });
    } catch (e: any) {
        Log.log('Zerodha trades error:', e);
        res.status(500).json({ error: 'Failed to fetch trades', details: e.message });
    }
});

app.get('/kite/positions', async function (req, res) {
    try {
        const zerodha = Zerodha.getInstance();
        const positions = await zerodha.getPositions();
        res.json({ positions });
    } catch (e: any) {
        Log.log('Zerodha positions error:', e);
        res.status(500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

// ANT Trading Endpoints
app.get('/ant/trades', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const trades = await ant.getTrades();
        res.json({ trades });
    } catch (e: any) {
        Log.log('ANT trades error:', e);
        res.status(500).json({ error: 'Failed to fetch trades', details: e.message });
    }
});

app.get('/ant/positions', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const positions = await ant.getPositions();
        res.json({ positions });
    } catch (e: any) {
        Log.log('ANT positions error:', e);
        res.status(500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

app.get('/ant/connect', async function (req, res) {
    try {
        const stream = AntStream.getInstance();
        await stream.connect();
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('ANT connect error:', e);
        res.status(500).json({ error: 'Failed to connect to ANT streaming', details: e.message });
    }
});

app.get('/ant/stream', function (req, res) {
    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendData = (data: any) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        myEmitter.on('ant-quote', sendData);

        req.on('close', () => {
            myEmitter.off('ant-quote', sendData);
        });
    } catch (e: any) {
        Log.log('ANT stream error:', e);
        res.status(500).json({ error: 'Failed to start ANT stream', details: e.message });
    }
});

app.get('/prism/orderbook', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        const orders = await prism.getOrders();
        Log.log('Orders: ' + orders)
        res.send(orders);
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }

})

app.get('/start', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        await prism.buyIndex({ userContext: Monitor.getInstance().getUserContext('Default'), index: 'NIFTY' })
        await prism.buyIndex({ userContext: Monitor.getInstance().getUserContext('Default'), index: 'BANKNIFTY' })
        res.sendStatus(200);
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }

})

app.get('/stats', async function (req: express.Request, res) {
    const allStats = strategies.getList().map(s => s.getStats());

    const cols = ['Strategy', 'Trades', 'Wins', 'Losses', 'Timeouts', 'Win%', 'P&L'];
    const rows = allStats.map(s => [
        s.userId,
        String(s.totalTrades),
        String(s.wins),
        String(s.losses),
        String(s.timeouts),
        s.winRate !== null ? `${s.winRate}%` : 'N/A',
        String(s.totalPnL),
    ]);

    const widths = cols.map((c, i) =>
        Math.max(c.length, ...rows.map(r => r[i].length))
    );
    const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const fmt = (r: string[]) => '|' + r.map((v, i) => ` ${v.padEnd(widths[i])} `).join('|') + '|';

    const lines = [sep, fmt(cols), sep, ...rows.map(fmt), sep];
    res.type('text/plain').send(lines.join('\n'));
})

app.get('/strategies', async function (req: express.Request, res) {
    try {
        const { strategy, userId, enable} = req.query;
        const identifier = (userId || strategy) as string;
        if (identifier && enable !== undefined) {
            strategies.getList().forEach((s) => {
                if (s.userId === identifier || s.getClassName() === identifier) {
                    s.enabled = enable == 'true';
                }
            });
        }
        res.json(strategies.getList().map(s => ({
            type: s.getClassName(),
            userId: s.userId,
            enabled: s.enabled
        })));
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }

})

app.get('/addTrade', async function (req: express.Request, res) {
    try {
        const trantype = 'B'
        const { tsym, flqty, flprc} = req.query;
        const data = {tsym, flqty, flprc, trantype}
        Monitor.getInstance().updateTrade(data)
        res.sendStatus(200);
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }

})

app.get('/openTrades', async function (req: express.Request, res) {
    try {
        const trades = Monitor.getInstance().trades
        res.send(trades)
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }

})


// http://localhost:3000/prism/order/buy?index=NIFTY&right=call&strikePrice=20500&price=42.5
// NOTE: this only ever places a buy order — buyContract/buyIndex/sendLimitOrder all hardcode
// trantype 'B' at the broker level, so there is currently no sell-to-open endpoint.
app.get('/prism/order/buy', async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract, triggerPrice } = req.query;
        const user = resolveUser(req);
        Log.log('Resolved order while placing an order ', user)

        const monitor = Monitor.getInstance();
        const validation = monitor.canPlaceOrder(user);
        if (!validation.allowed) {
            Log.log(`[Order] Rejected for user '${user}': ${validation.reason}`);
            res.status(403).json({ error: 'ORDER_REJECTED', message: validation.reason });
            return;
        }
        monitor.pendingUsers.add(user);

        const prism = Prism.getInstance();

        // let niftyQuote;
        // niftyQuote = await prism.getQuote(index as string);

        // const niftyPrice = niftyQuote.ltp;
        // var expiryDate = Util.findExpiryDate();
        // var expiryDate = Util.findExpiryDate();
        // var strikePrice = Util.findStrikePrice(niftyPrice, parseInt(depth as string), right);


        // const breeze = await Breeze.getInstance();
        // const quote: OptionQuote = await breeze.getOptionQuote(expiryDate, strikePrice, right);


        // await breeze.sendLimitOrder(expiryDate, strikePrice, quote.ltp, right, action);
        // await breeze.subscribeOption(expiryDate, strikePrice, right);

        const nseIndex = indexMap.get(index as string);
        const userContext = monitor.getUserContext(user);

        Log.log('strikePrice: ', strikePrice, ' right: ', right)
        if (contract) {
            Log.log('Buy contract: ', contract)
            await prism.buyContract(contract as string, undefined, undefined, userContext);
        } else {
            if (right && !strikePrice) {
                await prism.buyIndex({ userContext, index: index as string, right: right as string })
            } else if (!strikePrice && !right) {
                await prism.buyIndex({ userContext, index: index as string })
            } else {
                const token = await nseIndex.findTokenFor(index as string, right as string, parseInt(strikePrice as string));

                let optionPrice = parseInt(price as string);
                if (price == null || price == undefined) {
                    Log.log('Trying to fetch quote')
                    const tokenAsInt = await prism.getToken(token)
                    const quote: NiftyQuote = await prism.getOptionQuote(tokenAsInt);
                    Log.log('NifyQuote: ', NiftyQuote)
                    optionPrice = quote.ltp;

                } else {
                    Log.log('OPTION PRICE IS NAN')
                }

                await prism.sendLimitOrder(token, optionPrice, right as string, 'buy', null, userContext);

            }

        }

        res.sendStatus(200);

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/connect', async function (req: express.Request, res) {
    const prism = Prism.getInstance();
    try {
        await prism.connect();
        res.sendStatus(200);
    } catch (e) {
        Log.log("Error while connecting to prism ", e)
        res.sendStatus(500);
    }
})


app.get('/subscribe', async function (req: express.Request, res) {
    // Touchline quote subscription has moved to ANT (see /ant/connect) -
    // Prism's socket now stays connected solely for order-fill notifications.
    res.sendStatus(200);
})



const mockTrades = [{ "token": "54033", "orderno": "23041000314509", "stockCode": "NIFTY", "action": "Buy", "cost": "67.25", "quantity": 200, "expiryDate": "20APR23", "right": "call", "strikePrice": "17800" }];
app.get('/trades', async function (req: express.Request, res) {
    try {
        const user = resolveUser(req);
        const prism = Prism.getInstance();
        const allTrades = await prism.getTradeList();
        const userTrades = allTrades.filter((t: Trade) => t.user === user);
        res.send(userTrades);
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/closedtrades', async function (req: express.Request, res) {
    try {
        const user = resolveUser(req);
        const monitor = Monitor.getInstance();
        const allClosedTrades = monitor.getClosedTrades();
        const userClosedTrades = allClosedTrades.filter((t: Trade) => t.user === user);
        res.send(userClosedTrades);
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/refreshtrades', async function (req: express.Request, res) {
    try {
        // const breeze = Breeze.getInstance();
        // res.send(await breeze.getTradeList());

        const prism = Prism.getInstance();
        const openTrades : Trade[] = await prism.refreshTradeList()
        const orders = await prism.getOrders();
        res.send(openTrades);
        Monitor.getInstance().refreshTrades(openTrades)
        Monitor.getInstance().refreshPendingOrders(orders)

        // res.send(mockTrades);

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/subscribetrades', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        const openTrades : Trade[] = await prism.refreshTradeList()
        Monitor.getInstance().subscribeTrades(openTrades)
        res.send(200);

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})


// http://localhost:3000/prism/squareoff?expiryDate=27-Oct-2022&right=call&strikePrice=17600

app.get('/prism/squareoff', async function (req: express.Request, res) {
    try {

        const { token, expiryDate, strikePrice, right, qty } = req.query;
        const user = resolveUser(req);

        // const breeze = await Breeze.getInstance();
        // await breeze.sendMarketOrder(expiryDate, strikePrice, right, 'sell');
        // await breeze.unsubscribeOption(expiryDate, strikePrice, right);

        const prism = await Prism.getInstance();

        prism.squareOffOrder(token, qty, user)
        res.sendStatus(200);

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.post('/prism/settarget', express.json(), async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints, trailingDistance } = req.body;
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        const user = resolveUser(req);
        const monitor = Monitor.getInstance();
        monitor.setTargetStopLoss(token, targetPoints, stopLossPoints, trailingDistance ?? configService.getConfig().settings.trailingDistance, user);
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
})

app.get('/niftystream', async function (req, res) {

    const callback = (t) => {
        res.write(`data: ${JSON.stringify(t)}\n\n`);
    };

    req.connection.addListener('close', function () {
        Log.log('Connection is closed, remove nifty listener')
        myEmitter.removeListener('nifty', callback);
    });
    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');

    //Subscribe for FirstEvent
    const listenerCount = myEmitter.listenerCount('nifty');
    Log.log("Nifty Listener count ", listenerCount);
    Log.log(`Host: ${req.host}`);
    myEmitter.on('nifty', callback);
})

app.get('/optionstream', async function (req, res) {

    const callback = (t) => {
        res.write(`data: ${JSON.stringify(t)}\n\n`);
    };

    req.connection.addListener('close', function () {
        Log.log('Connection is closed, remove nifty listener')
        myEmitter.removeListener('option', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');
    let count = 0;

    //Subscribe for FirstEvent
    const listenerCount = myEmitter.listenerCount('option');
    Log.log("Option Listener count ", listenerCount);
    myEmitter.on('option', callback);
})

app.get('/positionstream', async function (req, res) {
    const user = resolveUser(req);
    const monitor = Monitor.getInstance();

    const callback = (allTrades) => {
        const userActiveTrades = allTrades.filter((t: Trade) => t.user === user);
        const userClosedTrades = monitor.getClosedTrades().filter((t: Trade) => t.user === user);
        const allUserTrades = [
            ...userActiveTrades.map(t => ({ ...t, open: t.open !== false ? true : false })),
            ...userClosedTrades.map(t => ({ ...t, open: false })),
        ];
        res.write(`data: ${JSON.stringify(allUserTrades)}\n\n`);
    };

    req.connection.addListener('close', function () {
        Log.log('Connection is closed, remove position listener for user:', user)
        myEmitter.removeListener('position', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');

    const listenerCount = myEmitter.listenerCount('position');
    Log.log("Position Listener count ", listenerCount, " user:", user);
    myEmitter.on('position', callback);
})

app.get('/test', async function (req, res) {
    const { index } = req.query;
    const prism = Prism.getInstance();
    // prism.findDirectionAndStrikePrice(index as string);
    await prism.getOptionChain()
    res.send('Done')
})


app.get('/quotes', async function (req, res) {

    // res.send(mockRuntimeQuote);
    try {
        const prism = Prism.getInstance();
        let result = {} as any
        result.nifty = await prism.getNiftyQuote();  // Nifty Quotes
        result.bankNifty = await prism.getBankNiftyQuote();  // Nifty Quotes
        result.finNifty = await prism.getFinNiftyQuote();  // Nifty Quotes

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // Log.log('Response in server ', response)
        res.send(result)

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/niftyquote', async function (req, res) {

    // res.send(mockRuntimeQuote);
    try {
        const response = await Prism.getInstance().getNiftyQuote();  // Nifty Quotes
        Log.log('Quotes: ', response);

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // Log.log('Response in server ', response)
        res.send(response)

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/quote', async function (req, res) {

    const { symbol } = req.query;
    // res.send(mockRuntimeQuote);
    try {
        const response = await Prism.getInstance().getStockQuote(symbol as string);  // Nifty Quotes
        Log.log('Quotes: ', response);

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // Log.log('Response in server ', response)
        res.send(response)

    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/requestOtp', async function (req, res) {
    try {
        Log.log('Requesting OTP');
        await Prism.getInstance().requestOtp();
        res.send("Requested OTP");
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

app.get('/search', async function (req, res) {
    Log.log('Len: ', req.query);
    const { depth, right, index } = req.query;
    const nseIndex = indexMap.get(index as string);
    const token = await nseIndex.findToken(index as string, parseInt(depth as string), right as string);
    res.send("{ token: " + token + "}");

});

app.get('/logout', async function (req, res) {
    await Prism.getInstance().logout();
});

app.get('/candles', async function (req, res) {

    try {
        const candles = candleManager.getCandleData('NIFTY', 15);
        res.send(candles)
    } catch (e) {
        Log.log(e)
        res.sendStatus(500)
    }
})

// app.get('/config', async function (req, res) {
//     Log.log('In Config ' + JSON.stringify(req.query));
//     const targetPrice = parseInt(req.query.targetPrice as string);
//     if (targetPrice) {
//         if (targetPrice == 0 ) {
//             Config.targetPriceDiff = 100;
//         } else {
//             Config.targetPriceDiff = targetPrice;
//         }
//     }

//     const depth = parseInt(req.query.depth as string);
//     if (depth) {
//         Config.depth = depth;
//     }

//     const lotSize = parseInt(req.query.lotSize as string);
//     if (lotSize) {
//         Config.lotCount = lotSize;
//     }

//     Log.log(Config.targetPriceDiff)
// });

app.get('/config', (req, res) => {
    res.json(configService.configToFlat());
});

app.post('/config', (req, res) => {
    const flat = req.body;
    configService.writeConfig(configService.flatToConfig(flat));
    res.json(flat);
});

var route, routes = [];

app._router.stack.forEach(function (middleware) {
    if (middleware.route) { // routes registered directly on the app
        routes.push(middleware.route.path);
    } else if (middleware.name === 'router') { // router middleware 
        middleware.handle.stack.forEach(function (handler) {
            route = handler.route;
            route && routes.push(route.path);
        });
    }
});


var BreezeConnect = require('breezeconnect').BreezeConnect;
Log.log(routes)

// const { RSI } = require('technicalindicators');

// // Example: RSI calculation for a given period and price array
// const prices = [44, 47, 49, 52, 48, 47, 45, 46, 47, 46, 45, 44];
// const period = 5;

// const rsiInput = {
//   values: prices,
//   period: period
// };

// const rsiValues = RSI.calculate(rsiInput);
// Log.log(rsiValues)

// Replay historical quotes for a date through the real-time candle-building path.
// Produces [VERIFY] Candle and Signal logs identical to pipeline:fast --date.
app.get('/replay', async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const db = Mongo.getInstance().db;
    const quotes = await db.collection('Quote').find({ date }).sort({ ltt: 1 }).toArray();
    if (quotes.length === 0) return res.status(404).json({ error: `no quotes for date ${date}` });

    const replayDecision = new Decision();
    replayDecision.replayMode = true;
    for (const q of quotes) {
        replayDecision._addPrice(Number(q.ltt), Number(q.ltp));
    }
    replayDecision.flushCandles();

    res.json({ date, processed: quotes.length });
});

// Serve React app for /app and /app/* routes
app.get('/app*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/app/index.html'));
});

var server = app.listen(Number(process.env.PORT) || 3000, async function () {

    Log.log('Icici server started ')
    Prism.getInstance();
    await Mongo.init();
    await strategies.initialize();

    Log.log('********************  Threshold: ', configService.getStrategyConfig('BuySellStrategy').averageThreshold);

    // new CronJob(`0 ${config.startMin} ${config.startHour} * * *`, async function() {
    //     Log.log('Buy Nifty Index')
    //     await _start()
    //     console.info(moment())
    // }, null, true);
    // https://api.icicidirect.com/apiuser/login?api_key=01@oF100100H4eV8=109q287N9J8%2552L
    // http://localhost:3000/?apisession=27529479
    // const icici_apiKey = "01@oF100100H4eV8=109q287N9J8%52L";
    // Log.log("https://api.icicidirect.com/apiuser/login?api_key=" + encodeURI(icici_apiKey));

    // const appKey = "01@oF100100H4eV8=109q287N9J8%52L";
    // const appSecret = "#=f055136JU8R000wE91B094F5J192`5";
    // const apiSession = '27557733';

    // Log.log("Connecting to Breeze")
    // var breeze = new BreezeConnect({"appKey":appKey});
    // Log.log("Generate Session")
    // await breeze.generateSession(appSecret,apiSession)
    // Log.log("Get funds")
    // const fundResponse = breeze.getFunds();
    // Log.log("Funds response: ", fundResponse);

    // breeze.login();
    // Log.log('sessionToken: ', breeze.sessionToken);
    // if (breeze.sessionToken == null || breeze.sessionToken.length == 0) {
    //     breeze.login();
    // }

    // const breeze = Breeze.getInstance();
    // const response = await breeze.getCustomerDetails(apiSession);

    // const localtunnel = require('localtunnel');
    // (async function () {

    //     try {
    //         const tunnel = await localtunnel({
    //             port: 3000, // port or network address, defaults to 80
    //             subdomain: 'skarthikeyan100'
    //         });
    //         Log.log('URL: ', tunnel.url)
    //         tunnel.on('close', () => {
    //             Log.log('tunnels are closed');
    //         });
    //     } catch (e) {
    //         Log.log(e)
    //     }
    // })();
}



)