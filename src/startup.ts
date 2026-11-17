import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
export function isListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Pid of a running `<script>` started from `projectDir` (Linux /proc): the process's cwd is the project and one of its
 * arguments is exactly the script path. A shell or editor that only mentions the script in a longer string is not a match.
 */
export function findProcess(projectDir: string, script: string, procRoot = '/proc'): number | null {
  const wanted = path.resolve(projectDir);
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(path.join(procRoot, entry, 'cwd'));
      if (path.resolve(cwd) !== wanted) continue;
      const args = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8').split('\0');
      if (args.some((a) => a === script || a.endsWith(`/${script}`))) return Number(entry);
    } catch {
      // the process went away or is not ours to inspect
    }
  }
  return null;
}
