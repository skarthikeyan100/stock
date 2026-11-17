import { isAllowedSender } from './whitelist.js';

export interface Route {
  name: string;
  senders: string[];
  url: string;
}

export interface ForwardPayload {
  messageId: string;
  sender: string;
  text: string;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Validates the routes from config.json. Brokers must listen on loopback: orders are placed from these messages. */
export function parseRoutes(raw: unknown): Route[] {
  if (!Array.isArray(raw)) throw new Error('routes must be an array');
  return raw.map((r, i) => {
    const o = r as Partial<Route>;
    if (!o.name) throw new Error(`routes[${i}].name is required`);
    if (!Array.isArray(o.senders) || o.senders.length === 0) throw new Error(`routes[${i}].senders must list at least one sender`);
    const host = new URL(String(o.url)).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error(`routes[${i}].url must be a loopback address`);
    return { name: o.name, senders: o.senders.map(String), url: String(o.url) };
  });
}

/** First route whose senders match any candidate (jid, name, pushname, phone). */
export function resolveRoute(candidates: Array<string | null | undefined>, routes: Route[]): Route | null {
  return routes.find((r) => isAllowedSender(candidates, r.senders)) ?? null;
}

/** POSTs the message to the broker. Never throws: a down broker is reported so the router keeps running. */
export async function forward(route: Route, payload: ForwardPayload, fetchFn: FetchFn = fetch as never): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchFn(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `${route.name} answered ${res.status}` };
  } catch (e) {
    return { ok: false, error: `${route.name} unreachable: ${(e as Error).message}` };
  }
}

/** A message I sent into my own "Message yourself" chat. WhatsApp may address that chat by a @lid; resolvedPhone is that lid's phone id. */
export function isSelfChat(m: { fromMe: boolean; to: string; ownId?: string; resolvedPhone?: string }): boolean {
  if (!m.fromMe || !m.ownId) return false;
  return m.to === m.ownId || m.resolvedPhone === m.ownId;
}
