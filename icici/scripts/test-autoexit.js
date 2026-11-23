// Preloaded into every test process by scripts/run-all-tests.js (node -r). Many standalone tests finish their assertions and then never
// exit: the ConfigService fs.watch (FSEventWrap) / stat watcher (StatWatcher) the modules they import arm keeps the event loop alive, and
// each such test cost the runner its whole 60 s timeout (about 20-30 of 115 tests). When nothing but those watchers is left for 3
// consecutive seconds the test is over: exit with the test's own exit code (process.exitCode is how these tests report failure).
// A test still waiting on a timer, socket or pending I/O has other active resources and is never cut short.
const WATCHERS_ONLY = new Set(['FSEventWrap', 'StatWatcher']);
// When the runner captures output, fd 1 and fd 2 are pipes and each shows up as a PipeWrap handle: those are stdio, not test work.
const fs = require('fs');
const isFifo = (fd) => { try { const st = fs.fstatSync(fd); return st.isFIFO() || st.isSocket(); } catch { return false; } };
const stdioPipes = [1, 2].filter(isFifo).length;
let idle = 0;
setInterval(() => {
    let skip = stdioPipes;
    const res = process.getActiveResourcesInfo().filter((r) => !(r === 'PipeWrap' && skip-- > 0));
    idle = res.length > 0 && res.every((r) => WATCHERS_ONLY.has(r)) ? idle + 1 : 0;
    if (idle >= 3) process.exit(process.exitCode ?? 0);
}, 1000).unref();
