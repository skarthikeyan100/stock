// Every trading-window rule (09:10 gates, 15:15 expiry square-off, 15:25 close, Wed-Tue drawdown weeks, the 09:15
// candle filter) reads server-LOCAL Date getters, and the markets run on IST. A host left on UTC (e.g. a fresh cloud
// box) would shift all of them by 5.5 hours, so every process entry point imports this FIRST to pin the zone.
// Node re-reads TZ when process.env.TZ is assigned, so this takes effect for all later Date use in the process.
process.env.TZ = 'Asia/Kolkata';
export {};
