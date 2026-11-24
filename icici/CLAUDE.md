# ICICI Trading Platform - Project Guide

Documentation index: `docs/README.md`.

## Core Operational Rules
- **Full Permissions:** Linux commands, bash operations, reading/editing any project files run in accept-edits mode with no permission requests needed.
- **Questions Get Answers Only:** If the user asks a question (phrased like "can we...", "how...", "what...", etc.), give **only the answer**. Make no changes, do not write a plan, and do not fix bugs unless explicitly instructed (report bugs in the answer instead). Exception: The trader role fixes bugs immediately.
- **Facts Only:** State only what you have verified from code, logs, config, Mongo, or broker data. No guesses, assumptions, or hallucinations. If unverified, check it or say "I don't know".
- **Do Only What Was Asked:** Do exactly what the prompt asks—nothing extra. Ask before adding unrequested features or config changes.
- **Full Ownership:** Act as project manager, architect, senior developer, and senior tester. Take ownership and resolve any real bugs, gaps, or risks found anywhere in the codebase.
- **Never Skip a Step:** Do not skip verification, required follow-up calls, or checks. Do not defer or shrink tasks without a concrete, checkable blocker. Update all status markers and docs (`ToDo.md`, `REVIEW_FINDINGS.md`, etc.) immediately when work is done.
- **Think Like a Senior Developer:** Think through variations (concurrent instances, partial states, callers) before calling any change done to minimize review findings.
- **Autonomous Decisions:** When given a goal and told the user is unavailable to monitor, make necessary decisions/config changes (e.g., sizing/margin adjustments) to clear concrete blockers instead of stopping to ask.
- **Never Delete `config.yml` Entries:** Only change their values (e.g., `enabled: false`). Do not delete strategy blocks.
- **`enabled: false`:** A disabled strategy takes no action of any kind and is not delivered ticks/fills/cancellations. `reconcile()` restores state from broker positions but skips order-placing paths.
- **No In-Memory-Only Controls:** Do not use in-memory flags or runtime overrides for operator controls without approval. Controls must live in `config.yml` or Mongo.
- **Code Review (On Demand Only):** Do **not** run the `code-review` skill unless explicitly requested. Before any subsequent `code-review` invocation on a task, a commit covering the previous round's fixes **must** already exist.
- **Finishing a Task:** Commit and push once deliverables are complete and verified.
- **Session Efficiency:** Don't re-read a file already read in the same session unless it may have changed. Avoid Claude-in-Chrome unless user approved.
- **Follow Standing Instructions:** Follow behavioral instructions literally until told otherwise. Stay silent on ignored monitor events.

## Architecture & Services
- **Tech Stack:** Node.js / TypeScript options trading platform for ICICI Direct (Prism), Alice Blue (ANT), and Shoonya.
- **Key Processes (`npm run processes`):** 
  - Orchestrator (`src/orchestrator.ts`) spawns and monitors child processes (`data`, `trading`, `frontend`).
  - Trading Process (`src/processes/tradingProcess.ts`): Merged order and strategy execution.
  - ANT: OAuth-only Alice Blue integration (`src/ant/`). Uses its own `axios.create()` instance (do not touch global axios `response.data` unwrapper).
- **Data Persistence:** MongoDB for user profiles, trades, quotes, and audit logs.

## Getting Started & Commands
```bash
npm install
npx tsc  # TypeScript compilation
npm run processes  # Full orchestrator for live trading/broker streaming (use this, not server)
npm run server     # Standalone frontend/API server (UI/API-only work)
```

## Environment (`.env`)
**Required (fails closed if unset):**
- `SESSION_COOKIE_SECRET`
- `GOOGLE_CLIENT_ID`

**Recommended / Defaults:**
- `ADMIN_EMAILS` (Default: `skarthikeyan100@gmail.com`)
- `PORT` (Default: `3000`)
- `CONFIG_PATH` (Default: `./config.yml`)
- `ORDER_IPC_SOCKET`, `STRATEGIES_IPC_SOCKET`, `DATA_IPC_SOCKET`
- `HOT_RESTART`: Set to `'false'` to disable auto-restart; market-hour code changes are blocked unless `HOT_RESTART=true` or `settings.hotRestartDuringMarketHours: true`.

## Key Technical Rules & Gotchas
- **Strategy & Brokers:** Every strategy takes `brokers: [...]` (default `[kite]`). `maxInvestment` is per broker. `prism` is accepted (requires `scripts/login.sh prism`). Global `settings.maxProfit` applies a uniform positive rupee limit.
- **NIFTY BulkPcr:** Modify only `BulkPcrAutoStart-NIFTY`, never `BulkPcr-NIFTY` (which stays `enabled: false`).
- **Levels & Gating:** Beginner/Advanced rules live in `settings.levelRules` (`src/levelRules.ts`). Gating is server-side (`src/levelGate.ts`).
- **Research Portal:** Invite-only portal for Researchers (Individual/PAN) and Research Analysts (Business/GSTIN). Contractors never trade and have restricted endpoints (`src/contractors/guard.ts`).
- **Frontend Hosting:** Hosted on Cloudflare Pages (`nivedhatech.com`). `cloudflare/_worker.js` forwards API/SSE prefixes to origin. Frontend is static pre-built (`cd frontend && npm run build`). Theme selection (`light`/`dark`) is client-side (`localStorage['theme']`).
- **Axios Gotcha:** `src/prism/RestAPI.ts` unwraps `response.data` globally. Any new ANT code making HTTP calls must use `axios.create()`.