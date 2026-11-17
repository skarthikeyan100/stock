# GoPocket

Reads option calls (any underlying) from WhatsApp and places a one-lot **bracket order** (limit buy + target + stop loss) on
https://web.gopocket.in with a headless Playwright browser. Buy only: the bracket's own target and stop handle the
exit, so exit messages are ignored. Outcomes go to the console and `logs/messages.log`; the bot never sends a
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
you to run `npm run login`. `.env` (copy `.env.example`, gitignored) is reserved for the automated login below.
