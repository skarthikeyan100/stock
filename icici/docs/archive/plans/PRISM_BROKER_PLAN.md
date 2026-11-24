# Make `prism` usable as a broker in `brokers: [...]` (SimpleContinuousStrategy and every Bare-family strategy)

Hand-off plan for a smaller model. Follow it literally. Do NOT change anything not listed. Re-read each anchor in the file before editing (line numbers drift).

## Why (answer to "will prism work with no changes?" = NO)
Strategy order calls already route to `PrismExecutor` by `broker: 'prism'`, so placing sells/cancels/contract pick work. Four gaps make it idle or unsafe:
1. `brokerSessions` has no `prism` -> `strategiesProcess.startupReconcile` returns silently (`!sessions['prism']`) -> after every restart NO strategy gets ticks until `POST /reconcile`.
2. Prism positions are never reconciled (`reconcileAllBrokersOnce` handles kite/ant/breeze only) -> after a restart `SimpleContinuousStrategy.reconcile()` sees no prism trades and marks open prism legs "no longer held by the broker - closed" (live positions unmanaged). `/reconcile` and startup also read `brokers['prism']` (undefined = "failed").
3. `PrismExecutor.marketBuy` calls `prismExecutor.buyContract`, which returns Prism's raw response (fields `qty`, `price`, not `quantity`) and books COMPLETE without verifying the fill. `marketBuyBareChunked` (chunkedOrder.ts:129) then does `trade.quantity * trade.price` -> NaN, and an unfilled buy would be treated as held.
4. `NorenRestApi.get_positions` (src/prism/RestAPI.ts:493) returns Shoonya's `{stat:'Not_Ok', emsg:'no data'}` object for a flat account; `Prism.getPositions({strict:true})` (src/prism.ts:945) then THROWS, so a flat prism account looks like a broken session (and would make the new session probe and `liveNetQuantityOnPrism` fail). `get_orderbook` (RestAPI.ts:455) already has the correct "no data -> []" handling to copy.

## Rules for the implementer
- Do not edit `config.yml`. Do not run test scripts or `code-review` unless the user asks. Do not restart processes: editing `src/` hot-restarts the `trading` process, which is suppressed 09:00-15:35 on weekdays unless `HOT_RESTART=true`; do the edits and `tsc`, then commit/push (outside market hours the orchestrator rebuilds itself).
- After all edits: `npx tsc --noEmit -p .` must pass. Then commit only the files listed below (the tree has unrelated uncommitted changes - use `git add <file>` per file, never `git add -A`) and push. Commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Then update `strategies.md` (short note under the broker/Architecture text: "prism is a valid `brokers:` entry; needs a Shoonya login (scripts/login.sh prism) before startup reconcile") and `ToDo.md` only if an item there is resolved.

## Task 1 - `src/prism/RestAPI.ts`: empty positions book must read as `[]`
Edit `get_positions` (line ~493). Make it `async`, await the reply and copy `get_orderbook`'s handling:
```ts
get_positions = async () => {
  if (MOCK_BROKER) { return []; }
  let values = {};
  values["uid"] = this.userId;
  values["actid"] = this.userId;
  const reply: any = await this.post_request("positions", values);
  // Shoonya answers an empty book with {stat:'Not_Ok', emsg:'no data'}, not []. Any OTHER Not_Ok (expired session) must surface.
  if (Array.isArray(reply)) return reply;
  if (reply && reply.stat === 'Not_Ok' && !/no data/i.test(String(reply.emsg ?? ''))) {
    throw new Error(`Prism positions not Ok: ${reply.emsg ?? JSON.stringify(reply)}`);
  }
  return [];
};
```
Check other callers of `get_positions` (`grep -rn "get_positions" src`) still work with an array return (Prism.getPositions at src/prism.ts:945 already does `Array.isArray(raw) ? raw : []`). Leave the `strict` branch in `Prism.getPositions` as is (now only a non-array = unexpected shape).

## Task 2 - `src/prism.ts`: session probe
Directly after `getPositions` (ends ~line 950) add a sibling arrow method on the `Prism` class:
```ts
    // Per-broker session probe (brokerSessions / reconcile): a Shoonya token is loaded AND a strict positions read works.
    hasValidSession = async (): Promise<boolean> => {
        if (!NorenRestApi.userToken) return false;
        try { await this.getPositions({ strict: true }); return true; } catch { return false; }
    }
```
(`NorenRestApi` is the instance already used in `getPositions`; `userToken` is its public field.) In MOCK_BROKER mode `get_positions` returns `[]`, so this is true there.

## Task 3 - `src/processes/orderProcess.ts`: sessions + reconcile result include prism
a. `case 'brokerSessions'` (~line 1136): add `prism`:
```ts
const [kite, ant, breeze, prism] = await Promise.all([
    valid(() => Kite.getInstance().hasValidSession()),
    valid(() => ANT.getInstance().hasValidSession()),
    valid(() => Breeze.getInstance().hasValidSession()),
    valid(() => Prism.getInstance().hasValidSession()),
]);
return { kind: 'response', id: req.id, ok: true, result: { kite, ant, breeze, prism } };
```
(`Prism` import: check the file's existing import of the Prism class; add `import Prism from '../prism';` if absent.)
b. ~line 1315: `type ReconcilableBroker = 'kite' | 'ant' | 'breeze' | 'prism';` and `lastReconcileResult = { kite: false, ant: false, breeze: false, prism: false }`.
c. `reconcileAllBrokersOnce` (~line 1317): do NOT force a Prism login for users who never use prism. Add a helper above it:
```ts
// A Shoonya login is only required when an enabled strategy trades on prism; otherwise prism counts as reconciled (nothing to restore).
function prismInUse(): boolean {
    return (configService.getConfig().strategies ?? []).some((e: any) => e?.enabled === true && configuredBrokersOf(e).includes('prism'));
}
```
(`configService` is already imported in this file (used by `configService.onChange`); import `configuredBrokersOf` from `'../util/brokerName'` if not present.) Extend the Promise.all with a 4th entry:
```ts
prismInUse() ? bookkeeping.reconcilePrismPositions().catch((e) => { Log.log('[order] reconcilePrismPositions failed:', e); return false; }) : Promise.resolve(true),
```
and set `lastReconcileResult.prism = prism;`. Update the doc comment above `startReconcile` ("all three" -> "all").

## Task 4 - `src/processes/order/bookkeeping.ts`: `reconcilePrismPositions`
Add a method right after `reconcileBreezePositions` (ends ~line 1440), same shape as `reconcileAntPositions` (line 1388). Prism position row fields (see `prismExecutor.getPositionsOnPrism`): `tsym`, `netqty`, `netavgprc`, `token`, `lp` (ltp), `exch`.
```ts
    // Mirrors reconcileAntPositions: without it a restart leaves bookkeeping.trades empty for an open prism leg and the strategy's
    // own reconcile() marks that leg closed ("no longer held by the broker").
    async reconcilePrismPositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            if (!(await withTimeout(Prism.getInstance().hasValidSession(), 15000, 'Prism hasValidSession'))) return false;
            const list = await withTimeout(Prism.getInstance().getPositions({ strict: true }), 15000, 'Prism getPositions');
            const open = list.filter((p: any) => Number(p.netqty ?? 0) !== 0 && OrderBookkeeping.isOptionContract(p.tsym));
            for (const p of open) {
                restored.push(...(await this.restoreOpenTradesForTsym(p.tsym, Number(p.netqty), p.token != null ? String(p.token) : undefined, 'prism', { avg: p.netavgprc, ltp: p.lp })));
            }
        } catch (e: any) {
            Log.log('[order] reconcilePrismPositions: Prism getPositions failed (continuing without restore):', e?.message ?? e);
            return false;
        }
        this.mergeRestored(restored);
        return true;
    }
```
Check `Prism` and `withTimeout` are already imported/defined in bookkeeping.ts (withTimeout is used by `reconcileBreezePositions`); add `import Prism from '../../prism';` only if missing (path is relative to `src/processes/order/`). `restoreOpenTradesForTsym` already accepts `'prism'`.

## Task 5 - `src/processes/order/brokerExecutors.ts`: fill-verified bare buy for prism
Line ~117, replace
`marketBuy: (userId, tradingSymbol, _instrumentToken, quantity) => prismExecutor.buyContract(userId, tradingSymbol, quantity),`
with a call to the already existing verified path (it returns a real `Trade`, books it via `bookkeeping.recordFill`, polls the order status with cancel+recheck, books a partial fill before rethrowing):
```ts
    marketBuy: (userId, tradingSymbol, instrumentToken, quantity, exchange) =>
        prismExecutor.buyOnPrism({ userId, tradingSymbol, brokerToken: instrumentToken, quantity, exchange }),
```
(`buyOnPrism` with no `stopLossPoints` takes the "verified limit order" branch: limit at the option LTP, `waitForPrismBuyFill`.) Do not touch `PrismExecutor.buy`, `squareOff*`, or other prism members. Confirm nothing else calls `prismExecutor.buyContract` expecting its old return (`grep -rn "buyContract(" src/processes`); leave that function alone.

## Task 6 - startup reconcile gate (no code change expected, verify only)
`strategiesProcess.startupReconcile` (line 194) uses `sessions[b]` / `brokers[b]` for every broker in `brokersNeededByEnabledStrategies()`. With Tasks 3-4 `sessions.prism` and `brokers.prism` exist, so no edit. Confirm by reading lines 194-225 after the edits. `POST /reconcile` (src/routes/admin.ts:60) 409s on any `false` broker: with `prismInUse()` false it returns `prism: true`, so existing flows are unchanged when no strategy uses prism.

## Task 7 - docs
- `strategies.md`: one short paragraph - `prism` is accepted in `brokers:`; requires Shoonya login (`scripts/login.sh prism`) before the post-login restart; instance ids use the `-Prism` suffix (`src/util/strategyInstances.ts`).
- `CLAUDE.md` "Strategy Brokers and Amounts" section: add "prism is also accepted; one strategy listing prism keeps every strategy idle until the Shoonya login is valid at startup" (same sentence as the ant/breeze one, extended).

## Known limits to state in the final report (do not try to fix)
- `PrismContractMaster` has no lot size; sizing falls back to `bookkeeping.getInstrumentLotSize` (65 for NIFTY - fine for NIFTY, wrong for SENSEX). SimpleContinuousStrategy passes explicit `initialQuantity`, so unaffected.
- Prism cannot be exercised live until a Shoonya login exists; nothing was tested against the live broker.

## Verification (implementer, no live orders)
1. `npx tsc --noEmit -p .` passes.
2. `grep -rn "get_positions" src` - every caller handles an array.
3. Read back `orderProcess.ts` `brokerSessions` case and `reconcileAllBrokersOnce`; confirm `lastReconcileResult` has 4 keys and `Record<ReconcilableBroker, boolean>` compiles.
4. (Only when the user asks) existing tests: `src/test/prismOrderFailures.test.ts`, `brokerParityMatrix.test.ts`, `bulkPcrStrategyReconcileAnt.test.ts` (pattern for a new `reconcilePrismPositions` test: stub `Prism.getInstance().getPositions` and `hasValidSession`, assert `bookkeeping.trades` gets the restored prism trade).
5. Live checklist for the user (not the implementer): off-hours `scripts/login.sh prism`, set `brokers: [prism]` on a SimpleContinuousStrategy block with a small `initialQuantity`, restart; expect "Startup reconcile complete"; `POST /reconcile` returns `{"brokers":{"kite":..,"ant":..,"breeze":..,"prism":true}}`; one live lot in market hours: buy is fill-verified, resting sell appears, and a restart with the leg open keeps it (reconcile does not mark it closed).

## Other enabled strategies: can `prism` be added there too? (checked read-only)
Enabled in `config.yml` today: `TopStockOptionsOpeningGapStrategy` (kite), `NiftyChangeStrategy` (ant), `MomentumAtFixedTimeStrategy` (kite), `SimpleContinuousStrategy` (kite, breeze).

| Strategy | Prism in `brokers:` works after Tasks 1-5? | Why |
|---|---|---|
| `SimpleContinuousStrategy` | Yes | Bare-family IPC calls routed by `broker: 'prism'` (see top). |
| `NiftyChangeStrategy`, `MomentumAtFixedTimeStrategy` (share `LimitEntryStrategy`) | Yes, with no strategy change | `brokers()` = `configuredBrokersOf` (accepts prism); entry = `resolveOptionContract` -> `PrismExecutor.resolveContract` + `placeLimitBuyBare` -> `placeLimitBuyBareOnPrism` (tracked in `TRACKERS.prism`, fills booked by `pollPendingPrismLimitOrders`); target sell = `brokerPlaceLimitSellBare` -> `squareOffLimit`; close = `cancelRestingLimitSells` + `chunkedSquareOff`. `attachProtection` throws for prism (`attachProtection.ts` line ~25: only kite/ant) but `LimitEntryStrategy` catches it (line ~303) and falls back to a resting target sell + the tick-driven stop on ANT ticks, so NiftyChange's stop still works. Needs the same Tasks 3-4 (session + position reconcile) or the strategy goes idle at startup / loses the leg on restart. |
| `TopStockOptionsOpeningGapStrategy` | **No - needs strategy code** | Hard-coded `type BrokerName = 'kite' \| 'breeze' \| 'ant'` (line 63); `configuredBrokers()` (lines 125-135) DROPS any other name with an ALERT ("unknown broker"), and contract resolution + entry/exit have explicit `ant`/`kite`/`breeze` branches (lines ~357-410, 523-619). Adding prism = a new `prism` branch for contract resolution (`PrismContractMaster.findNearestExpiryOption`, pinned to the ANT reference strike/expiry like kite), the leg's broker union, and the entry/exit path through `butterflyBuyLeg` + `brokerPlaceLimitSellBare` (both already accept `prism`). This strategy holds positions overnight; do not do it without a separate decision. Recommendation: leave prism out of this one. |

Optional (not required for the above, do only if asked): let `attachProtection`/`cancelProtection` accept `prism` (`exitMonitor` already has `Broker = ... 'prism'`) so NiftyChange gets exitMonitor protection instead of the tick-driven fallback. Not recommended now: the fallback already works and this changes live exit behaviour.

## Deliverable of THIS session (confirmed with the user)
Only documents are written; no source, config, test or process changes. After plan mode is turned off, copy this file verbatim to `/home/karthikeyan/work/icici/PRISM_BROKER_PLAN.md` (repo root, user's choice) and stop. Do not commit or push it unless the user asks (the tree has many unrelated uncommitted changes).
