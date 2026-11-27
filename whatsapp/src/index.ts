import { readFileSync } from 'node:fs';
import qrcodeTerminal from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { logError, logInfo } from './logger.js';
import { forward, isSelfChat as isSelfChatMessage, parseRoutes, resolveRoute } from './router.js';

const { Client, LocalAuth } = whatsappWeb;

const raw = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) as { discovery?: boolean; routes: unknown };
const routes = parseRoutes(raw.routes);
const discovery = raw.discovery === true;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp (Linked Devices):');
  qrcodeTerminal.generate(qr, { small: true });
});
client.on('ready', () => logInfo(`WhatsApp client ready (discovery=${discovery}, routes=${routes.map((r) => r.name).join(',')})`));
client.on('disconnected', (reason) => logError('WhatsApp client disconnected', { reason }));

client.on('message_create', async (msg) => {
  const ownId = client.info?.wid?._serialized;
  let toPhone: string | undefined;
  if (msg.fromMe && msg.to !== ownId && msg.to.endsWith('@lid')) {
    toPhone = (await client.getContactLidAndPhone([msg.to]).catch(() => []))[0]?.pn;
  }
  const isSelfChat = isSelfChatMessage({ fromMe: msg.fromMe, to: msg.to, ownId, resolvedPhone: toPhone });
  if (discovery) logInfo('DISCOVERY raw', { from: msg.from, to: msg.to, fromMe: msg.fromMe, ownId, isSelfChat, preview: msg.body.slice(0, 40) });
  if (msg.fromMe && !isSelfChat) return;

  try {
    const contact = await msg.getContact();
    const chat = await msg.getChat();
    const candidates: Array<string | null | undefined> = [msg.from, msg.author, contact.pushname, contact.name, contact.number, chat.name];
    // WhatsApp "lid" addressing hides the phone number; resolve it so routes can match by digits.
    const lid = msg.author ?? msg.from;
    let phone: string | undefined;
    if (lid.endsWith('@lid')) {
      const [resolved] = await client.getContactLidAndPhone([lid]);
      phone = resolved?.pn;
      if (phone) candidates.push(phone);
    }
    if (isSelfChat) candidates.push(client.info?.wid?.user);

    if (discovery) {
      // Discovery: say who sent it, forward nothing.
      logInfo('DISCOVERY sender', { from: msg.from, author: msg.author, phone: phone ?? contact.number, pushname: contact.pushname, name: contact.name, chat: chat.name, isBroadcast: msg.broadcast, preview: msg.body.slice(0, 60) });
      return;
    }

    const route = resolveRoute(candidates, routes);
    if (!route) {
      logInfo('Ignoring message from unrouted sender', { from: msg.from });
      return;
    }
    const result = await forward(route, { messageId: msg.id._serialized, sender: msg.from, text: msg.body });
    if (result.ok) logInfo(`Forwarded to ${route.name}`, { id: msg.id._serialized });
    else logError(`Forward to ${route.name} failed`, { error: result.error, id: msg.id._serialized });
  } catch (error) {
    logError('Unhandled error while processing message', { error: error instanceof Error ? error.message : String(error) });
  }
});

client.initialize();
