/**
 * Admin "use as another user": the cookie rules in src/routes/session.ts (pure parts, no Mongo).
 * Run: npx tsc, then: node ./dist/test/actAs.test.js
 */
import { actAsCookieValue, parseActAs, resolveUser, resolveActingAdmin, resolveRealUser, sessionCookieValue, ACTAS_MAX_AGE_MS } from '../routes/session';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const req = (signedCookies: Record<string, string>) => ({ signedCookies }) as any;

const session = sessionCookieValue('boss@x.com');
console.log('acting as:');
let r = req({ session, actas: actAsCookieValue('trader@x.com', 'boss@x.com') });
assert(resolveUser(r) === 'trader@x.com', 'effective identity is the target');
assert(resolveActingAdmin(r) === 'boss@x.com', 'acting admin is reported');
assert(resolveRealUser(r) === 'boss@x.com', 'real identity is still the admin');

r = req({ session });
assert(resolveUser(r) === 'boss@x.com' && resolveActingAdmin(r) === null, 'no actas: the admin is themself');

r = req({ session: sessionCookieValue('mallory@x.com'), actas: actAsCookieValue('trader@x.com', 'boss@x.com') });
assert(resolveUser(r) === 'mallory@x.com' && parseActAs(r) === null, 'actas naming a different admin than the session is ignored');

r = req({ actas: actAsCookieValue('trader@x.com', 'boss@x.com') });
assert(parseActAs(r) === null && resolveUser(r) === null, 'actas without a session is ignored');

r = req({ session, actas: actAsCookieValue('boss@x.com', 'boss@x.com') });
assert(parseActAs(r) === null, 'acting as yourself is ignored');

const old = `trader@x.com|boss@x.com|${Date.now() - ACTAS_MAX_AGE_MS - 1000}`;
assert(parseActAs(req({ session, actas: old })) === null, 'an expired actas (over 8 h) is ignored');
assert(parseActAs(req({ session, actas: 'trader@x.com' })) === null, 'a malformed actas is ignored');
assert(parseActAs(req({ session, actas: 'a|b|c|1' })) === null, 'a cookie with extra parts is ignored');
