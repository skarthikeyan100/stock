import { defaultRunner, parseWithClaude } from '../src/claudeParser.js';
const t = 'BUY NIFRY (25400.00 CE) CMP 54:)) STOPLLOSS 41:00 TARGET 68:00-80:00-100:00++(LOT SIZE 65)';
console.log(JSON.stringify(await parseWithClaude(t, defaultRunner())));
console.log(JSON.stringify(await parseWithClaude('Good morning everyone, market looks weak today', defaultRunner())));
