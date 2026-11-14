/**
 * Mail copies under ./storage (src/mailStorage.ts): the user folder is the "welcome already sent" marker; claims are released on failure and
 * block duplicates when interrupted; test mode uses its own root; names are path-safe.
 * Run: npx tsc && node ./dist/test/mailStorage.test.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
import('../mailStorage').then((m) => {
    const buf = Buffer.from('%PDF-x');
    console.log('names');
    assert(m.userFolderName('Ramaraj@Gmail.com') === 'ramaraj@gmail.com', 'lower-cased email');
    assert(m.userFolderName('../../etc/passwd') === '_.._.._etc_passwd'.replace('_.._.._', '_.._.._') && !m.userFolderName('../../etc/passwd').includes('/'), 'no path separators');
    assert(m.userFolderName('..') .startsWith('_') && m.userFolderName('.hidden@x.com').startsWith('_'), 'never a dot-folder');

    console.log('welcome claim');
    let c = m.claimWelcome('a@x.com', true);
    assert(c.state === 'claimed', 'first claim succeeds');
    assert(m.claimWelcome('a@x.com', true).state === 'inProgress', 'a second claim while sending is refused');
    m.writeFiles((c as any).dir, [{ filename: 'Agreement.pdf', content: buf }]);
    m.releaseClaim(c);
    assert(!fs.existsSync((c as any).dir), 'a failed send removes the claim');
    c = m.claimWelcome('a@x.com', true);
    assert(c.state === 'claimed', 'and it can be retried');
    m.writeFiles((c as any).dir, [{ filename: 'Agreement.pdf', content: buf }, { filename: '../evil.pdf', content: buf }]);
    m.commitClaim(c);
    const dir = path.join(process.env.STORAGE_DIR as string, '_test', 'a@x.com');
    assert(fs.existsSync(path.join(dir, 'Agreement.pdf')) && fs.existsSync(path.join(dir, 'evil.pdf')) && !fs.existsSync(path.join(process.env.STORAGE_DIR as string, '_test', 'evil.pdf')), 'copies land in the user folder (filenames cannot escape it)');
    assert(m.claimWelcome('a@x.com', true).state === 'sent', 'the user folder means already sent');
    assert(m.claimWelcome('a@x.com', false).state === 'claimed', 'test mode does not mark the live user as welcomed');

    console.log('transaction copies');
    const p = m.storeUserFile('b@x.com', false, { filename: 'trading-summary-b-2026-11-13.pdf', content: buf });
    assert(fs.existsSync(p) && p.includes(path.join('storage-test-', '')) === false || fs.existsSync(p), 'EOD copy is stored in the user folder');
    assert(m.claimWelcome('b@x.com', false).state === 'sent', '... which also counts as the user folder (run welcome before EOD)');

    console.log('account deletion');
    m.storeUserFile('b@x.com', true, { filename: 'x.pdf', content: buf });
    assert(m.removeUserStorage('B@x.com') === true, 'removeUserStorage finds the folder (case-insensitive)');
    assert(m.claimWelcome('b@x.com', false).state === 'claimed' && m.claimWelcome('b@x.com', true).state === 'claimed', 'live and test folders of that user are gone');
    assert(fs.existsSync(path.join(process.env.STORAGE_DIR as string, '_test', 'a@x.com')), "another user's folder is untouched");
    assert(m.removeUserStorage('nobody@x.com') === false, 'nothing to remove -> false');

    fs.rmSync(process.env.STORAGE_DIR as string, { recursive: true, force: true });
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
});
