/** Hourly jobs of the contractor portal (started from server.ts). */
import Log from '../util/Log';
import { contractorsCol } from './store';
import { currentVersion } from './agreements';
import { notifyUser } from './notify';

/** When a new agreement version takes effect every contractor on an older one goes to AGREEMENT_PENDING and must accept it (spec section 4). */
export async function runAgreementVersionSwitch(): Promise<number> {
    const version = await currentVersion();
    const stale = (await contractorsCol().find({ status: 'ACTIVE' }).toArray()).filter((c: any) => c.agreementVersion !== version);
    for (const c of stale) {
        const r = await contractorsCol().updateOne({ id: c.id, status: 'ACTIVE' }, { $set: { status: 'AGREEMENT_PENDING', statusReason: `Please accept agreement v${version}` } });
        if (r.matchedCount) await notifyUser(c.email, 'agreement_pending', `A new agreement (v${version}) is in force. Please read and accept it to continue.`);
    }
    if (stale.length) Log.log(`[contractor] ${stale.length} contractor(s) moved to AGREEMENT_PENDING for v${version}`);
    return stale.length;
}
