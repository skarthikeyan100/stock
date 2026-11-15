/**
 * Turns ONE existing user into the portal's test contractor (spec v2.1 section 3: already invited and accepted, flagged is_test so it is not
 * counted against the cap and gets no payouts, statements, invoices or daily email). Dry run by default.
 *
 *   node dist/tools/migrateTestUserToContractor.js --email a@b.com --type INDIVIDUAL            (show what would change)
 *   node dist/tools/migrateTestUserToContractor.js --email a@b.com --type INDIVIDUAL --apply    (do it)
 *   node dist/tools/migrateTestUserToContractor.js --email a@b.com --rollback --apply           (give the user their old role back)
 *
 * The acceptance record is labelled source 'owner-migration' (no IP / user agent: nobody clicked anything). Acceptances are append-only, so a
 * rollback leaves that record and marks the contractor TERMINATED. Mongo is `stocks` on localhost; take a copy first
 * (mongodump --db stocks --collection users). The user's existing cookie keeps working; if it is lost the owner re-invites.
 */
import 'dotenv/config';
import Mongo from './mongo';
import { contractorsCol, newContractor, recordAcceptance } from '../contractors/store';
import { currentVersion, readAgreement } from '../contractors/agreements';
import { ContractorType } from '../contractors/types';

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
    const email = (arg('email') ?? '').toLowerCase();
    const apply = flag('apply');
    if (!email) throw new Error('--email is required');
    await Mongo.init();
    const users = Mongo.getInstance().db.collection('users');
    const user = await users.findOne({ email });
    if (!user) throw new Error(`no user ${email}`);

    if (flag('rollback')) {
        const c: any = await contractorsCol().findOne({ email, isTest: true });
        if (!c) throw new Error('no test contractor for that email');
        console.log(`rollback: ${email} role ${user.role} -> ${c.previousRole ?? 'user'}; contractor ${c.id} -> TERMINATED`);
        if (apply) {
            await users.updateOne({ email }, { $set: { role: c.previousRole ?? 'user' }, $unset: { contractorId: '' } });
            await contractorsCol().updateOne({ id: c.id }, { $set: { status: 'TERMINATED', statusReason: 'test migration rolled back' } });
        }
        return finish(apply);
    }

    const type = (arg('type') ?? '') as ContractorType;
    if (type !== 'INDIVIDUAL' && type !== 'BUSINESS') throw new Error('--type INDIVIDUAL or BUSINESS is required');
    if (user.role === 'admin') throw new Error('refusing to convert an admin account');
    if (user.role === 'contractor' || (await contractorsCol().findOne({ email }))) throw new Error('already a contractor');
    const version = await currentVersion();
    const ag = readAgreement(type, version);
    const c: any = newContractor({ email, name: user.name || email, type, invitedBy: 'owner-migration', isTest: true });
    c.status = 'ACTIVE'; c.agreementVersion = version; c.agreementAcceptedAt = new Date(); c.dpdpConsentAt = new Date(); c.previousRole = user.role;
    console.log(`migrate: ${email} (${user.name}) role ${user.role} -> contractor ${type}, ACTIVE, is_test, agreement v${version} sha ${ag.sha256.slice(0, 12)}…, pseudo user ${c.pseudoUserId}`);
    if (apply) {
        const now = new Date();
        await contractorsCol().insertOne(c);
        await recordAcceptance({ contractorId: c.id, email, agreementType: type, agreementVersion: version, fileSha256: ag.sha256, acceptedAtUtc: now.toISOString(),
            acceptedAtIst: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), ip: '', userAgent: '', source: 'owner-migration', dpdpConsent: true });
        await users.updateOne({ email }, { $set: { role: 'contractor', contractorId: c.id, proficiencyLevel: type === 'INDIVIDUAL' ? 'beginner' : 'advanced', ...(type === 'BUSINESS' ? { advancedVia: 'gstin' } : {}) } });
    }
    finish(apply);
}
function finish(apply: boolean) { console.log(apply ? 'done.' : 'dry run only; add --apply to make the change.'); process.exit(0); }
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
