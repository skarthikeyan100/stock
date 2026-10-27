# Refactor plan (saved as `refactor.md` in the repo root once approved)

## Context
Plan only. No code changes while the processes are running. The four asks:
1. One broker contract that every consumer uses.
2. A list of dead code to remove.
3. Simpler config with overrides only at strategy level.
4. Duplicate code to consolidate.

Findings come from three read-only exploration passes. Items marked **(verify)** need a runtime or grep check before deletion.

**Constraints from CLAUDE.md**
- No tests and no `code-review` until 2026-10-28. Use `tsc --noEmit` and reading the code until then.
- Any change to order or execution code gets a `code-review` pass after the freeze.
- Commit and push after each phase.
- Do not restart live processes mid-session. Roll out outside market hours.

---

## 0. Scope and naming decisions (confirmed by the user)

**Scope.** The legacy ICICI/Selenium/Shoonya-era path is retired. Exactly four brokers are supported for now: **ant, kite, breeze, prism**. More can be added later by implementing the `Broker` interface (section 1). Nothing else is kept "just in case".

**Canonical names.** Use only these four names everywhere in code, config, Mongo, API, UI and docs:

| Use | Never use |
|---|---|
| `ant` | AliceBlue, Alice Blue |
| `kite` | Zerodha |
| `breeze` | ICICI, ICICI Direct (as a broker name) |
| `prism` | Shoonya |

The mapping goes into `Architecture.md` (new "Broker naming" section) as the first step of execution. Nothing is edited during this planning pass.

**Rename Zerodha to Kite everywhere.** Pass 1 is a grep-driven inventory. Expected scope:
- **Files and directories:** `src/zerodha/` to `src/kite/`, `Zerodha.ts` to `Kite.ts`, `ZerodhaContractMaster.ts`, `ZerodhaBroker.ts` (deleted anyway), `processes/order/zerodhaExecutor.ts` to `kiteExecutor.ts`, `data/zerodha/` to `data/kite/` (and `BFO_instruments.csv`/`NFO_instruments.csv` paths in `scripts/download-all-masters.sh`).
- **Symbols and strings:** the `'zerodha'` literal in unions (`BrokerExecutor.brokerName`, `BROKER_TO_FEED_SOURCE`, `getUserBroker`, `brokers: [...]` in `config.yml`), `squareOffOnZerodha`, `placeLimitBuyOption` callers, log prefixes, IPC action names, and UI labels.
- **Persisted data (the risky part).** `'zerodha'` is stored as a value in Mongo (user `broker` field, trade records, pending-order collections), and in `.bulkpcr_armed_slots.*.json` and similar state files. Renaming the code alone would orphan these.
  - Read-compat shim: normalise `'zerodha'` to `'kite'` on read (one `normalizeBrokerName()` helper, also used for the other aliases in the table above).
  - One-off migration script for Mongo values and state files, run when no positions are open and the markets are closed.
  - Do not rename Mongo collection names in the same release as the code rename. Do that in a later, separate step.
- **External names that must NOT change:** Zerodha's own API hostnames, the `kiteconnect` npm package and its field names (`tradingsymbol`, `instrument_token`), and env-var names only if they are also used by Kite's own tooling. Check each before the blanket rename.
- **Frontend:** labels, broker dropdowns and API payload values. This needs `cd frontend && npm run build`, because the bundle is not hot-reloaded.
- Same pass for Shoonya (to prism), ICICI (to breeze) and AliceBlue (to ant) wherever they appear in identifiers, comments or docs. In the dead legacy code this is moot, because the code is deleted.

---

## 1. Unified broker contract

### Current state
- **`src/broker/Broker.ts`** (+ `AntBroker`, `ShoonyaBroker`, `ZerodhaBroker`) is a Prism-shaped scaffold. Nothing imports it, so it is dead.
- **`src/processes/order/BrokerExecutor.ts:152-204`** is the real runtime abstraction, but only for the order process. It has `buy`, `squareOff`, `squareOffLimit?`, `cancelOrder`, `getFillPrice`, `getPositions`, `getTrades` and `hasValidSession`.
- **`src/strategy/LegBrokerOps.ts`** is a second, strategy-side abstraction (`pickContract`, `buy`, `sell`, `cancel`, `buyLimit`). `antLegOps.ts` is an unused ANT variant.
- Consumers still branch on broker name in about 20 places:
  - `orderProcess.ts`: lines 189-199, 395-446, 528-659, 827-924 and 1109-1144.
  - `server.ts`: `getBrokerTrades`/`getBrokerPositions` (lines 939-956) and the login routes.
  - `bookkeeping.ts`, `exitMonitor.ts:188` and `ButterflyStrategy.ts:501`.
  - `BulkPcrStrategy.ts:1230` and `TopStockOptionsOpeningGapStrategy.ts:354-521`.
  - `monitor.ts` calls `Prism.getInstance()` directly.

### Target design
One interface, `Broker`, in `src/broker/Broker.ts`. It replaces the scaffold, merges `BrokerExecutor` and `LegBrokerOps`, and is looked up through `getBroker(name)`, the successor of `getBrokerExecutor`.

```ts
interface Broker {
  readonly name: 'ant' | 'kite' | 'breeze' | 'prism';   // exactly these four; extend the union to add a broker
  readonly capabilities: { nativeProtection: 'bracket' | 'cover' | 'gtt' | 'none'; pushFills: boolean; chunkedLimit: boolean };

  // session / auth
  hasValidSession(): Promise<boolean>;
  auth: { loginUrl?(): string; exchange(params): Promise<void>; logout(): Promise<void> };

  // contract resolution (wraps the per-broker ContractMaster)
  resolveContract(q: { index; strike|atm; right; expiry }): Promise<ContractRef>;

  // orders. Protection (target/SL) is part of the request, never a separate caller concern.
  buy(req: BuyRequest): Promise<OrderResult>;                 // targetPoints / stopLossPoints optional
  sell(req: SellRequest): Promise<OrderResult>;               // squareOff; the impl picks bracket-exit vs opposite order
  placeLimit(req): Promise<{ orderId }>;
  cancel(orderId): Promise<void>;                             // throws OrderAlreadyFilledError(filledQty)
  getOrderStatus(orderId): Promise<NormalizedOrder>;
  getFillPrice(orderId): Promise<number | null>;

  // account state, normalised shapes
  getPositions(): Promise<BrokerPosition[]>;
  getTrades(): Promise<NormalizedTrade[]>;
  getNetQuantity(tsym): Promise<number>;                      // replaces the 4-way if-chain in Butterfly

  // fills
  onFill(cb): Unsubscribe;                                    // ANT/Breeze: push stream. Zerodha/Prism: poller. Same event.
}
```

**How implementations differ behind it (the consumer never sees this):**

| Broker | Entry protection | Exit |
|---|---|---|
| ANT | native bracket (target+SL) or cover (SL only) | exit by order number |
| Prism | cover order (product `H`) | opposite order |
| Kite | GTT after the fill, or `exitMonitor` watch when `useGTT=false` | opposite order |
| Breeze | none, so the shared poller watches | opposite order |

- **Polling fallback.** When `capabilities.nativeProtection === 'none'`, the base class (`BaseBroker`) registers the trade with `exitMonitor` automatically, so strategies never branch.
- **Where the SL/target semantics live.** ANT's "no target-only order" quirk, the Zerodha GTT and the Prism cover order stay inside each implementation. `BuyRequest.targetPoints` and `stopLossPoints` stay the only common surface.
- **Normalised types.** Add `NormalizedOrder` and `NormalizedTrade`, extending the existing `BrokerPosition`, so the raw per-broker field names (`tradingsymbol`, `netQty` and so on) stop leaking.
- **Preserve:** `cancelOrderWithFillRecheck` and `OrderAlreadyFilledError` with a partial `filledQuantity`. Every implementation keeps the cancel-then-recheck race handling.
- **Feed routing.** `BROKER_TO_FEED_SOURCE` is already a clean abstraction and stays. Zerodha still proxies market data through ANT.
- **Prism parity.** `bookkeeping.getUserBroker()` returns only zerodha/ant/breeze, so Prism is reachable only through `brokerOverride`. Make Prism a first-class value.

### Migration steps (each step ends with `tsc --noEmit` and its own commit)
1. Define `Broker`, the normalised types and `BaseBroker` (shared cancel-recheck, fill-poll and exit-monitor registration). Make `BrokerExecutor` extend it, so nothing breaks yet.
2. Re-home the four executors (`antExecutor`, `breezeExecutor`, `zerodhaExecutor`, `prismExecutor`) as `Broker` implementations. Move the protection and exit logic that currently sits in `orderProcess.ts` into them.
3. Fold `LegBrokerOps` into `Broker`. `LegManager` takes a `Broker`. Revive `antLegOps` behaviour inside the ANT implementation instead of keeping a second file **(verify what BulkPcr hedging expects, since `buyLimit` is a logged no-op for ANT)**.
4. Replace the inline branches, one site at a time:
   - `orderProcess.ts` (about 20 branches),
   - `getBrokerTrades`/`getBrokerPositions` in `server.ts`,
   - `Butterfly` net quantity,
   - `BulkPcr` square-off,
   - `TopStock` contract resolution,
   - `exitMonitor` broker inference. Persist `broker` on the trade record instead of inferring it from `antOrderNo`/`prismCoverOrderNo`.
5. Route the login/OAuth routes in `server.ts` through `broker.auth`.
6. Move `monitor.ts`'s Prism calls onto `Broker` or delete them, depending on whether the legacy path survives (section 2).
7. Delete the old `src/broker/*` scaffold, `LegBrokerOps` and `antLegOps` once nothing references them.

**Risk:** highest of the four sections. It touches live order paths. Do it in separate sessions, after hours, one broker at a time. ANT first (the most protection logic), Breeze last.

---

## 2. Dead code to remove

### A. Unreachable TypeScript (certain)
Nothing under `src/processes/*`, `server.ts` or `orchestrator.ts` reaches these (about 10k lines).
- **Legacy ICICI/Selenium cluster:**
  - `src/index.ts`, `decision.ts`, `candle.ts`, `functions.ts`, `browser.ts`, `multiple_browsers.ts`, `onTrigger.ts`, `queue.ts`, `worker.ts`, `model.ts`, `server_old.ts`
  - `trade/*` (`icici.ts`, `option.ts`, `option-plus.ts`, `strategy/strategy.ts`)
  - `communication/*`
  - `scheduler/*`, including `stock-strike-price-original.ts` and `strike-price.ts`
  - `prism.ts` (1510 lines) **(verify no indirect import from `processes/*`)**
- `src/momentum/*` is **not** dead. `momentum:fetch` and `momentum:rank` use it.
- **Scaffold:** `src/broker/{AntBroker,ShoonyaBroker,ZerodhaBroker,Broker}.ts`. Replace, don't just delete (section 1).
- **Unused:** `src/strategy/antLegOps.ts` (see section 1 step 3).
- **Legacy strategies:** `BiDirectionStrategy`, `DiffStrategy`, `PivotStrategy`, `HighLotStrategy`, `Minutes5Decision` and `TestStrategy` are registered in `StrategyFactory.ts` but have no `config.yml` block. Delete them with their tests (`highLotStrategy.test.ts`, `biDirectionStrategy.test.ts`). `ORBPrevious.ts` has a commented-out body and is referenced only by dead files.
  - `strategy.ts` base-class legacy: `settings.cooldownSeconds` and `settings.trailingDistance` are read only by the legacy strategies (Gap, Sentiment, RuleBased, RoC). Re-check those four before deleting, because some are armable.
- **Docs:** `strategies.md` is stale. `ButterflyStrategy` and `TopStockOptionsOpeningGapStrategy` are armable (`config.yml` lines 224-243). Update it.

### B. Unused symbols
- Exports with no non-test importer:
  - `isNiftyExpiryDay` (`util/marketHours.ts:23`)
  - `formatCanonicalSymbol`
  - `breezeExchangeFor` and `SENSEX_BREEZE_SHORT_NAME`
  - `OrderMessage`
  - `seededEMA`
  - `NFO_TICK_SIZE` (used only inside its file)
  - `antAxiosInstance`, `validateNumericRanges` and `validateTargetVsStopLoss` (test-only)
- Unused locals in live code: `monitor.ts:274 trades`, `payout.ts:53 grossProfit`, `model/model.ts:2 EventEmitter`, `momentum/fetchDaily.ts:1`.
- Everything else from `tsc --noUnusedLocals` falls in the dead files above. Full output: `/tmp/claude-1000/-home-karthikeyan-work-icici/1ad3b63f-1b06-4ac7-b4c8-a6932c997480/scratchpad/tsc.txt`. After the deletions, turn on `noUnusedLocals`/`noUnusedParameters` in `tsconfig` so it stays clean.

### C. Repo hygiene
- **Tracked but should not be:**
  - Lock files: `.~lock.*` at the root and under `analysis/output/**`.
  - Logs and dumps: `debug.log`, `debug.txt`, `orchestrator.log`, `server.log`, `security.log`, `gapscreener-eod.log`, `server_logs*.txt`.
  - Unrelated files: `musicbook.pdf`, `cause_*.pdf`, `file.jpg`, `out.png`, `get-pip.py`, `eng.traineddata`, `requestOtp*`, `temp (copy).json`, `tsconfig.old`.
  - Scratch scripts: `test.py`, `icici.js`, `icici.py`, `index.js`, `dedup.js`, `breeze.py`.
  - Root CSVs: `ohlc_*min.csv`, `result.csv`.
  - Runtime state: `.topStockOptionsOpeningGap_firedToday.*.json` and `.bulkpcr_armed_slots.*.json`.
- **Credentials tracked in git: `userToken.txt`, `cert.pem`, `key.pem`.** Untrack and gitignore them. Because they are already in history, they should be rotated or regenerated. Surface this to the user first. Do not rewrite history unasked.
- **Backups:** about 24 files named `*.bak-*` under `data/` and at the root, created by `scripts/download-all-masters.sh`. Add `*.bak-*` to `.gitignore`. Make the script prune its own backups (keep the last one).
- **Duplicate data:** root `NFO_symbols.txt` and `BFO_symbols.txt` (they duplicate `data/prism/`), `src/stocks.csv` vs root `stocks.csv`, `src/test.py`, `src/strategy/server_mock_logs.txt` and `data/nifty_price_calculated_copy.ods`.
  - `public/symbols.txt` and `frontend/public/symbols.txt` are modified in the working tree. Check what generates them (`frontend/update-symbols.sh` vs the deleted `scripts/update-symbols.sh`) before touching them.
- **`.bulkpcr_armed_slots.json`** (un-suffixed) predates per-instance files and nothing reads it. Move the per-instance files to a `state/` directory.
- `grep` each filename against `src/`, `scripts/` and `package.json` **(verify)** before removal.

### D. package.json
- Candidates for removal. All have no import in `src` or `scripts` **(verify each, especially `dotenv`, which is used via `dotenv/config`)**:
  - Runtime: `esm`, `express-queue`, `express-ws`, `localtunnel`, `moment-timezone`, `multer-gridfs-storage`, `pdf-parse`, `pdf-to-img`, `pdf2json`, `properties-reader`.
  - `properties-reader` stays until `src/prism/config.ts` is removed (it reads `config/config.properties`).
  - Types: `@types/crypto-js`, `@types/express`, `@types/json-socket`, `@types/json2csv`, `@types/multer`, `@types/objects-to-csv`, `@types/regression`, `@types/request`, `@types/socket.io`.
- Move `@types/*` and `tsc-watch` to `devDependencies`.
- Dead scripts: `start`, `start1`, `adhoc`, `logs`, `logs:errors`. Check `migrate-data` and `migrate:actualDay`.
- `config/config.properties` and `src/prism/config.ts` are legacy Prism config. They go with `prism.ts` if that file is deleted.
- Frontend: no dead files found.

### Order
Hygiene first (no code risk), then dependencies, then the unreachable cluster (check `tsc --noEmit` before and after), then unused symbols.

---

## 3. Config simplification

### Current state
- `config.yml` has 18 flat strategy blocks. Types are `[key: string]: any`, so keys are untyped.
- The same concept goes by different names:
  - **Target:** `targetPrice`, `targetPoints`, `target`, `targetDistance`.
  - **Stop loss:** `stopLossPrice`, `stopLossPoints`, `stopLoss`, `slDistance`.
  - **Quantity:** `quantity`, `orderQuantity`, `initialQuantity`, `lots`.
  - **Broker:** `broker` vs `brokers[]`. The "brokers or `[broker ?? 'zerodha']`" logic is re-implemented in `BulkPcrStrategy.ts:349`, `ButterflyStrategy.ts:105`, `HourlyStrategy.ts:153` and `BulkPcrAutoStartStrategy.ts:208`.
- Defaults are scattered across the code and contradict each other and the YAML:
  - `cooldownSeconds ?? 60`.
  - `minPremium ?? 100` against 50 in YAML.
  - `quantity ?? 65/75/13975/0`.
  - `RuleBased target ?? 10` and `stopLoss ?? 5`, the reverse of the YAML.
  - `LegManager` literals (`maxLevels`, `squareOffDistance`).
  - `Settings` defaults in `AppConfig.ts` disagree with YAML (`maxPrice` 150 vs 30000).
- Multi-instance strategies re-implement lookup with their own `cfg()` (`BulkPcrStrategy.ts:337`, `BulkPcrAutoStartStrategy.ts:78`, Butterfly, TopStock). `ConfigService.getStrategyConfig(type)` returns only the first block of a type.
- Keys that are read nowhere or only in dead code: `settings.cooldownSeconds`, `settings.trailingDistance`, `logEnabled` on several blocks, and probably `TargetReach.strike/expiry/optionType` and `SupportResistance.quantity` **(verify)**.
- Keys read in code but missing from YAML, with silent defaults: `hedgeStartLevel`, `eodCloseTime`, `refillEnabled`, `maxLossPerDay`, `marketProtectionPercent`.
- `GoodMorning` and `GoodMorningSensex` are copy-paste, with about 14 identical reads each.

### Target design
Layered, with overrides only where a value really differs:

```yaml
defaults:                  # global
  brokers: [zerodha]
  cooldownSeconds: 60
  minPremium: 50
  maxHoldTimeMinutes: 30
  logEnabled: true
  target: { points: 10 }
  stopLoss: { points: 20 }
families:                  # shared by a group of strategies
  legs:    { applies: [Continuous, SupportResistance], maxLevels: 4, squareOffDistance: 500 }
  bulkpcr: { applies: [BulkPcr, BulkPcrAutoStart], quantity: -1 }
strategies:                # overrides only
  - { type: BulkPcrStrategy, userId: BulkPcr-NIFTY, index: NIFTY, target: { points: 3 }, brokers: [ant, zerodha, breeze] }
```

- **One canonical name per concept** (`target.points`, `stopLoss.points`, `quantity`, `brokers`). A load-time alias table maps the old keys to them and logs a deprecation warning, so existing YAML keeps loading.
- **Resolver on `ConfigService`:** `resolve(instanceId, key)` returns the first defined value from strategy block, then family, then `defaults`, then a typed `SCHEMA[key].default`. The schema replaces every scattered `?? 65`.
  - `instanceId` is `userId || type`. This replaces all the per-strategy `cfg()` finders.
  - Merge once in `loadConfig` into a `Map<instanceId, Resolved>`, so each tick is an O(1) lookup.
  - The existing 200ms debounced hot reload and validate-before-apply stay unchanged.
- **Typed schema** replaces `[key: string]: any`, so a typo fails validation instead of silently using a default.
- **Validation:** run the target-vs-stop-loss check (`configValidation.ts:15-74`, which currently lists the same pair three ways) on the **merged** result, so a family default cannot produce a stop loss below the target.
- **Admin UI and API:** `configToFlat`/`flatToConfig` (`ConfigService.ts:36-52`) and `POST /config` (`server.ts:1593`) assume one flat block per type. Make them pass `defaults` and `families` through and keep the layering on write.
- **Merge GoodMorning and GoodMorningSensex** into one parameterised class.
- **Drop** `config/config.properties` (see 2.D).

### Steps
1. Add `SCHEMA` and the resolver. Behaviour stays the same: schema defaults equal today's effective values. Where the code and YAML disagree today (for example `RuleBased`), keep what is live in YAML and note the change.
2. Replace the `??` literals and the `brokers` helper strategy by strategy.
3. Add the alias table and the canonical keys, then migrate `config.yml` to `defaults/families/strategies`.
4. Remove the unread keys and the legacy `settings.*` fields.
5. Update the admin UI and the frontend config page.

**Risk:** medium. A wrong default changes live sizing or stops. Before each step, diff the effective resolved config of every enabled strategy against the old behaviour and require an empty diff. A small script can print both.

---

## 4. Duplicate code

Ordered by value over risk.

| # | Duplicate | Where | Single home |
|---|---|---|---|
| 1 | Local `sleep` / `new Promise(setTimeout)`, about 26 sites | `Minutes5Decision`, `chunkedOrder.ts:6`, `tools/*` | `util/sleep.ts` |
| 2 | ATM and strike-step rounding with per-broker step maps | four `*ContractMaster.ts`, `orderProcess.ts:599/635/680`, `zerodhaExecutor:654`, `breezeExecutor:833`, `ButterflyStrategy:89/136`, `backtestCsvUtils:152` | `util/strike.ts` with `strikeStepFor(index)` and `atmStrike(ltp, index)` |
| 3 | Reconcile-open-trades retry loop (15 tries, 2000 ms) | `ContinuousStrategy ~117`, `SupportResistanceStrategy ~95` (identical), `ButterflyStrategy:469`, `HourlyStrategy:583`, `BulkPcrStrategy:1479` | `getOpenTradesWithRetry()` on the `Strategy` base class or `LegManager` |
| 4 | Brokers-list resolution | four strategies (section 3) | resolver (`brokers`) |
| 5 | Contract-master boilerplate: singleton, `preload`, staleness check, nearest-expiry and ATM selection | `Ant/Zerodha/Breeze/PrismContractMaster` | abstract `ContractMasterBase`. Parsing stays per broker. |
| 6 | Pending-limit-order trackers (Map, `onCancelled`, `track/untrack`, Mongo load, `poll`) | `pendingLimitOrders.ts`, `pendingAntLimitOrders.ts`, `breezePendingLimitOrders.ts`, `pendingPrismLimitOrders.ts` | `PendingOrderTracker<T>` parameterised by collection and a `fetchStatus` callback. ANT keeps its `FLAT_NO_FILL_CONFIRM_POLLS` and session rechecks as hooks. |
| 7 | Chunked buy per broker: resolve contract, step, ATM, estimate, quantity | `orderProcess.ts:599/635/680` | one `Broker` method (section 1). The Zerodha branch is async and the ANT branch isn't, so unify to async. |
| 8 | Fill-poll and retry loops | `breezeExecutor:393`, `prismExecutor:149`, `ANT.ts:787/910`, `Zerodha.ts:335`, `Breeze.ts:505` | `BaseBroker`, extending `chunkedOrder.ts` |
| 9 | Market-hours constants (backend vs frontend), about 34 ad-hoc `getHours()` uses | `util/marketHours.ts`, `frontend/src/utils/marketHours.ts`, `scheduler/signaler.ts` | `util/marketHours.ts`. Share the constants with the frontend through a generated file or a test that asserts they match. |
| 10 | Target/SL/trailing in individual strategies | RoC, Gap, GoodMorning, TargetReach, RuleBased vs `LegManager`/`PnlStop`/`exitMonitor` | return a `getMonitorConfig` and drop the inline checks. Lower confidence: compare behaviour first. |
| 11 | `GoodMorning` and `GoodMorningSensex` | two copy-paste classes | one class (section 3) |
| 12 | `BrokerExecutor.ts` vs `brokerExecutors.ts` | side by side, the second is mostly a factory plus re-exports | one module, `getBroker()` |

Items 1, 2, 3 and 11 are small and safe, so do them first. Items 6 and 5 are medium risk. Items 7 and 8 happen as part of section 1.

---

## Suggested order and verification

**Order**
0. Phase 0a, add the broker-naming mapping to `Architecture.md`. Then do the delete pass (2.A, 2.C) *before* the Zerodha-to-Kite rename, so the rename has less to touch.
0. Phase 0b, Zerodha-to-Kite rename (section 0): code and files first with the read-compat shim, then the data migration, then the frontend build.
1. Phase 0, hygiene and dead files (section 2.C, 2.A). No behaviour risk.
2. Phase 1, small extractions (sleep, strike, reconcile retry, GoodMorning merge).
3. Phase 2, config schema and resolver (section 3, steps 1-2). Zero effective diff.
4. Phase 3, contract-master base class and pending-order tracker.
5. Phase 4, `Broker` interface (section 1). One broker per session: ANT, Prism, Zerodha, Breeze.
6. Phase 5, config layering migration and unread-key cleanup.

**Verification**
- Every step: `npx tsc --noEmit`, clean before and after. Read the diff. (No tests and no code-review until 2026-10-28.)
- After the freeze: the relevant `npm run test:*` scripts and a `code-review` pass on each live-trading change, with a commit between rounds per CLAUDE.md.
- Config: a script prints the effective config of every enabled strategy before and after, and the diff must be empty.
- Broker layer, after hours with `npm run processes`: use the `check-broker-sessions` skill, then place a minimal order through each broker and check it is placed, protected and exited. Check `orchestrator.log` for errors. Use the `monitor-bulkpcr` skill the next session.
- Update `strategies.md`, `API.md` and `CLAUDE.md` where they reference removed files (`src/broker`, `config.properties`, `prism.ts`).
- Remove completed items from `ToDo.md` as they land.

## Open questions
- Resolved: the legacy path is retired, and the four brokers are ant, kite, breeze, prism (section 0).
- **Which `Prism` is live?** The broker survey listed Prism's methods under `src/prism.ts`, while the dead-code scan found `src/prism.ts` unreachable from every entry point. The live client is probably the `src/prism/` directory (`prismExecutor.ts` imports it). Resolve this before deleting anything: `grep -rn "from '.*prism'" src/` and check whether `prismExecutor.ts` resolves to `prism.ts` or `prism/index.ts`. If the live code does depend on `prism.ts`, it moves into `src/prism/` instead of being deleted.
- `monitor.ts` and `server.ts` still call `Prism.getInstance()` directly. Since the legacy path is retired, `monitor.ts` is either reduced to what live code needs or deleted. Decide per method when section 1 step 6 is reached.
- Are `userToken.txt`, `cert.pem` and `key.pem` real credentials? If so, rotate them after untracking.
