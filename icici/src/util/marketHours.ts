const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 25;

export function isPastMarketClose(): boolean {
  const now = new Date();
  return (
    now.getHours() > MARKET_CLOSE_HOUR ||
    (now.getHours() === MARKET_CLOSE_HOUR && now.getMinutes() >= MARKET_CLOSE_MINUTE)
  );
}
