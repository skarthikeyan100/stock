function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Matches candidate identifiers (sender JID, contact name/pushname, group name) against
 * the whitelist. Name entries are compared case-insensitively; phone-number entries are
 * compared by digits only, so "+91 98765 43210" matches WhatsApp's "919876543210@c.us".
 */
export function isAllowedSender(candidates: Array<string | null | undefined>, allowedSenders: string[]): boolean {
  const allowedNames = allowedSenders.map((sender) => sender.trim().toLowerCase());
  const allowedNumbers = allowedSenders.map(digitsOnly).filter((digits) => digits.length > 0);

  return candidates.some((candidate) => {
    if (!candidate) return false;
    const value = candidate.trim();
    if (allowedNames.includes(value.toLowerCase())) return true;

    const digits = digitsOnly(value);
    return digits.length > 0 && allowedNumbers.includes(digits);
  });
}
