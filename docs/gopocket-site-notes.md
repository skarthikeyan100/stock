# GoPocket website notes (recorded 2026-11-17 with Claude in Chrome)

Site: https://web.gopocket.in (login page, then /dashboard). Account is a normal retail login.

## Login / session
- Login page remembers name+phone (in browser storage) and asks for the password; it also offers QR login via the Pocket mobile app. Owner typed the password; Claude never saw it.
- After login, auth is in **localStorage** (keys seen: accessToken, userName, mobileNo, UCC, role, isRiskDialog, isExistUser, preference ...). The only cookie seen was a Razorpay one. So reuse = Playwright persistent profile or storageState (which includes localStorage). Token value was not read.
- After login a "Notice / Risk Disclosure on Derivatives" modal appears with an "I understand" button (accessible name "I understand"). The bot must click it if present.
- Not yet verified: whether a headless browser is accepted, how long the session lasts (owner assumes the full trading day), what happens on expiry.

## Finding a contract
- Dashboard watchlist panel has a search box (placeholder "Search eg: INFY, NIFTY, CRUDEOIL etc.,"). Typing `NIFTY 25400 CE` lists one row per expiry: "NIFTY 17th NOV 25400 CE", "23rd NOV", "1st DEC", "8th DEC", "15th DEC", "29th DEC", "25th JAN27" ... tagged NFO.
- Hovering a row shows buttons B (buy), S (sell), chart, tick (add to watchlist). Clicking B opens the order form directly; no need to add to the watchlist. (Plain click on the row text did nothing visible.)
- Weekly NIFTY expiry dates seen are **Tuesdays** (17 Nov, 1 Dec, 8 Dec, 15 Dec, 29 Dec 2026); 23 Nov is a Monday (probably holiday shifted; not verified). The old WhatsApp bot defaults to the nearest THURSDAY: that must change (compute from the site's search results, not a fixed weekday).

## Buy form (opened with B)
- Header: contract name, LTP, % change. Tabs (button ids): ow_Quick, ow_Regular, ow_Cover, ow_AMO, ow_GTT. Order types: ow_Limit, ow_Market, ow_SL (Regular also has SL-M).
- Fields (input name/id): `qty` (in UNITS, default = 1 lot; Lot shown: 65), `price` (tick 0.05), `coTriggerPrice` (labelled "Trigger Price", disabled for Limit), `triggerPrice` (this is the Stoploss field in the Cover tab). Target is a second numeric field shown after ticking the checkbox "Target (Bracket)" (checkbox value "on"). Quick % buttons +0.5% ... +2.5% under each.
- **Bracket order = Cover tab, Limit, Stoploss filled, "Target (Bracket)" ticked.** Regular tab has Intraday/Positional radio + Validity Day/IOC under "More Options"; Cover tab also has Validity Day/IOC.
- **Target and Stoploss are entered as the DIFFERENCE from the entry price, not as prices** (site tooltip: buy at 100, target 110, stop 95 -> enter target 10, stoploss 5). Ticking the Target checkbox reset Stoploss to 0 and filled Target with 0.85 (a preset of ~0.5% of 171). Set the checkbox first, then the values.
- Bottom of form: margin warning ("Not enough funds. Your margin falls short by ..."), Margin Req, Avail Margin, buttons Cancel / Buy. Account had Rs 0 available at first (funds added later, see the update below).

## Still to record
- A bracket buy that is ACCEPTED during market hours (only the after-hours rejection is recorded so far), the order-placement network request, how to cancel a pending order.
- Sell: S from search, or from Positions; bracket exit behaviour. (Needs an open position, market open: 2026-11-18 or later.)
- Headless check, session expiry behaviour.

## Update 2026-11-17 evening: first real Buy click (done by the owner; Claude does not place trades)
- Funds were added (Equity "Available to trade" 1,00,100.00). A page reload kept the session: no login, no risk notice again.
- Form used: Cover tab, Limit, qty 65, price 171.00, Stoploss 13, Target 14 (differences), Validity Day. Owner clicked Buy at 17:02:55 (market closed).
- Result toast (bottom of dashboard, red, closable with an x): `NIFTY23NOV26C25400 - BUY - 26111700015304` then `REJECTED`. Format: broker symbol `NIFTY23NOV26C25400` (underlying + DDMMMYY + C/P + strike), order number `26111700015304` (YYMMDD + sequence).
- Orders page (/order) tabs: Pending, Executed (n), Tradebook, Basket, Alerts, GTT, SIP. **Rejected and completed orders both appear under "Executed"** (not Pending). Row columns: Time, Type (BUY), Instrument, Product, Qty (filled/total, here `0 / 65`), Price, Status (REJECTED). Our order shows Product `BRACKET / LIMIT` = the Cover tab with Target ticked.
- Hovering a row shows **Repeat** (re-places the order: never automate it) and **More** (Info, Chart, Add to Watchlist). Info dialog tabs Information / History; fields Quantity, Price, Trigger Price, Order Type (L), Product (MIS), Validity (DAY), Exch. Order ID (NA), Time, Exch. Time, Placed by, and **"Rejected reason: RED:'BO' Orders are disallowed after system square off"** (this is the reason text the bot should log).
- So the bracket order itself was accepted by the form and sent to the risk system; the rejection is about time (BO not allowed after the system square-off time). Placing a bracket order must be tried during market hours (the 'BO'/cover cut-off time is NOT yet known; find it).
- Internal REST endpoints seen on the Orders page (method GET, 200): /od-rest/info/orderbook, /od-rest/info/tradebook, /od-rest/info/gtt/orderbook, /od-rest/info/sip/orderbook, /bo-rest/basketorder, /alertrest/alert. The order-placement request itself was NOT captured (network tracking returned nothing after the Buy click). The network tool shows only method/url/status, no bodies. Next time: install an in-page fetch/XHR logger (URL, method, body, response body; no headers) with javascript_tool just before Buy.
- Side effects in the account: order 26111700015304 (rejected, harmless); watchlist 1 contains NIFTY 50 and NIFTY 23rd NOV 25400 CE.

## Update 2026-11-17 (night): any underlying, one lot
- Search `<UNDERLYING> <strike> <CE|PE>` works for stocks and indices. Rows read like `PAYTM 23rd NOV 2000 CE NFO`; **stock options are also listed on BFO** (`PAYTM 26th NOV 2000 CE BFO`), SENSEX only on BFO, BANKNIFTY only on NFO. The bot takes NFO rows when any exist, else BFO, then the nearest expiry (or the stated one).
- One lot = the `step` of the `#qty` field (NIFTY 65, PAYTM 725, HAL 150); the bot orders exactly that quantity. These matched the lot sizes written in the channel posts.
- The channel posts a line `DATE: dd-mm-yyyy` that is the date of the call, not an expiry; the Claude prompt says so.
- The headless dry run (form filled, read back, Cancel) was verified for NIFTY, PAYTM and HAL. A real accepted order is still not recorded.
- A second Chromium on the same `browser-profile/` while the bot runs shows the site as logged out: stop the bot before running `npm run probe`/`probe-buy`.
