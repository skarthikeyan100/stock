# GoPocket: WhatsApp signal to website order bot — Design

Status: DRAFT v2, awaiting approval (2026-11-17; updated with the owner's answers)

## Intent and why
The owner receives NIFTY option trading calls on WhatsApp and wants each call turned into a real order on the GoPocket broker website. GoPocket has no API, so orders are placed by driving the website with a headless browser. The project is standalone (outside `/home/karthikeyan/work/icici`) and is a clone of `/home/karthikeyan/later/whatsapp/` (a whatsapp-web.js bot, ~450 lines, that already reads, whitelists and parses messages and replies on WhatsApp).

## Goals
1. Buy a NIFTY option from a WhatsApp call: limit order with a bracket (target + stop loss), placed on the GoPocket website.
2. ~~Sell (exit)~~ DROPPED (owner, 2026-11-17): the cover/bracket order carries its own target and stop, so exit messages are ignored.
3. Headless, unattended. Log in once by hand; reuse the saved session (cookies) afterwards.
4. Parse messages that do not follow one format, and ignore everything that is not a NIFTY call, using Claude as a fallback to the existing regex parser.
5. Report what happened (bought/exited with quantity and price, or skipped/failed and why) on the console and in the log file only. No WhatsApp replies (owner's decision).

## Non-goals
- No support for other brokers or other instruments (BANKNIFTY, FINNIFTY, stocks are ignored).
- No integration with the ICICI project, its strategies, Mongo or risk limits.
- No automated OTP/PIN login (a session expiry is reported on the console and fixed by a manual re-login).
- No WhatsApp replies or alerts; the bot only reads WhatsApp.
- No position sizing logic beyond the single formula below; no averaging, trailing, or strategy behaviour.

## Anti-goals (a failure even if it "works")
- Placing an order from a misparsed message (wrong strike, side, expiry, price).
- Placing the same order twice (duplicate/edited/re-delivered message).
- Placing a buy with no target/stop attached.
- Silently doing nothing: every message that reaches the pipeline ends in a console line and a log entry stating the outcome.

## Constraints and known facts
- Verified: the existing bot's seam is `src/tradingApi.ts`, which POSTs `{contract, price, action}` and expects `{success, quantity, rate}`; the parser returns instrument, expiry, type, strike, price, action; weekly expiry defaults to the nearest Thursday, monthly expiry is not implemented.
- Verified: the ICICI project sizes as `lots = floor(investment / premium / lotSize)` (`src/strategy/SimpleContinuousStrategy.ts:408`).
- NOT verified (to be found in the recording session, before building on it): GoPocket's login method (password/OTP/PIN), whether headless Chromium is accepted, the exact page flows and selectors for buy, bracket and sell, and whether the site exposes a lot size or LTP.
- The Chrome extension is only usable inside a Claude session; the running bot cannot call it. It is used for learning the site only.
- Owner's assumption (not verified): a login session lasts the full trading day, so login is done once each morning. The pre-order session check stays as a safety net.
- Sell flow can only be recorded when the market is open and a position exists (earliest 2026-11-18).

## Approaches considered
A. **Playwright module inside a clone of the WhatsApp bot (chosen).** One Node/TypeScript process: WhatsApp client, parser, Playwright order module. Simple, one thing to run, reuses tested code.
B. Two processes: the WhatsApp bot POSTs to a separate local "GoPocket order service" (Playwright) over HTTP, i.e. keep `tradingApi.ts` as is. Cleaner separation and the order service could be reused later, but two processes to run and supervise for a single use case. Rejected for now; the module boundary in A (`buy()`/`sell()`) keeps this option open.
C. Claude drives the browser live per message. Rejected: needs a live Claude session per order, slow and unreliable for unattended trading.

For parsing: (1) regex only (no flexibility); (2) Claude for every message (slow, cost, more exposure to LLM mistakes); (3) **regex first, Claude only for messages regex cannot read (chosen).**

## Design
### Pipeline
WhatsApp message -> whitelist -> dedupe -> parse -> validate -> size -> place order (Playwright) -> console/log outcome.

### Parsing
- Existing regex parser first. If it yields a complete result, use it.
- Otherwise call Claude via the headless CLI (`claude -p` with a JSON schema; the owner named the CLI; the Anthropic API is the fallback choice if CLI latency/reliability is unacceptable). Claude only reads the text and returns `{relevant, action, strike, type, expiry, price, target, stop}` (target/stop null when absent). It never chooses to trade, size, or set target/stop.
- Non-NIFTY or irrelevant messages return `relevant: false` and are logged, not ordered, not replied to (so chatter does not produce replies).
- Guard rails in plain code, applied to every parsed result (regex or Claude): strike within a configured band of current NIFTY spot, price within a plausible band, expiry a real upcoming date, action known; for a buy with a target and stop from the message, stop < entry price < target. Failing any check means no order and a console/log line saying it was skipped and why.
- Dedupe: the same message id (and the same contract+action within a configured window) is ordered once.
- Claude CLI latency is accepted by the owner. The regex path stays the fast path. Every Claude call logs its input message and JSON output (`logs/claude-parse.log`) so the prompt/output parser can be fine-tuned over time from real messages.

### Sizing and bracket
- `lots = floor(investment / price / lotSize)`; `investment` and `lotSize` are in `config.json`. 0 lots means skip and log.
- Any lot size written in the message is ignored (owner's decision). The contract is identified from instrument, strike, CE/PE and expiry only; the lot size used for sizing is `lotSize` from config (the order form also shows it as "Lot: 65", which the order module can read and compare with config, logging a mismatch).
- Target and stop: taken from the message when it contains them. When it does not, they come from config as a percent of the entry price or as points (`targetPercent`/`targetPoints`, `stopPercent`/`stopPoints`; if both forms are set for one value, percent wins, my call). Each value is decided separately (a message with only a target uses the config stop). Entry price is used as given in the message.

### Order module (`gopocket/`)
- `buy({contract, price, lots, target, stop})`: place a limit order with bracket on the website; return `{success, quantity, rate, orderId?}` and verify the outcome from the order book/confirmation on the page, not just that a click succeeded.
- `sell({contract})`: find the open position for the contract and sell it. Flow recorded on 2026-11-18 or later.
- One persistent Playwright browser profile directory (gitignored), headless. Login is done once with a headed script (`npm run login`) and the cookies/profile are reused. A session check runs before each order; if the session is invalid, no order is attempted and a clear console error is logged.
- Orders are serialized (one at a time) to avoid two page flows colliding.
- On any unexpected page state (selector missing, error banner, unconfirmed order), save a screenshot and the page HTML to `logs/`, do not retry blindly, and log the failure to the console. An order whose result could not be confirmed is reported as "unknown, check the website", never assumed placed or not placed.

### Project layout
New standalone project `/home/karthikeyan/work/gopocket/` (name: GoPocket), cloned from the WhatsApp bot (parser, whitelist, replyFormatter, logger, config, tests), with `tradingApi.ts` replaced by the order module, a `claudeParser.ts` fallback, a `validate.ts` and a `dedupe.ts`. Its own git repo; WhatsApp auth (`.wwebjs_auth`) and the browser profile are gitignored. The original WhatsApp project is left untouched.

## Order of work
1. Recording session with the owner: login, buy with bracket (market is closed now, so the buy can be recorded up to the confirmation step, or placed on the next open), headless check. Sell on 2026-11-18 or later.
2. Clone and wire the order module; headless buy tested with a small real order the owner approves.
3. Claude fallback parser, guard rails, dedupe, tests.

## Left to the builder
Selectors and exact page steps, Playwright vs Puppeteer details (Playwright preferred; the owner allowed either), logging format, config validation, test layout, the numeric bands for guard rails (to be proposed to the owner).

## Open items for the owner
- Real orders will be placed during testing: the owner decides when and how small.
- Guard-rail bands (strike distance from spot, price range, duplicate window) will be proposed during the plan for the owner to adjust.
