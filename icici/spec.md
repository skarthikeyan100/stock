# ContinuousStrategy — Specification

## 1. Purpose

`ContinuousStrategy` is a new trading strategy that opens an initial option position (a "leg") and, as price moves against or in favor of that leg, recursively opens further hedging legs in the opposite direction and/or re-enters in the same direction — building a self-contained chain of legs, all tracked within a single `ContinuousStrategy` instance (no separate spawned strategy-class instances).

It reuses `BuySellStrategy`'s entry-trigger conventions (config-driven `right`, sentiment alignment, cooldown, time-range gating) for how the *first* leg (T1) is opened, but everything after that — the multi-level hedging/reversal/re-entry chain — is new behavior specific to this strategy. `BuySellStrategy` and `IntermittentStrategy` are reference-only; no code from them is reused or extended.

## 2. Terminology

- **Leg**: one open option position (a single buy order and everything that flows from it) tracked by `ContinuousStrategy`.
- **T1**: the first leg, opened by the strategy's own entry signal (same style as `BuySellStrategy`'s entry).
- **Tn**: any leg opened as a *reversal spawn* from another leg (T2 spawned from T1, T3 from T2, etc.). Every leg — T1 or any Tn — follows the identical lifecycle rules in Section 4; there is no special-casing of T1 vs later legs.
- **Direction**: CE (call) or PE (put). A spawned leg always opens in the *opposite* direction of the leg that spawned it.
- **SL distance**: the configured stop-loss/target points value (single value used for both target and stop-loss, per leg — see Section 5).
- **Level (1x–5x)**: multiples of a leg's own SL distance, measured from that leg's own entry price, used to trigger stacked reversal spawns and the eventual square-off (Section 4.2).

## 3. Entry — T1 (and any legs opened via same-direction re-entry, Section 4.1)

- T1 is opened using the same entry-trigger logic as `BuySellStrategy`: config-driven `right` (or computed via the existing "calculate right" logic when unset), sentiment-alignment check, cooldown-elapsed check, time-in-range check.
- Only T1 is signal-driven this way. Every other leg in the chain (T2, T3, ... and stacked levels) is triggered purely by price action on its parent leg (Section 4), never by a fresh entry signal.

## 4. Leg lifecycle

### 4.0 Root vs. nested legs
- **T1 is the root leg.** Every leg spawned via a 1x-4x adverse-level trigger (Section 4.2) is a
  **nested leg**, regardless of depth (T2 nested under T1, T3 nested under T2, etc. — all
  nested).
- Only the root leg is ever eligible for a target-hit refill (4.1) or a post-5x restart. A nested
  leg that hits its own target or its own 5x level simply closes for good — no re-entry order of
  any kind is placed for it.
- Whenever any nested leg closes (by hitting its own target OR its own 5x level), the level-slot
  it occupied on its parent leg becomes free again (Section 4.2) — the parent can spawn a fresh
  leg at that same level again (or a deeper level) if price is still at/beyond that threshold on
  a later tick.

### 4.1 Target hit
- **Root leg:** if price reaches `E + D`, close the position, booking the profit. Then:
  - If there are currently no open nested legs anywhere in the chain, immediately place a limit
    re-entry order for the same direction/quantity at the original entry price `E`.
  - If nested legs are still open, defer the refill: remember the intent, and place the same
    limit re-entry order automatically the moment the last remaining nested leg closes (however
    it closes). This can repeat indefinitely — the only limiter is the capital cap (Section 5a).
- **Nested leg** (any Tn spawned from a level trigger, any depth): if price reaches `E + D`, close
  the position, book the profit, and free the level-slot it occupied on its parent (Section 4.0).
  Do not place any re-entry order for this leg.

### 4.2 Stop-loss / reversal levels (1x-5x of the leg's own SL distance, from its own entry price)
Applies identically to every leg (root or nested), measuring adverse movement from the leg's own
entry price `E`:

| Level | Price threshold (adverse) | Action |
|---|---|---|
| 1x | `E - D` | If this leg's 1x slot is currently free (no open child there), spawn a new leg in the opposite direction there. |
| 2x | `E - 2D` | Same, for the 2x slot. |
| 3x | `E - 3D` | Same, for the 3x slot. |
| 4x | `E - 4D` | Same, for the 4x slot. |
| 5x | `E - 5D` | Square off **this leg only**. Root leg: frees the whole chain to restart per 4.0/4.1 once fully flat (existing entry-gate re-arm). Nested leg: closes and frees its slot on its parent — no re-entry for itself. |

Notes:
- **Per-level slot occupancy, not a one-shot watermark**: each leg tracks, per level (1-4),
  whether that slot currently has an open child. A level fires only when its slot is free. Once
  fired, the slot stays occupied until that child leg closes (its own target or 5x) — at which
  point the slot frees immediately, and the parent can fire that level again (or a deeper level)
  on a later tick if price is still beyond the threshold. Re-fire is instant — no requirement for
  price to first recover back inside the level.
- **Gapped ticks**: within a single tick, only the single deepest level reached is evaluated (skip
  intermediate levels for that tick, as before). If that deepest level's slot is already occupied,
  nothing fires this tick (no fallback to a shallower, already-passed level).
- This slot-based re-arming applies identically at every depth (T1's levels, T2's levels, T3's
  levels, ...), not just the root.

### 4.3 Quantity
- Root leg's initial quantity: config-driven (`initialQuantity`).
- Level-spawn quantity is controlled by a strategy-level toggle, `spawnQuantityMode`:
  - `'multiplied'` (default): 1x/2x/3x/4x spawn quantity = 1x/2x/3x/4x of the parent leg's own
    quantity (unchanged from the original design).
  - `'same'`: every level spawn uses the same quantity as its parent leg, regardless of level.
- Target-hit re-entries (root only, Section 4.1): same quantity as the root leg that hit target.

## 5. Target / Stop-loss configuration

- A single configured points value (e.g. `slDistance`) is used as **both** the target distance and the stop-loss (1x level) distance for every leg — matching the request that "TargetPrice and StopLoss price will be similar."
- This value is a strategy-level config field (applies uniformly to every leg in the chain); it is not configured per-leg individually.

## 5a. Capital cap

- New strategy-level config field `allottedCapital` (same units as `quantity × entryPrice`).
- Before placing any order that adds exposure — root entry, any level spawn, or a root
  refill/restart — compute the running total: `sum(quantity × entryPrice)` over every currently
  open leg, plus every currently-pending (placed, unfilled) limit re-entry's projected cost, plus
  the new order's own projected cost (quantity × the premium found during contract selection). If
  this total would exceed `allottedCapital`, skip placing the order.
- A skip is not sticky: nothing is marked "attempted" — the slot/intent is simply re-evaluated on
  the next qualifying tick, and will fire once capital frees up elsewhere in the chain.

## 6. Strike / contract selection

- Every order placed by `ContinuousStrategy` — T1, every spawned reversal leg, and every re-entry — must select an option contract whose premium is **at least 100** (configurable minimum, default 100). This applies to all legs, not just T1, since any leg can be the "parent" whose price later drops through the 2x–5x range (up to 50 points below its own entry, given `slDistance = 10` as in the worked example), and a low-premium contract could otherwise go through zero.
- Strike selection is by **premium-range lookup** (similar in spirit to the existing Prism-side `getContractByPriceRange` / `settings.minPrice`-`maxPrice` mechanism used by `BuySellStrategy`), not simple ATM selection — because ATM strike selection has no premium-floor concept today.
- **Gap to flag for the design phase**: today, premium-range contract lookup (`getContractByPriceRange`) only exists on the Prism/Shoonya path; the Zerodha contract master (`ZerodhaContractMaster`) currently only supports `findATMOption`/`findExactOption`, not a premium-range search. Since orders must execute on Zerodha (Section 7), a Zerodha-side premium-range strike lookup will need to be designed/added — this spec records the requirement; the design step decides how.

## 7. Order execution / broker

- All orders (T1, every spawned leg, every re-entry) are placed via the **Zerodha** broker path — matching each user's actual configured broker (broker selection remains per-user, as it already is elsewhere in the system), not the Prism/Shoonya path.
- Target/stop-loss/level monitoring for `ContinuousStrategy`'s legs is **self-monitored by the strategy from option tick data** (evaluating each open leg's price against its own target/1x-5x thresholds), not delegated to the existing static `exitMonitor`/GTT bracket mechanism — because the 1x-5x multi-level logic has no equivalent in the existing single-target/single-stop-loss GTT/`exitMonitor` machinery.
- Spawned reversal legs (1x/2x/3x/4x triggers) are placed as **immediate market orders** (they react to a price level already crossed).
- Target-hit re-entries (Section 4.1) are placed as **limit orders** at the original entry price, waiting for price to return.

## 8. Non-goals / explicit exclusions

- No reuse of `BuySellStrategy` or `IntermittentStrategy` classes/code — reference only, for entry-trigger conventions and general `Strategy`-subclass patterns.
- No design/class-structure/data-model decisions in this document — deferred to the design phase.
- A capital-based cap (Section 5a) is the sole limiter on chain growth. There is still no
  explicit maximum chain-depth or maximum-concurrent-legs *count* — exposure is bounded by
  `allottedCapital` instead of a depth/count limit.

## 9. Open items for the design phase

- How Zerodha-side premium-range strike lookup will be implemented (Section 6 gap).
- How self-monitoring of many concurrent legs' target/1x-5x thresholds will be structured (data model, per-tick evaluation).
- Config schema for `ContinuousStrategy` (`initialQuantity`, `slDistance`, `minPremium`,
  `allottedCapital`, `spawnQuantityMode`, entry-trigger fields mirroring `BuySellStrategy`).
- Per-level slot-occupancy data model and the root/nested distinction (Section 4.0) — deferred to
  the design phase, same as before.
- Registration in `StrategyFactory.ts`, `config.yml`/`config.mock.yml` entries, and frontend config-field documentation (`frontend/frontEnd.md`), following the existing per-strategy registration pattern.
