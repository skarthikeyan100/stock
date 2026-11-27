// Order error text as the viewer may see it: only admins are told which broker an order went to.
// Import this from the trading page's components only: it spells broker names, which the bundle contractors load must not.

const KEY = '(?:ant|kite|breeze|prism)'; // as the server writes a broker in "<broker>: reason"
const NAME = "(?:ANT|Alice\\s?Blue|Kite|Zerodha|Breeze|ICICI(?: Direct)?|Prism|Shoonya)\\b"; // as a reason spells it
const NO_SESSION = 'trading is not available right now - please contact support';

function hideBrokers(text: string): string {
  const plain = text
    .replace(/^Not placed on /, 'Not placed: ')
    .replace(new RegExp(`(^|Not placed: |; )${KEY}: `, 'g'), '$1')
    .replace(new RegExp(`\\b${NAME} session not active[^;]*`, 'g'), NO_SESSION) // its login instruction is for whoever runs the platform
    .replace(new RegExp(` \\(${KEY}\\)`, 'g'), '')
    .replace(new RegExp(` on ${KEY}\\b`, 'g'), '')
    .replace(new RegExp(`\\b(at|by|with) ${NAME}`, 'g'), '$1 the broker')
    .replace(new RegExp(`\\ban ${NAME}`, 'g'), 'a broker')
    .replace(new RegExp(`\\b${NAME}`, 'g'), 'broker');
  if (plain === text) return text;
  // The same reason from two brokers is said once.
  const head = plain.startsWith('Not placed: ') ? 'Not placed: ' : '';
  const out = head + [...new Set(plain.slice(head.length).split('; '))].join('; ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export const orderErrorText = (text: string, isAdmin: boolean): string => (isAdmin ? text : hideBrokers(text));
