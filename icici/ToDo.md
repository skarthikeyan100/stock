# ToDo

This file is a snapshot of pending/in-progress work, kept current automatically by a SessionEnd hook (see `.claude/settings.json`). It reflects current state, not a historical log.

- Run `npm run sr:hypothesis -- --date <date>` once the external Data project has populated a full day's NIFTY ticks in the Mongo `Quote` collection, and review the console report (range count, avg width/hold duration, breach counts) to validate the dynamic support/resistance hypothesis in `src/lib/supportResistance.ts`.
- If the hypothesis holds, wire `src/lib/supportResistance.ts` into the live `SupportResistanceStrategy` (`src/strategy/SupportResistanceStrategy.ts`) in place of the static `config.supportPrice`/`config.resistancePrice` - not started yet.
- Tomorrow: run `SupportResistanceStrategy` live with fixed support/resistance values (set non-zero `supportPrice`/`resistancePrice` and `enabled: true` in `config.yml`) to confirm the new per-option-type open-position guard behaves as expected (CE/PE trades independent and can run in parallel, no duplicate same-side entries while one is open).
