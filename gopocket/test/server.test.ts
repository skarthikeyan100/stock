import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageServer } from '../src/server.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(onMessage: (id: string, text: string) => Promise<unknown>) {
  const s = createMessageServer(onMessage);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  close = () => new Promise((r) => s.close(() => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/message`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('message server', () => {
  it('passes messageId and text to the handler and answers 202', async () => {
    const seen: string[][] = [];
    const url = await start(async (id, text) => void seen.push([id, text]));
    const res = await post(url, { messageId: 'm1', sender: 's', text: 'BUY X' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([['m1', 'BUY X']]);
  });
  it('rejects malformed json with 400 and never calls the handler', async () => {
    let called = false;
    const url = await start(async () => void (called = true));
    expect((await post(url, 'not json')).status).toBe(400);
    expect((await post(url, { messageId: 'm' })).status).toBe(400);
    expect(called).toBe(false);
  });
  it('answers 404 on other paths', async () => {
    const url = await start(async () => undefined);
    expect((await fetch(url.replace('/message', '/other'), { method: 'POST', body: '{}' })).status).toBe(404);
  });
  it('a handler that throws does not kill the server', async () => {
    const url = await start(async () => {
      throw new Error('boom');
    });
    expect((await post(url, { messageId: 'm', sender: 's', text: 't' })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect((await post(url, { messageId: 'm2', sender: 's', text: 't' })).status).toBe(202);
  });
});
