# Frontend — React Web App (PropFirm Trading)

**Location:** `icici/frontend/`
**Framework:** React 18 + TypeScript + Vite
**UI Library:** React-Bootstrap 5.3
**State management:** React Context API (`AuthContext`, `TradingContext`)
**Auth:** Google OAuth 2.0 (`@react-oauth/google`)

---

## Run Commands

| Command | Description |
|---|---|
| `npm run dev` | Vite dev server on port 5173, proxies to `localhost:3000` |
| `npm run dev:mock` | Vite dev server, proxies to `localhost:4000` (mock backend) |
| `npm run mock` | Standalone Express mock backend on port 4000 |
| `npm run build` | Build to `../public/app/`, served by Express at `/app/` |
| `npm run symbols -- <MONTH>` | Regenerate `public/symbols.txt` for the given expiry month (e.g. `APR`, `MAY`) |

### Updating symbols.txt

`public/symbols.txt` contains NFO contract symbols used by the typeahead search in OrderEntry. It must be refreshed each month when the new expiry series becomes active.

```bash
npm run symbols -- APR   # replace with the new month before expiry
```

The script (`update-symbols.sh`) filters column 5 (TradingSymbol) from `/home/karthikeyan/Downloads/NFO_symbols.txt/NFO_symbols.txt` for the given month. The month name is case-insensitive (`apr`, `Apr`, `APR` all work). Defaults to `APR` if no argument is provided.

---

## Directory Structure

```
frontend/
├── src/
│   ├── App.tsx                     # Router + auth guards
│   ├── App.css                     # Global styles
│   ├── main.tsx                    # React entry point
│   ├── components/
│   │   ├── NiftyTicker.tsx         # Live NIFTY price strip (SSE)
│   │   ├── OrderEntry.tsx          # Flash trade buttons + symbol search
│   │   └── PositionCard.tsx        # Trade card with P&L, target/SL, square-off
│   ├── context/
│   │   ├── AuthContext.tsx         # Google login, session management
│   │   └── TradingContext.tsx      # Trades, P&L, order actions, SSE positions
│   └── pages/
│       ├── LoginPage.tsx           # Google Sign-In landing
│       ├── RulesPage.tsx           # Trading rules acceptance
│       ├── TradingPage.tsx         # Main trading interface
│       └── AdminPage.tsx           # User management + strategy config
├── public/
│   └── symbols.txt                 # NFO contract symbols (for typeahead search)
├── mock-server.js                  # Standalone mock backend (port 4000)
├── vite.config.ts                  # Vite config: base=/app/, proxy rules
└── index.html
```

---

## Routing (`App.tsx`)

Wrapped in `GoogleOAuthProvider` → `AuthProvider` → `BrowserRouter`.

| Path | Component | Guard |
|---|---|---|
| `/app` | `LoginPage` | None |
| `/app/rules` | `RulesPage` | `RequireAuth` |
| `/app/trade` | `TradingPage` (inside `TradingProvider`) | `RequireAuth` |
| `/app/admin` | `AdminPage` | `RequireAdmin` |
| `*` | Redirect to `/app` | — |

**`RequireAuth`** — redirects to `/app` if not logged in (shows spinner while loading).
**`RequireAdmin`** — redirects to `/app` if user role is not `admin`.

---

## Contexts

### AuthContext (`context/AuthContext.tsx`)

Manages Google OAuth login and server-side session.

**`AuthUser` interface:**
```ts
{
  email: string;
  name: string;
  picture: string;
  lossLimit: number;        // per-user max loss (default 15000)
  lotCount: number;         // max lots allowed (default 10)
  investmentAmount: number; // capital allocated
  investmentMode: 'lotCount' | 'investmentAmount';
  role: string;             // 'user' | 'admin'
}
```

**Lifecycle:**
- On mount → `GET /auth/me` to restore session from cookie
- `login(credential)` → decodes Google JWT, posts `{ email, name, picture }` to `POST /auth/login`, sets user state
- `logout()` → `POST /auth/logout`, clears user state

**Exports:** `useAuth()` hook, `AuthProvider`, `AuthUser` type.

---

### TradingContext (`context/TradingContext.tsx`)

Central state for open/closed trades, P&L, and order actions. Connects to `/positionstream` SSE.

**State:**
| Field | Description |
|---|---|
| `trades` | Active positions (`open !== false`) |
| `closedTrades` | Closed positions (`open === false`) |
| `openPnL` | Unrealized P&L: `sum((ltp - avgPrice) * qty)` |
| `closedPnL` | Realized P&L: sum of `realizedPnL` on closed trades |
| `totalPnL` | `openPnL + closedPnL` |
| `usedAmount` | `sum(price * quantity)` for active trades |
| `placingOrder` | True while an order HTTP request is in flight |
| `isOrderDisabled` | `tradedLots >= lotLimit \|\| totalPnL <= -maxLoss \|\| placingOrder` |
| `orderError` | Last order rejection message |

**Lot counting:** Uses per-instrument lot sizes (BANKNIFTY=15, FINNIFTY=25, NIFTY=65) to convert qty → lots.

**Actions:**
| Method | Endpoint | Notes |
|---|---|---|
| `placeOrder(right)` | `GET /order?index=NIFTY&right=<right>&action=Buy` | Flash trade — server auto-picks strike |
| `placeContractOrder(contract)` | `GET /order?contract=<contract>&action=Buy` | Specific symbol from typeahead |
| `squareOff(token, qty)` | `GET /squareoff?token=<token>&qty=<qty>` | Market exit |
| `setTargetStopLoss(token, tp, sl)` | `POST /settarget` `{ token, targetPoints, stopLossPoints }` | Per-trade TP/SL |

All order calls send `X-User-Id: <user.email>` header.

**SSE reconnection:** Retries up to 3 times on error with 3 s delay. Stops after 3 failures (requires page refresh).

---

## Pages

### LoginPage (`pages/LoginPage.tsx`)

Google Sign-In card. On successful login, navigates to `/app/rules`. If already logged in, redirects immediately.

---

### RulesPage (`pages/RulesPage.tsx`)

Displays 3 trading rules in a card. "Accept & Continue" button navigates to `/app/trade`. No checkbox — acceptance is implicit on click.

**Rules shown:**
1. Multiple trades allowed up to configured quantity limit
2. Max loss per session: ₹15,000
3. Positions may be auto-squared at loss limit

---

### TradingPage (`pages/TradingPage.tsx`)

Main trading interface. Layout from top to bottom:

1. **Sticky P&L header** — user avatar + name + logout button on left; current open P&L centered; total P&L (including closed trades) on right. Color-coded green/red.
2. **Available/Used amount bar** — shows `investmentAmount - usedAmount` and `usedAmount`.
3. **NiftyTicker** — live NIFTY 50 price strip.
4. **Loss limit warning** — amber alert when `|totalPnL| >= 80% of maxLoss`.
5. **OrderEntry** — flash trade + symbol search.
6. **Positions tabs** — "Active Positions" and "Closed Trades" tabs, each showing `PositionCard` per trade.

---

### AdminPage (`pages/AdminPage.tsx`)

Admin-only dashboard with two tabs:

#### User Management tab
- Table of all users with: avatar, name, email, role badge, loss limit, lot count, session P&L, active trade status.
- Inline edit: loss limit, lot count, role — saved via `POST /users/<email>/settings` + `PATCH /users/<email>/role`.
- Add User form: email, name, loss limit, lot count, role → `POST /users`.
- Delete user → `DELETE /users/<email>` (cannot delete self).
- Auto-refreshes every 5 s.

#### Strategy Configuration tab
- Loads from `GET /config`, saves via `POST /config`.
- Sections rendered with `renderConfigField()` helper (number input or boolean toggle):
  - **Global Settings:** `minPrice`, `maxPrice`
  - **BuySellStrategy:** enabled, initialQuantity, incrementQuantity, averageThreshold, targetPrice, maxIterationCount, right, stopEnabled, logEnabled
  - **ContinuousStrategy:** enabled, initialQuantity, slDistance, minPremium, allottedCapital, spawnQuantityMode, right, cooldownSeconds, logEnabled
  - **SentimentStrategy:** enabled, averageThreshold, targetPrice, orderQuantity, sentiment, loopCount
  - **IntermittentStrategy:** enabled, loopCount, targetPrice, quantity, threshold, logEnabled
  - **RateOfChangeStrategy:** enabled, rocThresholdPercent, quantity, targetProfitPercent, stopLossPercent, maxHoldTimeMinutes, cooldownSeconds, useWindowMomentum, gapOnlyMode, gapReversalMode, gapReversalThreshold, logEnabled

---

## Components

### NiftyTicker (`components/NiftyTicker.tsx`)

Thin strip showing live NIFTY 50 price, connects to `/niftystream` SSE.

- Parses `data.nifty` from the event (falls back to raw data)
- Displays: label · LTP · change (▲/▼ with points) · change% · last trade time
- Time formatting: handles both epoch seconds and `HH:MM:SS` string formats
- Reconnects up to 3 times on failure

---

### OrderEntry (`components/OrderEntry.tsx`)

Two-section order entry form.

**Section A — Flash Trade:**
- Green "Up" button → `placeOrder('call')`
- Red "Down" button → `placeOrder('put')`
- Both disabled when `isOrderDisabled`; show spinner while `placingOrder`

**Section B — Symbol Search:**
- Loads `symbols.txt` on mount; filters out expired contracts by parsing `DDMMMYY` from symbol name
- Typeahead: triggers on ≥4 chars; splits input by spaces, AND-filters symbols, shows top 10 in dropdown
- User selects a symbol → Buy button enabled → `placeContractOrder(symbol)`
- Dropdown closes on outside click

Shows `orderError` as dismissible danger alert and a static "loss limit reached" message when applicable.

---

### PositionCard (`components/PositionCard.tsx`)

Card for a single trade (active or closed).

**Active trade shows:**
- Contract symbol + CE/PE badge (blue=CE, yellow=PE)
- Qty · Avg price
- LTP + unrealized P&L (color-coded)
- Square Off button → `squareOff(trade.tsym, trade.quantity)`
- Target/SL input (if not yet set): two `InputGroup` fields for target points and SL points → `setTargetStopLoss(token, tp, sl)`. Once set, displays current values instead.

**Closed trade shows:**
- Same header with "Closed" badge, reduced opacity
- Realized P&L from `trade.realizedPnL`
- No Square Off button, no target/SL inputs

---

## Vite Configuration (`vite.config.ts`)

- `base: '/app/'` — all assets and routes under `/app/`
- Build output: `../public/app/` (served statically by Express)
- Dev proxy routes (to `localhost:3000` or `localhost:4000` with `MOCK=true`):
  `/order`, `/squareoff`, `/trades`, `/optionstream`, `/positionstream`, `/niftystream`, `/auth`, `/users`, `/settarget`

---

## Mock Server (`mock-server.js`)

Standalone Express on port 4000 for frontend development without the real backend.

| Endpoint | Behavior |
|---|---|
| `GET /trades` | Returns current in-memory trades array |
| `GET /positionstream` | SSE; broadcasts position updates |
| `GET /order` | Creates mock trade, starts 3 s price tick interval, broadcasts |
| `GET /squareoff` | Closes trade, sets `open: false`, broadcasts |

Trade shape matches the real server: `{ _id, user, open, tsym, quantity, price, token, action, status, right, lastTradePrice, realizedPnL }`.

---

## API Endpoints Used

| Method | Endpoint | Called from |
|---|---|---|
| GET | `/auth/me` | AuthContext (session restore) |
| POST | `/auth/login` | AuthContext `login()` |
| POST | `/auth/logout` | AuthContext `logout()` |
| GET | `/positionstream` (SSE) | TradingContext |
| GET | `/niftystream` (SSE) | NiftyTicker |
| GET | `/order` | TradingContext `placeOrder`, `placeContractOrder` |
| GET | `/squareoff` | TradingContext `squareOff` |
| POST | `/settarget` | TradingContext `setTargetStopLoss` |
| GET | `/users` | AdminPage |
| POST | `/users` | AdminPage (add user) |
| POST | `/users/:email/settings` | AdminPage (edit user) |
| PATCH | `/users/:email/role` | AdminPage (change role) |
| DELETE | `/users/:email` | AdminPage (delete user) |
| GET | `/config` | AdminPage |
| POST | `/config` | AdminPage |
