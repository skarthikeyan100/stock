// JSON lines on stdout; `npm run dev` tees stdout into logs/<name>.log (gopocket.log / whatsapp.log).

function logEvent(level: 'info' | 'error', message: string, extra?: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...extra };
  console.log(JSON.stringify(entry));
}

export function logInfo(message: string, extra?: Record<string, unknown>): void {
  logEvent('info', message, extra);
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  logEvent('error', message, extra);
}
