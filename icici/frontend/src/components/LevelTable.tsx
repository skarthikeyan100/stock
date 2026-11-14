import { useEffect, useState } from 'react';
import { Table, Spinner } from 'react-bootstrap';
import { apiFetch } from '../utils/api';

export type Level = 'beginner' | 'advanced';
export interface LevelLimits { daily: number; weekly: number; perTrade: number; capital: number; profitShare: number }
export interface LevelRulesPayload {
  rows: Array<{ label: string; beginner: string; advanced: string }>;
  limits: Record<Level, LevelLimits>;
  termsVersion: string;
}

// One shared request: the comparison table comes from the server (GET /level-rules, no login needed), which reads config.yml, so the numbers
// on the page, in the emails and in the enforced limits can never disagree.
let cached: Promise<LevelRulesPayload> | null = null;
function loadLevelRules(): Promise<LevelRulesPayload> {
  if (!cached) {
    cached = apiFetch('/level-rules')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .catch((e) => { cached = null; throw e; });
  }
  return cached;
}

export function useLevelRules(): { data: LevelRulesPayload | null; failed: boolean } {
  const [data, setData] = useState<LevelRulesPayload | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadLevelRules().then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  return { data, failed };
}

// The Beginner / Advanced comparison table. `highlight` shades the reader's own column; `only` shows one level's column alone.
export default function LevelTable({ highlight, only }: { highlight?: Level; only?: Level }) {
  const { data, failed } = useLevelRules();
  if (failed) return <p className="text-muted small mb-0">The comparison table could not be loaded right now. Please try again in a moment.</p>;
  if (!data) return <div className="text-center py-3"><Spinner animation="border" size="sm" /></div>;
  const show = (l: Level) => !only || only === l;
  const shade = (l: Level) => (highlight === l ? 'table-active' : undefined);
  return (
    <div className="table-responsive">
      <Table size="sm" className="mb-3 align-middle">
        <thead>
          <tr>
            <th />
            {show('beginner') && <th className={shade('beginner')}>Beginner</th>}
            {show('advanced') && <th className={shade('advanced')}>Advanced</th>}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.label}>
              <th scope="row" className="fw-semibold">{r.label}</th>
              {show('beginner') && <td className={shade('beginner')}>{r.beginner}</td>}
              {show('advanced') && <td className={shade('advanced')}>{r.advanced}</td>}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
