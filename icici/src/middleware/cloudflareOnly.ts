import express from 'express';
import ipaddr from 'ipaddr.js';
import SecurityLog from '../util/SecurityLog';

// Cloudflare's published edge IP ranges (https://www.cloudflare.com/ips-v4,
// https://www.cloudflare.com/ips-v6) as of 2026-09-03. Refresh periodically -
// Cloudflare occasionally adds/changes ranges.
const CLOUDFLARE_CIDRS = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
].map((cidr) => ipaddr.parseCIDR(cidr));

// Shared with the app-level auth middleware (requireAuth/requireAdmin/
// requireSelfOrAdmin in server.ts) - per the user's direct instruction
// ("localhost need not have any security"), loopback requests bypass auth
// entirely there too. Safe because Cloudflare connects directly to this
// server's public IP (no local tunnel daemon is involved anywhere in this
// deployment) - req.socket.remoteAddress === 127.0.0.1 can only mean a
// process on this same machine, never disguised internet traffic proxied
// through Cloudflare.
export function isLoopback(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false;
    try {
        return ipaddr.process(remoteAddress).range() === 'loopback'; // normalizes ::ffff:-mapped IPv4
    } catch {
        return false;
    }
}

function isAllowed(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false;
    if (isLoopback(remoteAddress)) return true;
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
        addr = ipaddr.process(remoteAddress); // normalizes ::ffff:-mapped IPv4
    } catch {
        return false;
    }
    return CLOUDFLARE_CIDRS.some(([rangeAddr, bits]) => {
        if (rangeAddr.kind() !== addr.kind()) return false;
        return addr.match(rangeAddr, bits);
    });
}

export function cloudflareOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
    const remoteAddress = req.socket.remoteAddress;
    if (isAllowed(remoteAddress)) {
        next();
        return;
    }
    SecurityLog.log('BLOCKED_IP', { ip: remoteAddress, method: req.method, path: req.originalUrl });
    res.status(403).end();
}
