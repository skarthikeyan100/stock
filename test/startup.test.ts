import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProcess, isListening } from '../src/startup.js';

const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('isListening', () => {
  it('is true for a port something listens on and false for a free one', async () => {
    const s = net.createServer().listen(0, '127.0.0.1');
    servers.push(s);
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as net.AddressInfo).port;
    expect(await isListening(port)).toBe(true);
    await new Promise((r) => s.close(r));
    expect(await isListening(port)).toBe(false);
  });
});

describe('findProcess', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  const add = (pid: number, cwd: string, ...args: string[]) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), args.join('\0') + '\0');
    fs.symlinkSync(cwd, path.join(proc, String(pid), 'cwd'));
  };
  add(100, '/home/u/work/whatsapp', 'node', '/home/u/work/whatsapp/node_modules/.bin/tsx', 'src/index.ts');
  add(200, '/home/u/work/gopocket', 'node', 'tsx', 'src/index.ts');
  add(300, '/home/u/work/whatsapp', 'bash', '-c', 'vim src/index.ts.bak');
  fs.mkdirSync(path.join(proc, 'self'));

  it('finds the process whose cwd is the project and whose command runs the script', () => {
    expect(findProcess('/home/u/work/whatsapp', 'src/index.ts', proc)).toBe(100);
    expect(findProcess('/home/u/work/gopocket', 'src/index.ts', proc)).toBe(200);
  });
  it('returns null when nothing matches (other project, other script, or not running)', () => {
    expect(findProcess('/home/u/work/other', 'src/index.ts', proc)).toBeNull();
    expect(findProcess('/home/u/work/whatsapp', 'src/other.ts', proc)).toBeNull();
  });
  it('does not match an editor or shell that merely mentions the script', () => {
    fs.rmSync(path.join(proc, '100'), { recursive: true });
    expect(findProcess('/home/u/work/whatsapp', 'src/index.ts', proc)).toBeNull();
  });
});
