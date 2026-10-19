# Learnings

Mistakes made while working on this project, written down so they are not repeated.

## Monitoring live strategies

- **A mass-close / max-profit / repeated-sell log line is not "handled" until the broker confirms it.** On 2026-10-19 the
  `ContinuousStrategy` max-profit mass close, and repeated `Bare market sell ... qty=130` lines against the same contract,
  were treated as normal strategy behaviour while monitoring. The real problem (sells larger than the held quantity,
  leaving a naked short and untracked longs, see `bugs.md`) was only found when the user pointed at the position. When
  monitoring, at every mass close, every repeated sell/buy on one contract, and every "did not fill within timeout",
  read the broker's real net positions and open orders right away and compare them with the strategy ledger. If they
  disagree, fix or flatten it then, instead of reporting the ledger's P&L. Never conclude a short or an orphan is
  "gone" from an earlier snapshot: re-read positions before saying so.
