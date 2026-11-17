# GoPocket

Reads NIFTY option calls from WhatsApp and places a **bracket order** (limit buy + target + stop loss) on
https://web.gopocket.in with a headless Playwright browser. Buy only: the bracket's own target and stop handle the
exit, so exit messages are ignored. Outcomes go to the console and `logs/messages.log`; the bot never sends a
WhatsApp message.

## Setup
```bash
npm install
npx playwright install chromium
cp config.example.json config.json   # edit allowedSenders, investment, lotSize, stop/target fallbacks
```
`config.json` keys: `allowedSenders`, `investment` (rupees per order), `lotSize`, `stop`/`target` (`{percent}` or
`{points}`, used only when a message has none; percent wins), `strikeBandPercent`, `priceMin`/`priceMax`,
`dedupeWindowSeconds`, `headless`, `dryRun` (**true by default: the form is filled and checked but Buy is never
clicked**; set `false` only when you want real orders), `claudeModel` (optional).

## Daily routine
1. `npm run login` once each morning. A browser window opens; type your password/OTP yourself. The session is kept in
   `browser-profile/` (the site stores its token in localStorage).
2. `npm run dev`. First time only: scan the WhatsApp QR (Linked Devices).
3. Watch the console. Every message ends as `ignored`, `duplicate`, `skipped`, `ordered` or `failed` with a reason.

## Safety rules built in
- NIFTY only; BANKNIFTY, stocks, chatter and exit messages are ignored.
- A message goes to the regex parser first; anything it cannot fully read goes to `claude -p`, whose output is checked
  (strike near NIFTY spot, plausible price, stop below / target above entry, expiry not past) before any order.
- Same message or same contract within `dedupeWindowSeconds` -> one order.
- `lots = floor(investment / price / lotSize)`; 0 lots -> skipped.
- A result that cannot be confirmed on the site is reported as `unknown`: check the website.

## Tools
- `npm run probe`: headless check that the saved session works (never clicks Buy).
- `npm run probe-buy -- CE 25400 54 1 13 14`: fills the bracket form headlessly and reads it back (never clicks Buy).
- `npm test`: unit tests. `docs/gopocket-site-notes.md`: recorded page flows.
