/**
 * Copies of the PDFs we email, kept on this machine under ./storage/<user>/ (override the root with STORAGE_DIR; git-ignored: customer documents).
 *
 *   storage/<user>/Agreement.pdf, Terms-and-Conditions.pdf, Privacy-Policy.pdf      the welcome email (sent once)
 *   storage/<user>/trading-summary-<user>-<date>.pdf                                   one per end-of-day email
 *
 * THE USER FOLDER IS THE "WELCOME ALREADY SENT" MARKER: while it exists the welcome email is not sent again (delete the folder to resend).
 * A welcome send first claims `<user>.sending`, sends, then renames it to `<user>`; a failed send removes the claim, so a retry is possible, and a
 * crash mid-send leaves `<user>.sending`, which blocks a duplicate until someone looks. While settings.eodEmailTestRecipient is set (test mode)
 * everything goes under storage/_test/ instead, so testing never marks a real user as welcomed. <user> is the lower-cased email, made path-safe.
 * Because an end-of-day copy also creates the user folder, run the welcome step BEFORE the EOD email step for a user's first day.
 */
import * as fs from 'fs';
import * as path from 'path';
import { normalizeEmail } from './user';

export function storageRoot(test: boolean): string {
    const base = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage'));
    return test ? path.join(base, '_test') : base;
}

export function userFolderName(email: string): string {
    const safe = normalizeEmail(email).replace(/[^a-z0-9._@+-]/g, '_');
    return safe.startsWith('.') || safe === '' ? `_${safe}` : safe;
}

export interface StoredFile { filename: string; content: Buffer }

export type WelcomeClaim = { state: 'claimed'; dir: string; finalDir: string } | { state: 'sent' | 'inProgress'; dir: string };

/** Claims the right to send this user's welcome email. 'sent' = the user folder exists; 'inProgress' = a `.sending` claim is left over. */
export function claimWelcome(email: string, test: boolean): WelcomeClaim {
    const root = storageRoot(test);
    const finalDir = path.join(root, userFolderName(email));
    const claimDir = `${finalDir}.sending`;
    if (fs.existsSync(finalDir)) return { state: 'sent', dir: finalDir };
    fs.mkdirSync(root, { recursive: true });
    try { fs.mkdirSync(claimDir); } catch (e: any) { if (e?.code === 'EEXIST') return { state: 'inProgress', dir: claimDir }; throw e; }
    return { state: 'claimed', dir: claimDir, finalDir };
}

/**
 * Claims the right to send this user's upgrade (Advanced) email, once. Kept in a SIBLING folder `<user>.upgrade` (claimed as `<user>.upgrade.sending`),
 * never inside the user folder: creating that folder would mark the welcome email as sent. Same states and commit/release as claimWelcome.
 */
export function claimUpgrade(email: string, test: boolean): WelcomeClaim {
    const root = storageRoot(test);
    const finalDir = path.join(root, `${userFolderName(email)}.upgrade`);
    const claimDir = `${finalDir}.sending`;
    if (fs.existsSync(finalDir)) return { state: 'sent', dir: finalDir };
    fs.mkdirSync(root, { recursive: true });
    try { fs.mkdirSync(claimDir); } catch (e: any) { if (e?.code === 'EEXIST') return { state: 'inProgress', dir: claimDir }; throw e; }
    return { state: 'claimed', dir: claimDir, finalDir };
}

export function writeFiles(dir: string, files: StoredFile[]): void {
    for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f.filename)), f.content, { mode: 0o600 });
}

export function releaseClaim(claim: WelcomeClaim): void {
    if (claim.state === 'claimed') fs.rmSync(claim.dir, { recursive: true, force: true });
}

/** The email went out: the claim becomes the user folder (this is what marks the welcome as sent). */
export function commitClaim(claim: WelcomeClaim): void {
    if (claim.state === 'claimed') fs.renameSync(claim.dir, claim.finalDir);
}

/** Saves one emailed PDF into the user's folder (created if missing). Returns the stored path. */
export function storeUserFile(email: string, test: boolean, file: StoredFile): string {
    const dir = path.join(storageRoot(test), userFolderName(email));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(file.filename));
    fs.writeFileSync(target, file.content, { mode: 0o600 });
    return target;
}

/** Deletes everything stored for this user (live and test folders, and a leftover `.sending` claim). Returns true if anything was removed. */
export function removeUserStorage(email: string): boolean {
    let removed = false;
    for (const test of [false, true]) {
        const dir = path.join(storageRoot(test), userFolderName(email));
        for (const d of [dir, `${dir}.sending`, `${dir}.upgrade`, `${dir}.upgrade.sending`]) {
            if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); removed = true; }
        }
    }
    return removed;
}
