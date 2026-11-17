import qrcodeTerminal from 'qrcode-terminal';
import type { BrowserContext, Page } from 'playwright';
import whatsappWeb from 'whatsapp-web.js';
import { defaultRunner } from './claudeParser.js';
import { loadConfig } from './config.js';
import { createDeduper } from './dedupe.js';
import { logError, logInfo } from './logger.js';
import { placeBracketBuy, readSpot } from './order/gopocket.js';
import { dismissNotice, isLoggedIn, openContext } from './order/session.js';
import { type Broker, handleMessage, serialize } from './pipeline.js';
import { isAllowedSender } from './whitelist.js';

const { Client, LocalAuth } = whatsappWeb;

const cfg = loadConfig();
const run = defaultRunner(cfg.claudeModel);
const deduper = createDeduper(cfg.dedupeWindowSeconds * 1000);

let context: BrowserContext | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
  if (!context || !page || page.isClosed()) {
    await context?.close().catch(() => undefined);
    context = await openContext(cfg);
    page = await context.newPage();
  }
  return page;
}

const broker: Broker = {
  async readSpot() {
    const p = await getPage();
    if (!(await isLoggedIn(p))) throw new Error('session expired: run "npm run login" and restart');
    await dismissNotice(p);
    return readSpot(p);
  },
  async buy(req) {
    return placeBracketBuy(await getPage(), req, cfg, new Date().toLocaleDateString('en-CA'));
  },
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp (Linked Devices):');
  qrcodeTerminal.generate(qr, { small: true });
});
client.on('ready', () => logInfo(`WhatsApp client ready (dryRun=${cfg.dryRun}, headless=${cfg.headless})`));
client.on('disconnected', (reason) => logError('WhatsApp client disconnected', { reason }));

client.on('message_create', async (msg) => {
  const ownId = client.info?.wid?._serialized;
  const isSelfChat = msg.fromMe && msg.to === ownId;
  if (msg.fromMe && !isSelfChat) return;

  try {
    const contact = await msg.getContact();
    const chat = await msg.getChat();
    const candidates = [msg.from, msg.author, contact.pushname, contact.name, contact.number, chat.name];

    // WhatsApp "lid" addressing hides the phone number; resolve it so the whitelist can match by digits.
    const lid = msg.author ?? msg.from;
    if (lid.endsWith('@lid')) {
      const [resolved] = await client.getContactLidAndPhone([lid]);
      if (resolved?.pn) candidates.push(resolved.pn);
    }

    if (!isSelfChat && !isAllowedSender(candidates, cfg.allowedSenders)) {
      logInfo('Ignoring message from non-whitelisted sender', { from: msg.from });
      return;
    }

    logInfo('Received message', { from: msg.from, body: msg.body });
    await serialize(() =>
      handleMessage(msg.id._serialized, msg.body, {
        cfg,
        run,
        broker,
        deduper,
        today: () => new Date().toLocaleDateString('en-CA'),
        log: (message, extra) => logInfo(message, extra),
      }),
    );
  } catch (error) {
    logError('Unhandled error while processing message', { error: error instanceof Error ? error.message : String(error) });
  }
});

client.initialize();
