import express from 'express';
import cookieParser from 'cookie-parser';
import { MongoClient } from 'mongodb';

const MONGO_URL = 'mongodb://localhost:27017';
const DB_NAME = 'stocks';

let db;
const mongoClient = new MongoClient(MONGO_URL);
await mongoClient.connect();
db = mongoClient.db(DB_NAME);
console.log('[Mock] Connected to MongoDB');

function usersCol() {
  return db.collection('users');
}

async function getOrCreateUser(email, name, picture) {
  const existing = await usersCol().findOne({ email });
  if (existing) {
    const updates = { name, picture };
    if (existing.lotCount === undefined) updates.lotCount = existing.lotSize ?? 10;
    if (existing.investmentMode === undefined) updates.investmentMode = 'investmentAmount';
    if (existing.investmentAmount === undefined) updates.investmentAmount = 100000;
    await usersCol().updateOne({ email }, { $set: updates });
    return {
      ...existing,
      lotCount: updates.lotCount ?? existing.lotCount,
      investmentMode: updates.investmentMode ?? existing.investmentMode,
      investmentAmount: updates.investmentAmount ?? existing.investmentAmount,
      name,
      picture,
    };
  }
  const ADMIN_EMAILS = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(e => e.trim())
    : ['skarthikeyan100@gmail.com'];
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user';
  const user = { email, name, picture, lossLimit: 15000, lotCount: 10, investmentMode: 'investmentAmount', investmentAmount: 100000, role, createdAt: new Date() };
  await usersCol().insertOne(user);
  return user;
}

const app = express();
app.use(express.json());
app.use(cookieParser('propfirm-secret'));

let trades = [];
let closedTrades = [];
let positionClients = []; // each entry: { res, userId }
let nextId = 1;

// Mock NIFTY quote state
let niftyQuote = { ltp: 22450.30, prevClose: 22324.80, open: 22380.00, high: 22510.00, low: 22300.00, change: 125.50, ltt: '15:22:08' };
let niftyClients = [];

// Tick every 2 seconds — random walk
setInterval(() => {
  const delta = +(Math.random() * 20 - 10).toFixed(2);
  const newLtp = +(niftyQuote.ltp + delta).toFixed(2);
  niftyQuote = {
    ...niftyQuote,
    ltp: newLtp,
    change: +(newLtp - niftyQuote.prevClose).toFixed(2),
    ltt: new Date().toLocaleTimeString('en-IN', { hour12: false }),
  };
  niftyClients.forEach(res => res.write(`data: ${JSON.stringify({ nifty: niftyQuote })}\n\n`));
}, 2000);

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, name, picture } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const user = await getOrCreateUser(email, name || '', picture || '');
    res.cookie('session', email, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json(user);
  } catch (e) {
    console.error('Login error:', e);
    res.sendStatus(500);
  }
});

// GET /auth/me
app.get('/auth/me', async (req, res) => {
  const email = req.signedCookies?.session;
  if (!email) return res.sendStatus(401);
  try {
    const user = await usersCol().findOne({ email });
    if (!user) return res.sendStatus(401);
    res.json(user);
  } catch (e) {
    res.sendStatus(500);
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.sendStatus(200);
});

// GET /users
app.get('/users', async (req, res) => {
  try {
    const users = await usersCol().find({}).toArray();
    const result = users.map(u => ({
      ...u,
      sessionPnL: 0,
      hasActiveTrade: trades.some(t => t.user === u.email),
    }));
    res.json(result);
  } catch (e) {
    res.sendStatus(500);
  }
});

// POST /users/:email/settings
app.post('/users/:email/settings', async (req, res) => {
  const { email } = req.params;
  try {
    const { lossLimit, lotCount, investmentMode, investmentAmount, enabled } = req.body;
    const update = {};
    if (lossLimit !== undefined) update.lossLimit = lossLimit;
    if (lotCount !== undefined) update.lotCount = lotCount;
    if (investmentMode !== undefined) update.investmentMode = investmentMode;
    if (investmentAmount !== undefined) update.investmentAmount = investmentAmount;
    if (enabled !== undefined) update.enabled = enabled;
    await usersCol().updateOne({ email }, { $set: update });
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.sendStatus(500);
  }
});

// GET /config
let mockConfig = {
  settings: { minPrice: 20, maxPrice: 30000, cooldownSeconds: 0, trailingDistance: 3 },
  buySellStrategy: { type: 'BuySellStrategy', enabled: false, initialQuantity: 150, incrementQuantity: 150, averageThreshold: 10, targetPrice: 5, maxIterationCount: 10, right: 'none', stopEnabled: false, logEnabled: false },
  sentimentStrategy: { type: 'SentimentStrategy', enabled: false, averageThreshold: 20, targetPrice: 2, orderQuantity: 7200, sentiment: 'put', loopCount: 1 },
  intermittentStrategy: { type: 'IntermittentStrategy', enabled: false, loopCount: 3, targetPrice: 2, quantity: 75, threshold: 10, logEnabled: false },
  rateOfChangeStrategy: { type: 'RateOfChangeStrategy', enabled: false, pointsThreshold: 30, accelerationThreshold: 5, numberOfDatapointsReceived: 50, quantity: 65, targetPrice: 2, stopLossPrice: 11, maxHoldTimeMinutes: 30, logEnabled: true },
};

app.get('/config', (req, res) => {
  res.json(mockConfig);
});

app.post('/config', (req, res) => {
  mockConfig = req.body;
  res.json(mockConfig);
});

// PATCH /users/:email/role
app.patch('/users/:email/role', async (req, res) => {
  const { email } = req.params;
  const { role } = req.body;
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Invalid role' });
  try {
    await usersCol().updateOne({ email }, { $set: { role } });
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.sendStatus(500);
  }
});

// PATCH /users/:email/profile
app.patch('/users/:email/profile', async (req, res) => {
  const { email } = req.params;
  const { phone } = req.body;
  try {
    await usersCol().updateOne({ email }, { $set: { phone } });
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.sendStatus(500);
  }
});

// PATCH /users/:email/verify
app.patch('/users/:email/verify', async (req, res) => {
  const { email } = req.params;
  const { field, verified } = req.body;
  if (field !== 'email' && field !== 'phone') return res.status(400).json({ error: 'field must be email or phone' });
  try {
    const update = field === 'email' ? { emailVerified: verified } : { phoneVerified: verified };
    await usersCol().updateOne({ email }, { $set: update });
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.sendStatus(500);
  }
});

// POST /users/:email/documents/:docType — stub (stores filename in DB, no real file)
app.post('/users/:email/documents/:docType', async (req, res) => {
  const { email, docType } = req.params;
  if (docType !== 'address' && docType !== 'dob' && docType !== 'pan') return res.status(400).json({ error: 'Invalid docType' });
  const fieldMap = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId' };
  try {
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const field = fieldMap[docType];
    const stubId = `mock_${docType}_${Date.now()}`;
    await usersCol().updateOne({ email }, { $set: { [field]: stubId } });
    res.json({ id: stubId, filename: `${docType}_proof` });
  } catch (e) {
    res.sendStatus(500);
  }
});

// GET /users/:email/documents/:docType — stub
app.get('/users/:email/documents/:docType', async (req, res) => {
  const { email, docType } = req.params;
  try {
    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const getFieldMap = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId' };
    const getField = getFieldMap[docType];
    if (!user[getField]) return res.status(404).json({ error: 'Document not found' });
    res.json({ id: user[getField], filename: `${docType}_proof` });
  } catch (e) {
    res.sendStatus(500);
  }
});

function broadcast() {
  positionClients.forEach(client => {
    const userActiveTrades = trades.filter(t => t.user === client.userId);
    const userClosedTrades = closedTrades.filter(t => t.user === client.userId);
    const allUserTrades = [
      ...userActiveTrades.map(t => ({ ...t, open: true })),
      ...userClosedTrades.map(t => ({ ...t, open: false })),
    ];
    client.res.write(`data: ${JSON.stringify(allUserTrades)}\n\n`);
  });
}

// Helper: resolve user from cookie or header
function resolveUser(req) {
  const cookieEmail = req.signedCookies?.session;
  if (cookieEmail) return cookieEmail;
  return req.headers['x-user-id'] || 'Default';
}

// GET /trades — return current trades for this user
app.get('/trades', (req, res) => {
  const userId = resolveUser(req);
  console.log(`[/trades] userId: ${userId}`);
  res.json(trades.filter(t => t.user === userId));
});

// GET /positionstream — SSE (per-user)
app.get('/positionstream', (req, res) => {
  const userId = resolveUser(req);
  console.log(`[/positionstream] userId: ${userId}`);
  res.set({
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 10000\n\n');

  const client = { res, userId };
  positionClients.push(client);
  req.on('close', () => {
    positionClients = positionClients.filter(c => c !== client);
  });
});

// GET /order?index=NIFTY&right=call&action=Buy&strikePrice=25900
// GET /order?contract=NIFTY10FEB26P21000&action=Buy
app.get('/order', (req, res) => {
  const { index = 'NIFTY', right = 'call', strikePrice = '25000', contract } = req.query;
  const userId = resolveUser(req);
  console.log(`[/order] userId: ${userId}, contract: ${contract || 'none'}, right: ${right}, index: ${index}`);

  const price = +(Math.random() * 80 + 20).toFixed(2);
  const tsym = contract
    ? contract
    : `${index}10FEB26${right === 'call' || right === 'CE' ? 'C' : 'P'}${strikePrice}`;
  const effectiveRight = contract
    ? (contract.includes('P') ? 'put' : 'call')
    : (right === 'put' || right === 'PE' ? 'put' : 'call');

  const trade = {
    _id: String(nextId++),
    user: userId,
    open: true,
    tsym,
    quantity: 65,
    price,
    token: String(40000 + nextId),
    action: 'Buy',
    status: 'COMPLETE',
    right: effectiveRight,
    lastTradePrice: price,
    realizedPnL: 0,
  };

  trades.push(trade);
  broadcast();

  // Simulate live price ticks for this trade
  const interval = setInterval(() => {
    const t = trades.find(tr => tr._id === trade._id);
    if (!t || !t.open) {
      clearInterval(interval);
      return;
    }
    const delta = +(Math.random() * 4 - 2).toFixed(2);
    t.lastTradePrice = +(t.lastTradePrice + delta).toFixed(2);
    t.realizedPnL = +((t.lastTradePrice - t.price) * t.quantity).toFixed(2);
    broadcast();
  }, 3000);

  res.sendStatus(200);
});

// GET /squareoff?token=TSYM&qty=75
app.get('/squareoff', (req, res) => {
  const userId = resolveUser(req);
  const { token } = req.query;
  console.log(`[/squareoff] userId: ${userId}, token: ${token}`);
  const index = trades.findIndex(t => t.tsym === token || t.token === token);
  if (index !== -1) {
    const t = trades[index];
    t.open = false;
    t.realizedPnL = +((t.lastTradePrice - t.price) * t.quantity).toFixed(2);
    trades.splice(index, 1);
    closedTrades.push(t);
    if (closedTrades.length > 100) closedTrades = closedTrades.slice(-100);
    broadcast();
  }
  res.sendStatus(200);
});

// GET /niftystream — SSE for live NIFTY prices
app.get('/niftystream', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 10000\n\n');
  res.write(`data: ${JSON.stringify({ nifty: niftyQuote })}\n\n`);
  niftyClients.push(res);
  req.on('close', () => {
    niftyClients = niftyClients.filter(c => c !== res);
  });
});

app.listen(4000, () => {
  console.log('Mock server running on http://localhost:4000');
});
