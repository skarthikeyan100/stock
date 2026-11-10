# ContinuousStrategy loss cut and cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Timing:** do not start code changes before 10:45 IST on 2026-10-30. Live BulkPcr and NiftyChange trades are expected then; nothing in this plan touches their code.

**Goal:** When ContinuousStrategy's max-loss stop trips, cut its investment cap by `lossInvestmentCut` and release the lockout after `lossCooldownSeconds`, the same mechanism BulkPcr already uses.

**Architecture:** Mirror BulkPcr's `lossInvestmentCut` / `lossCooldownSeconds` in `LegManager` (shared by ContinuousStrategy and the disabled ANT/Breeze variants). The cut and cooldown end are persisted in the existing `strategyLatches` Mongo doc, so a restart keeps them. Default `lossCooldownSeconds: 0` keeps today's behaviour exactly (locked for the day).

**Tech Stack:** TypeScript, Mongo (`strategyLatches` collection), `config.yml` hot reload.

**Spec:** this plan (the decisions below were agreed in chat on 2026-10-30; no separate spec document).

## Global Constraints

- `enabled: false` means no action (CLAUDE.md). The cooldown release must not place orders on a disabled strategy.
- Never delete `config.yml` keys; only add `lossInvestmentCut` and `lossCooldownSeconds` to the Continuous block.
- No in-memory-only operator control: the cut and cooldown end must be in Mongo, not just in memory.
- Config values used: `lossInvestmentCut: 10000`, `lossCooldownSeconds: 300` on `ContinuousStrategy` (Kite, `config.yml` line 28 block). ANT and Breeze blocks stay at 0 (no cooldown), so their behaviour does not change.

## Review Focus

1. Cooldown elapses while a max-loss close sell is still resting -> release must wait until no leg is open and no sell is pending (`legsByToken` empty and no pending exit).
2. Restart during cooldown -> cut and cooldown end are reloaded from `strategyLatches`; an elapsed cooldown releases at load; a pending one re-arms its timer.
3. Cut would make the cap zero or negative -> stays locked for the day (BulkPcr's `giveUp` rule).
4. Second max-loss trip after a release -> cut stacks (cumulative for the day), cap and threshold use the reduced cap.
5. Cap cut vs. `maxInvestment` / `maxInvestment` -> `resolveMaxInvestment` prefers `maxInvestment`; the cut must apply to the value it returns, not `maxInvestment`.

---

### Task 1: Config keys and loss-cut state

**Files:**
- Modify: `src/strategy/LegManager.ts` (config type near line 116; fields near line 197; `checkAndMaybeTripMaxLoss` near line 544)
- Modify: `config.yml` (ContinuousStrategy Kite block, values only; add the two keys)
- Test: `tests/legmanager.maxLossCut.test.ts` (new; test script not to be run unless asked)

**Interfaces:**
- Consumes: `resolveMaxInvestment(cfg)` from `src/prism/configVocabulary.ts` (unchanged).
- Produces: `LegManagerConfig.lossInvestmentCut?: number | null` and `lossCooldownSeconds?: number | null`; private `lossInvestmentCutTotal: number` (today, starts 0); private `effectiveMaxInvestment(cfg): number` = `resolveMaxInvestment(cfg) - lossInvestmentCutTotal`.

- [ ] **Step 1: Write the failing test** - a LegManager with `maxInvestment: 200000`, `lossInvestmentCut: 10000`, after one max-loss trip `effectiveMaxInvestment(cfg)` is `190000`; with no cut it is `200000`.
- [ ] **Step 2: Run it to see it fail** (method not defined).
- [ ] **Step 3: Implement** the config fields, the total, and `effectiveMaxInvestment`; use `effectiveMaxInvestment` in `checkAndMaybeTripMaxLoss` (threshold) and `capitalCheck` (cap). Keep the BulkPcr-compatible behaviour: the loss percentage is taken of the effective cap.
- [ ] **Step 4: Run the test to see it pass.**
- [ ] **Step 5: Verify compile** - `npx tsc` must finish with no errors.

### Task 2: Trip cuts the cap and starts the cooldown

**Files:**
- Modify: `src/strategy/LegManager.ts` (`checkAndMaybeTripMaxLoss` near line 544; `persistLatch` near line 499)
- Test: `tests/legmanager.maxLossCut.test.ts`

**Interfaces:**
- Consumes: Task 1 `effectiveMaxInvestment`, `lossInvestmentCutTotal`.
- Produces: private `lossCooldownUntil: number | null` (epoch ms); `onMaxLossTrip(cfg)`: adds `lossInvestmentCut` to the total when it is > 0; sets `lossCooldownUntil = Date.now() + lossCooldownSeconds*1000` when cooldown > 0, else `null`; calls `persistLatch('maxLossTripped')` with the new fields in the same write.

- [ ] **Step 1: Write the failing test** - after a trip with `lossCooldownSeconds: 300`, `lossCooldownUntil` is within 1 s of now + 300 000 ms and the total is 10000; with `lossCooldownSeconds: 0` the cooldown is `null` (locked for the day).
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** `onMaxLossTrip` and call it from `checkAndMaybeTripMaxLoss` in place of the bare `maxLossTripped = true` line. Extend `persistLatch`'s `$set` with `lossInvestmentCutTotal` and `lossCooldownUntil`.
- [ ] **Step 4: Run the test to see it pass.**
- [ ] **Step 5: Verify compile** - `npx tsc`.

### Task 3: Cooldown release

**Files:**
- Modify: `src/strategy/LegManager.ts` (new `maybeReleaseMaxLoss()`; called from the tick path that already checks the trip, near line 756, and from a timer armed on trip)
- Test: `tests/legmanager.maxLossCut.test.ts`

**Interfaces:**
- Consumes: Task 2 `lossCooldownUntil`, `maxLossTripped`.
- Produces: `maybeReleaseMaxLoss(): void` - if `maxLossTripped` and `lossCooldownUntil` has passed and `legsByToken.size === 0` and no pending exit, clears `maxLossTripped` and `lossCooldownUntil`, persists (`lossCooldownUntil` null, `maxLossTripped` false), logs the release. If the cap is still above 0 after the cut; otherwise it stays locked (Review Focus 3).

- [ ] **Step 1: Write the failing test** - release does nothing while a leg is open; releases once the cooldown has passed and no leg is open; does not release when the effective cap is 0.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** `maybeReleaseMaxLoss`. Arm a single `setTimeout` at trip time for the cooldown end; if legs are still open when it fires, re-check every 5 s. Clear the timer in `reset()`.
- [ ] **Step 4: Run the test to see it pass.**
- [ ] **Step 5: Verify compile** - `npx tsc`.

### Task 4: Restart and reset

**Files:**
- Modify: `src/strategy/LegManager.ts` (`loadPersistedLatches` near line 507; `reset()` near line 1360)
- Test: `tests/legmanager.maxLossCut.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `loadPersistedLatches()` now also restores `lossInvestmentCutTotal` and `lossCooldownUntil`; if the cooldown has passed at load, it releases immediately (only when no legs are open); otherwise re-arms the timer. `reset()` clears the total, the cooldown end and the timer.

- [ ] **Step 1: Write the failing test** - a persisted doc with a cut of 10000 and a future cooldown end restores both and stays locked; a doc with a past cooldown end releases at load; `reset()` clears both.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** the load and reset changes.
- [ ] **Step 4: Run the test to see it pass.**
- [ ] **Step 5: Verify compile** - `npx tsc`.

### Task 5: Config values and verification

**Files:**
- Modify: `config.yml` (ContinuousStrategy Kite block only: add `lossInvestmentCut: 10000` and `lossCooldownSeconds: 300`)

- [ ] **Step 1: Add the two keys** to the Kite block. Do not touch the ANT or Breeze blocks, and do not delete any key.
- [ ] **Step 2: Re-read the block** to confirm the values and that `enabled` is unchanged.
- [ ] **Step 3: Run `npx tsc`** - no errors.
- [ ] **Step 4: Variation check** (CLAUDE.md "Think Like a Senior Developer") - confirm each Review Focus line has a task that owns it, and that the strategy trades again only through the existing entry path.
- [ ] **Step 5: Commit** only after the user confirms the change is done (CLAUDE.md "Finishing a Task"). Do not run `npm run test:*` unless the user asks.

## Open decisions for the user (before Task 1)

1. **Capital gate.** Its latch is separate from max loss and stays permanent for the day, even after the cooldown releases. Leave it (recommended), or also release it when the max-loss cooldown ends?
2. **Threshold basis.** The max-loss threshold is taken of the effective (reduced) cap, as BulkPcr does. Confirm.
3. **Restart needed.** Code is picked up only at a restart. A restart with open positions must follow the CLAUDE.md startup checklist.
