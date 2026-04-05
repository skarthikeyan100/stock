# ICICI Codebase Refactoring - Dead Code Analysis

**Analysis Date:** 2026-02-15
**Total Dead Code Found:** ~3,500 lines across 25 files

---

## Executive Summary

The ICICI options trading codebase has accumulated significant dead code due to:
- Migration from legacy brokers (Breeze, ICICI) to Shoonya/Noren API
- Strategy development iterations (8 out of 12 strategies are unused)
- Abandoned features (stock trading, ORB strategies, scalping)
- Development artifacts (test files, mock data, old server implementations)

**Cleanup Impact:**
- 25 files to delete (17 unused files + 8 unused strategies)
- ~3,500 lines of code to remove
- 165KB disk space to save
- 15+ unused imports to remove
- 8 large commented code blocks to clean up

---

## 1. Unused Files (17 files, ~165KB)

### Trade/Legacy Files (4 files)
| File | Size | Reason |
|------|------|--------|
| `src/trade/option-plus.ts` | 50KB | No imports anywhere, legacy trading file |
| `src/breeze.ts` | 18KB | Legacy Breeze broker, replaced by Shoonya/Noren API |
| `src/server_old.ts` | 8.4KB | Old server implementation |
| `src/worker.ts` | 2.1KB | Unused worker thread code |

### Client/Utility Files (2 files)
| File | Size | Reason |
|------|------|--------|
| `src/icici_client.ts` | 623 bytes | Unused ICICI client wrapper |
| `src/multiple_browsers.ts` | 3.0KB | Multi-browser orchestration, no references |

### Test Files (2 files)
| File | Size | Reason |
|------|------|--------|
| `src/test.py` | 387 bytes | Legacy Python test file |
| `src/test/strategyTest.ts` | 13KB | Not referenced in npm scripts |

### Communication Layer (3 files)
| File | Size | Reason |
|------|------|--------|
| `src/communication/socket_server.ts` | 510 bytes | Replaced by modern WebSocket |
| `src/communication/socket_client.ts` | 522 bytes | Replaced by modern WebSocket |
| `src/communication/server.ts` | 2.4KB | Replaced by modern WebSocket |

### Tools & Backup (6 files)
| File | Size | Reason |
|------|------|--------|
| `src/scheduler/stock-strike-price-original.ts` | 1.6KB | Backup version |
| `src/tools/process_candle_csv.ts` | 2.3KB | Offline data analysis only |
| `src/tools/process_nifty_csv.ts` | 2.2KB | Offline data analysis only |
| `src/tools/process_nifty_csv_bollinger.ts` | 6.0KB | Offline data analysis only |
| `src/tools/bhavcopy.ts` | 987 bytes | Bhavcopy data tool |
| `src/tools/venkatesh.ts` | 4.3KB | Personal analysis utility |

---

## 2. Unused Strategy Files (8 files, 1,433 lines)

| Strategy | Lines | Status | Reason |
|----------|-------|--------|--------|
| **TestStrategy.ts** | 42 | Dead stub | All methods are console.log stubs |
| **ORBPrevious.ts** | 80 | Dead stub | All methods throw "Method not implemented" |
| **PivotStrategy.ts** | 53 | Dead stub | processOptionQuote() is empty |
| **DiffStrategy.ts** | 138 | Dead import | Imported in server.ts but NEVER USED |
| **Minutes5Decision.ts** | 238 | Dead import | Imported but never enabled |
| **BiDirectionStrategy.ts** | 431 | Unused | Largest dead code file, never enabled |
| **HighLotStrategy.ts** | 217 | Unused | Never enabled, no config |
| **SentimentStrategy.ts** | 234 | Unused | Legacy config exists but never instantiated |

**Total:** 1,433 lines

**Note:** IntermittentStrategy is KEPT (spawned by BuySellStrategy internally)

---

## 3. Active Strategies (Keep These)

| Strategy | Lines | Status |
|----------|-------|--------|
| **BuySellStrategy** | 329 | ACTIVE - enabled in config |
| **RuleBasedStrategy** | 388 | ACTIVE - newly implemented |
| **RateOfChangeStrategy** | 248 | COMPLETE - disabled but production-ready |
| **IntermittentStrategy** | 223 | ACTIVE - spawned by BuySellStrategy |

---

## 4. Unused Methods in Core Files

### `/home/karthikeyan/work/icici/src/prism.ts`

**Methods to Delete (5):**
```typescript
getOptionChain()           // Lines 304-314 - only in /test endpoint
findStockToken()           // Lines 437-460 - only called by dead updateStockPrices()
updateStockPrices()        // Lines 462-485 - never called anywhere
findLotSizeByContract()    // Lines 415-435 - redundant logic
findDirectionAndStrikePrice() // Lines 1014-1061 - never called
```

**Classes to Delete (2):**
```typescript
class StockPrice           // Lines 33-41 - only in dead updateStockPrices()
class StrikePrice          // Lines 44-60 - only in unused findDirectionAndStrikePrice()
```

**Commented Code Blocks (5 blocks, 39 lines):**
- Lines 149-165: Bank/Fin Nifty quote checking (16 lines)
- Lines 173-178: Commented Decision calls (6 lines)
- Lines 242-244: Commented subscribeNifty (3 lines)
- Lines 259-260: Commented quote initialization (2 lines)
- Lines 341-352: Commented subscribe/contract enumeration (12 lines)

**Unused Imports (8):**
```typescript
import { AxiosRequestConfig } from "axios";
import { forIn } from "lodash";
import { spawn } from "child_process";
import Browser from "./trade/browser";
import ObjectsToCsv from "objects-to-csv";
import { parse } from "csv-parse";
import moment from "moment";
import * as util from "util";
```

---

### `/home/karthikeyan/work/icici/src/decision.ts`

**Empty Method Stubs to Delete (5):**
```typescript
_checkORBUsingPreviousPrice()        // Lines 179-182
_checkORBUsingOpeningRange()         // Lines 185-186
_decideInFirst5Minutes()             // Lines 189-191
_scalping()                          // Lines 193-195
_utilizeVariationsBetween2And2Thirty() // Lines 197-199
```

**Commented Code (2 blocks, 38 lines):**
- Lines 141-175: Old strategy pattern-matching (35 lines)
- Lines 172-174: Commented method calls (3 lines)

**Unused Fields:**
```typescript
this.depth = 0;  // Line 85 - never used
```

---

### `/home/karthikeyan/work/icici/src/server.ts`

**Legacy Code Block:**
- Lines 1-66: Commented old HTTP server code (66 lines)

**Unused Mock Data (4 constants):**
```typescript
mockOpenPositions    // Lines 70-80
mockRuntimeQuote     // Lines 82-91
mockEvent            // Line 93
mockTrades           // Line 522
```

**Unused Imports/Variables (5):**
```typescript
import Queue from 'async-await-queue';           // Line 136
import DiffStrategy from './strategy/DiffStrategy'; // Line 143
const apiSession = '...';                        // Line 145
const sessionToken = '...';                      // Line 146
const demoLogger = {...};                        // Lines 148-156
```

**Unused Functions:**
```typescript
function _start() { ... }  // Lines 165-172 - never called
```

**Commented Endpoint:**
- Lines 800-822: Old config GET endpoint (23 lines)

---

### `/home/karthikeyan/work/icici/src/strategy/BuySellStrategy.ts`

**Unused Imports:**
```typescript
import { TouchSequence } from "selenium-webdriver";  // Line 8
```

---

## 5. Files to Update (After Deletion)

### `/home/karthikeyan/work/icici/src/strategy/StrategyFactory.ts`

**Remove these imports:**
```typescript
import SentimentStrategy from './SentimentStrategy';
import BiDirectionStrategy from './BiDirectionStrategy';
import DiffStrategy from './DiffStrategy';
import PivotStrategy from './PivotStrategy';
import HighLotStrategy from './HighLotStrategy';
import Minutes5Decision from './Minutes5Decision';
import TestStrategy from './TestStrategy';
```

**Remove from STRATEGY_REGISTRY:**
```typescript
STRATEGY_REGISTRY.set('SentimentStrategy', SentimentStrategy);
STRATEGY_REGISTRY.set('BiDirectionStrategy', BiDirectionStrategy);
STRATEGY_REGISTRY.set('DiffStrategy', DiffStrategy);
STRATEGY_REGISTRY.set('PivotStrategy', PivotStrategy);
STRATEGY_REGISTRY.set('HighLotStrategy', HighLotStrategy);
STRATEGY_REGISTRY.set('Minutes5Decision', Minutes5Decision);
STRATEGY_REGISTRY.set('TestStrategy', TestStrategy);
```

**Keep only:**
```typescript
import BuySellStrategy from './BuySellStrategy';
import IntermittentStrategy from './IntermittentStrategy';
import RateOfChangeStrategy from './RateOfChangeStrategy';
import RuleBasedStrategy from './RuleBasedStrategy';

STRATEGY_REGISTRY.set('BuySellStrategy', BuySellStrategy);
STRATEGY_REGISTRY.set('IntermittentStrategy', IntermittentStrategy);
STRATEGY_REGISTRY.set('RateOfChangeStrategy', RateOfChangeStrategy);
STRATEGY_REGISTRY.set('RuleBasedStrategy', RuleBasedStrategy);
```

---

### `/home/karthikeyan/work/icici/config.yml`

**Remove legacy strategy sections:**
```yaml
# Lines 86-92 - sentimentStrategy section
sentimentStrategy:
  enabled: false
  averageThreshold: 20
  targetPrice: 5
  orderQuantity: 7200
  sentiment: put
  loopCount: 1

# Lines 105-112 - intermittentStrategy section (spawned programmatically)
intermittentStrategy:
  enabled: false
  loopCount: 3
  targetPrice: 2
  quantity: 75
  threshold: 10
  logEnabled: false
```

---

### `/home/karthikeyan/work/nifty/CLAUDE.md`

**Update incorrect documentation:**

**OLD (INCORRECT):**
```markdown
> **Note:** The `trade/icici.ts`, `breeze.ts`, `browser.ts`, and any Python files are legacy/unused code.
```

**NEW (CORRECT):**
```markdown
> **Note:** Legacy files that have been removed: `breeze.ts`, `test.py`, and files in the `/communication/` directory.
> Active legacy code still in use: `trade/icici.ts` (28 imports), `trade/browser.ts` (Selenium integration).
```

**Update strategy list:**
```markdown
Active Strategies:
- BuySellStrategy (main averaging-down strategy)
- RuleBasedStrategy (indicator-based multi-instance strategy)
- RateOfChangeStrategy (rate-of-change detection, currently disabled)
- IntermittentStrategy (spawned by BuySellStrategy on high iterations)

Removed Strategies:
- SentimentStrategy, BiDirectionStrategy, DiffStrategy, PivotStrategy
- HighLotStrategy, Minutes5Decision, TestStrategy, ORBPrevious
```

---

## 6. Deletion Commands

### Step 1: Delete Unused Files
```bash
cd /home/karthikeyan/work/icici

# Trade/Legacy
rm src/trade/option-plus.ts
rm src/breeze.ts
rm src/server_old.ts
rm src/worker.ts

# Client/Utility
rm src/icici_client.ts
rm src/multiple_browsers.ts

# Test
rm src/test.py
rm -rf src/test

# Communication
rm -rf src/communication

# Backup/Tools
rm src/scheduler/stock-strike-price-original.ts
rm src/tools/process_candle_csv.ts
rm src/tools/process_nifty_csv.ts
rm src/tools/process_nifty_csv_bollinger.ts
rm src/tools/bhavcopy.ts
rm src/tools/venkatesh.ts
```

### Step 2: Delete Unused Strategies
```bash
cd /home/karthikeyan/work/icici

# Trivial stubs
rm src/strategy/TestStrategy.ts
rm src/strategy/ORBPrevious.ts
rm src/strategy/PivotStrategy.ts

# Dead imports
rm src/strategy/DiffStrategy.ts
rm src/strategy/Minutes5Decision.ts

# Unused strategies
rm src/strategy/BiDirectionStrategy.ts
rm src/strategy/HighLotStrategy.ts
rm src/strategy/SentimentStrategy.ts
```

---

## 7. Verification Steps

### Build Test
```bash
cd /home/karthikeyan/work/icici
npm run build
# Should compile without errors
```

### Runtime Test
```bash
npm run server
# Expected logs:
# [StrategyFactory] Expanded RuleBasedStrategy into 5 instances
# [Strategies] Initialized N strategies: BuySellStrategy(...), RuleBasedStrategy(...), RateOfChangeStrategy(...)
# NO errors about missing imports
```

### Git Status
```bash
git status
# Should show 25+ deleted files
```

---

## 8. Summary Statistics

| Category | Count |
|----------|-------|
| Files to delete | 25 |
| Total lines removed | ~3,500 |
| Disk space saved | ~165KB |
| Unused imports removed | 15+ |
| Commented blocks removed | 8 (150+ lines) |
| Unused methods removed | 12 |
| Unused classes removed | 2 |

---

## 9. Risk Assessment

**Risk Level:** LOW

**Reasons:**
- All deletions based on static analysis (no imports, no references)
- All code in git - can be restored if needed
- Build and runtime tests will catch any missed dependencies

**Mitigation:**
- Run `npm run build` after each phase
- Test server startup after deletions
- Keep git history for recovery

---

## 10. Items to Keep (Not Dead Code)

**Despite being disabled or having limited use:**

1. **RateOfChangeStrategy** (248 lines)
   - Complete implementation, disabled in config
   - Production-ready, might be enabled later

2. **IntermittentStrategy** (223 lines)
   - Spawned by BuySellStrategy internally
   - Not independently instantiated

3. **browser.ts**
   - Used by decision.ts and scheduler files
   - Selenium WebDriver integration (active)

4. **Monitor wrapper methods**
   - `subscribeTrades()` and `refreshPendingOrders()`
   - Functional, low priority optimization
