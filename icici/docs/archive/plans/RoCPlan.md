# Plan: RateOfChangeStrategy — Absolute Points Datapoint-Window Trigger

## Context

The current trigger uses **percentage change** (`rocThresholdPercent`) over a **quote-count window** (`historyWindowSize`). The new requirement: trigger based on **absolute NIFTY point change** across the last **N received datapoints**.

Example: `numberOfDatapointsReceived=50`, `pointsThreshold=20` → if NIFTY moved +20 pts across the last 50 received quotes → CALL; −20 pts → PUT.

---

## Files Modified

| File | Change |
|------|--------|
| `icici/src/prism/AppConfig.ts` | Replaced `rocThresholdPercent`, `historyWindowSize`, `useWindowMomentum` with `pointsThreshold` and `numberOfDatapointsReceived` |
| `icici/config.yml` | Replaced old keys with `pointsThreshold: 20` and `numberOfDatapointsReceived: 50` |
| `icici/src/strategy/RateOfChangeStrategy.ts` | Replaced `calculateWindowMomentum` with `calculatePointsChange`; updated `processNiftyQuote` trigger logic |

No changes needed to `model/model.ts` or `monitor.ts` — `getRecentNiftyQuotes(count)` already exists and is sufficient.

---

## 1. `AppConfig.ts`

`RateOfChangeStrategy` class now has (replacing old percentage/window fields):
```typescript
pointsThreshold = 20            // Absolute NIFTY point change to trigger
numberOfDatapointsReceived = 5  // Window size: number of received quotes to look back
```

---

## 2. `config.yml`

Under `rateOfChangeStrategy:`:
```yaml
  pointsThreshold: 20              # Trigger if |NIFTY change| >= this many points across the window
  numberOfDatapointsReceived: 50   # Window size: number of received quotes to look back
```

---

## 3. `RateOfChangeStrategy.ts`

`calculatePointsChange(numberOfDatapoints)` replaces `calculateWindowMomentum`:
```typescript
private calculatePointsChange(numberOfDatapoints: number): number {
    const quotes = Monitor.getInstance().getRecentNiftyQuotes(numberOfDatapoints);
    if (quotes.length < 2) return 0;
    return quotes[0].ltp - quotes[quotes.length - 1].ltp;  // latest - oldest
}
```

`processNiftyQuote` trigger block:
```typescript
const pointsChange = this.calculatePointsChange(config.numberOfDatapointsReceived);

if (config.logEnabled) {
    console.log(`[RoC] NIFTY=${quote.ltp} PointsChange=${round(pointsChange)} Threshold=±${config.pointsThreshold} (window=${config.numberOfDatapointsReceived} datapoints)`);
}

if (pointsChange >= config.pointsThreshold) direction = CALL;
else if (pointsChange <= -config.pointsThreshold) direction = PUT;
```

---

## Verification

1. Restart: `npm run server` → `curl localhost:3000/connect`
2. Watch logs: `[RoC] NIFTY=26xxx PointsChange=X Threshold=±20 (window=50 datapoints)`
3. When `|PointsChange| >= 20`, expect `[RoC] TRIGGERED: call/put at NIFTY=...`
4. Confirm trade closes (win/loss) and `GET /stats` shows `RateOfChangeStrategy` trade count increasing
