import fs from 'node:fs';
import readline from 'node:readline';

// Minimal CSV line splitter: handles "quoted, fields" and "" escapes.
// None of the backup files contain embedded newlines.
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export async function forEachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (!header) { header = cols; continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i];
    fn(row);
  }
}

// "2026-09-02 09:15:40" -> "2026-09-02 09:15"
