// CE/PE of a trade. Fills booked from the brokers (kite etc.) often carry no `right`, so fall back to the contract symbol suffix
// (NIFTY26N1725150CE). Returns null when neither tells, so the UI shows no tag instead of a false PE.
export function optionRight(trade: { right?: unknown; tsym?: string }): 'CE' | 'PE' | null {
  const r = typeof trade.right === 'string' ? trade.right.toLowerCase() : '';
  if (r === 'call' || r === 'ce') return 'CE';
  if (r === 'put' || r === 'pe') return 'PE';
  const m = /(CE|PE)$/i.exec(trade.tsym ?? '');
  return m ? (m[1].toUpperCase() as 'CE' | 'PE') : null;
}
