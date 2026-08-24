# ToDo

This file is a snapshot of pending/in-progress work, kept current automatically by a SessionEnd hook (see `.claude/settings.json`). It reflects current state, not a historical log.

- Once the market reopens: verify `AntOrderNotifyStream`'s core assumption before relying on it in place of REST polling - place a small ANT order, compare the `brokerOrderId` returned by `ANT.placeOrder`/`placeBracketOrder` against the `norenordno` reported in the order-notify WS push for the same order, and confirm they're the same value. If they don't match, `waitForFill()` will silently time out on every order (see `src/ant/AntOrderNotifyStream.ts` header comment). Also confirm the heartbeat fix (`{"heartbeat":"h","userId":...}`) actually keeps the connection alive past the ~5-minute mark that the earlier wrong format was dropping at, and confirm the fill-price field is really `flprc` (assumed from the Noren/Shoonya convention, not yet seen in a live ANT push).
