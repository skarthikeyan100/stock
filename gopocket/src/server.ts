import { createServer, type Server } from 'node:http';

/**
 * Loopback listener the WhatsApp router posts to: {messageId, sender, text}.
 * Answers 202 at once (the order flow takes seconds) and runs the handler in the background.
 */
export function createMessageServer(
  onMessage: (messageId: string, text: string) => Promise<unknown>,
  onGtt?: (body: Record<string, unknown>) => Promise<unknown>,
): Server {
  return createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/message' && !(req.url === '/gtt' && onGtt))) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64_000) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body: { messageId?: unknown; text?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end('invalid json');
        return;
      }
      if (req.url === '/gtt') {
        res.writeHead(202).end();
        onGtt!(body as Record<string, unknown>).catch((e) => console.error('gtt handler failed', e));
        return;
      }
      if (typeof body.messageId !== 'string' || typeof body.text !== 'string') {
        res.writeHead(400).end('messageId and text are required');
        return;
      }
      res.writeHead(202).end();
      onMessage(body.messageId, body.text).catch((e) => console.error('message handler failed', e));
    });
  });
}
