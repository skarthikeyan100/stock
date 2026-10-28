// Strike choice by days-to-expiry: the further the expiry, the further OTM the entry strike
// (one strike step per trading day left; 0 on expiry day = pure ATM).

const DAY_MS = 86400000;

// Weekdays (Mon-Fri) in (today, expiry], 0 when the expiry is today or already past. `expiryEpochMs` is the master's
// midnight-UTC expiry date; both sides are reduced to a calendar day, so the host timezone does not matter for the expiry.
// NSE holidays between today and expiry are not subtracted (no holiday list exists); a holiday-shifted expiry is handled
// because the real expiry comes from the contract master.
export function tradingDaysToExpiry(expiryEpochMs: number, nowMs: number = Date.now()): number {
    const now = new Date(nowMs);
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const expiryDay = Math.floor(expiryEpochMs / DAY_MS) * DAY_MS;
    let days = 0;
    for (let d = today + DAY_MS; d <= expiryDay; d += DAY_MS) {
        const wd = new Date(d).getUTCDay();
        if (wd !== 0 && wd !== 6) days++;
    }
    return days;
}

// ATM strike shifted OTM by `daysLeft` steps: CE goes up, PE goes down.
export function shiftedStrike(atmStrike: number, optionType: string, step: number, daysLeft: number): number {
    return optionType === 'CE' ? atmStrike + daysLeft * step : atmStrike - daysLeft * step;
}
