/** Contractor session cookie: `email|issuedAtMs|days` (parsed in src/routes/session.ts), with its own lifetime, re-issued (rotated) at most once a day. */
import express from 'express';
import { ContractorType } from './types';
import { sessionDaysFor } from './store';

export const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;

export function contractorCookieValue(email: string, type: ContractorType, now = Date.now()): string { return `${email}|${now}|${sessionDaysFor(type)}`; }

export function setContractorCookie(res: express.Response, email: string, type: ContractorType): void {
    const days = sessionDaysFor(type);
    res.cookie('session', contractorCookieValue(email, type), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: days * 24 * 60 * 60 * 1000 });
    res.clearCookie('actas');
}

/** True when the cookie is old enough to be re-issued with a fresh issue time (sliding expiry and rotation). */
export function shouldRotate(issuedAt: number, now = Date.now()): boolean { return now - issuedAt >= ROTATE_AFTER_MS; }
