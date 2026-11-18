# GoPocket

Reads option calls (any underlying) from WhatsApp and places a one-lot **Regular limit buy** (Positional) on
https://web.gopocket.in with a visible Playwright browser (`headless: false`), then, once the buy is COMPLETE, a **sell OCO GTT** (stoploss + target) as the exit (Cover/bracket orders are not allowed on the account). Exit messages are ignored. Outcomes go to the console and `logs/messages.log`; the bot never sends a
WhatsApp message.

## Setup
```bash
npm install
npx playwright install chromium
cp config.example.json config.json   # edit stop/target fallbacks
```
`config.json` keys: `stop`/`target` (`{percent}` or
`{points}`, used only when a message has none; percent wins), `strikeBandPercent`, `priceMin`/`priceMax` (both for NIFTY calls only),
`dedupeWindowSeconds`, `port` (loopback port the WhatsApp router posts to, default 3101), `headless`, `dryRun` (**true by default: the form is filled and checked but Buy is never
clicked**; set `false` only when you want real orders), `claudeModel` (the model for `claude -p`; `claude-haiku-5-5` is set: same answers as the default on the real posts at about a tenth of the usage).

## Daily routine
1. `npm run login` once each morning. A browser window opens; type your password/OTP yourself. The session is kept in
   `browser-profile/` (the site stores its token in localStorage).
2. Start the bot with `npm run dev` (it listens on `127.0.0.1:<port>`). WhatsApp itself is handled by the router project `~/work/whatsapp`, which forwards each message here.
3. Watch the console. Every message ends as `ignored`, `duplicate`, `skipped`, `ordered` or `failed` with a reason.

## Safety rules built in
- Any option (index or stock) is traded; cash posts, chatter and exit messages are ignored, and any message containing
  the whole word "Again" or "cash" is skipped without a Claude call.
- Every other message goes to `claude -p`. Its output is checked before any order: stop below / target above entry and
  expiry not past for every underlying; for NIFTY also strike near the live NIFTY level and a plausible price. Other
  underlyings use the message price as given.
- Same message or same contract within `dedupeWindowSeconds` -> one order.
- Always exactly one lot: the quantity is the site's own lot size, read from the order form (the message's lot size is ignored).
- A result that cannot be confirmed on the site is reported as `unknown`: check the website.

## Tools
- `npm run probe`: headless check that the saved session works (never clicks Buy).
- `npm run probe-buy -- NIFTY CE 25400 54 13 14`: fills the bracket form headlessly and reads it back (never clicks Buy).
- `npm test`: unit tests. `docs/gopocket-site-notes.md`: recorded page flows.

## Starting everything
`npm run start` starts GoPocket and the WhatsApp router (`../whatsapp`, or `WHATSAPP_DIR`), each only if it is not
already running (GoPocket is detected by its port, the router by its process). Both run in the background; logs are
`logs/bot.out.log` and `../whatsapp/logs/router.out.log`. If the saved GoPocket session is logged out it stops and tells
you to run `npm run login`. If it is logged out and `.env` has `GOPOCKET_MOBILE` and `GOPOCKET_PASSWORD` (copy `.env.example`; gitignored, keep it `chmod 600`), it logs in by itself and asks you for the OTP in the terminal; without them it tells you to run `npm run login`.

## Status (2026-11-17 night) and what is next
Everything so far was verified in **dry run only**: no real order has been placed and no accepted order has been seen.

**Verified**
- Router (`../whatsapp`) -> GoPocket over loopback with a self-chat message: parsed by Claude, sized as one lot, bracket form filled and read back on the live site (NIFTY, PAYTM, HAL), then cancelled.
- Haiku 5.5 (`claudeModel`) gave the same answers as the default model on the real channel posts.
- Skips without a Claude call: "Again", "cash", and messages with no CE/PE. A stated expiry month is honoured (never trades another month).
- 101 unit tests, `tsc` clean. `npm run start` skips whatever is already running.

**Not verified yet**
1. **First live order (owner-run, market hours):** set `"dryRun": false` in `config.json`, run a 1-lot order, watch the result. Unverified until then: toast/status parsing, the rejected-reason lookup (Orders > Executed > Info), the bracket/cover cut-off time (the only recorded rejection was "'BO' Orders are disallowed after system square off"), how to cancel a pending order, and the order-placement request.
2. **A real post from the channel** (`Pavithra Sky Calls`) through router -> bot: the chat-name match has only been tested with a self-chat message.
3. **Automated login in `npm run start`** (`.env` mobile + password, OTP asked in the terminal): written from the recorded screens, never run against the site. Headless login is also untested; set `"headless": false` if the site refuses it.
4. **The restarted router** has not been checked to have finished linking to WhatsApp (`../whatsapp/logs/router.out.log`).

**Known risks**
- Non-NIFTY calls use the message price as given (owner's decision): a typo'd strike or stale call is ordered as written. NIFTY keeps the spot-band and price-range checks.
- Session lifetime on the site is unknown; the bot reports "session expired" if it lapses.
- `.env` holds the password in plain text: keep it `chmod 600`.

**Still to do**
- Final whole-branch self-review of GoPocket (no subagent tool available), fix findings, ledger, finish the branch.
- Record in `docs/gopocket-site-notes.md`: an accepted bracket buy, the cut-off time, the order request.
- Later: the "enrich" broker and its route in the router config; a README for `../whatsapp`.

## Status (2026-11-18, live)
- Verified live: message -> Claude parse -> Regular Limit buy filled -> sell OCO GTT created and listed (the GTT was created through `POST /gtt`, loopback only; the automatic buy-to-GTT chain with the fixed fill check is not yet seen end to end).
- GoPocket opens a visible browser on start and logs in with `.env` mobile + password; type the OTP in that window. Do not use the window or log in elsewhere (one session only).
- Fill detection matches the Executed row by contract (rows have no order number).
- Page handling (2026-11-18): GoPocket stays parked on Orders > Pending and opens the buy form from that page's watchlist search (no per-message navigation). After the buy it waits on Pending until the tab shows "No Pending orders Found", then clicks Executed once to read the status (COMPLETE -> exit GTT). One order at a time: a message that arrives while an order is in progress, or while an order is pending, is rejected, not queued.
