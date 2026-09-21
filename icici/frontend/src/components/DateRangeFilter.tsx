import { Button, ButtonGroup, Form } from 'react-bootstrap';

export type DateRangeMode = 'day' | 'week' | 'month' | 'custom';
export interface DateRange {
  mode: DateRangeMode;
  from: string; // YYYY-MM-DD, local time - always populated regardless of mode
  to: string;
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolves a mode into a concrete from/to pair using local calendar dates
// (not UTC - a UTC day boundary would be wrong for IST users near midnight).
export function resolveDateRange(mode: DateRangeMode, customFrom: string, customTo: string): DateRange {
  const now = new Date();
  if (mode === 'day') {
    const today = toDateInputValue(now);
    return { mode, from: today, to: today };
  }
  if (mode === 'week') {
    // Trading week is Wednesday through Tuesday - mirrors the boundary
    // computed server-side in src/util/weekWindow.ts's startOfWeek(). Kept
    // in sync by construction (frontend/backend are separate TS projects).
    const diff = (now.getDay() - 3 + 7) % 7; // 3 = Wednesday
    const wednesday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    return { mode, from: toDateInputValue(wednesday), to: toDateInputValue(now) };
  }
  if (mode === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { mode, from: toDateInputValue(first), to: toDateInputValue(now) };
  }
  return { mode, from: customFrom, to: customTo };
}

// Human-readable label for the currently-resolved range, e.g. "Showing Aug 1 - 25, 2026".
export function formatRangeLabel(range: DateRange): string {
  if (!range.from || !range.to) return '';
  const fmt = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return range.from === range.to ? `Showing ${fmt(range.from)}` : `Showing ${fmt(range.from)} - ${fmt(range.to)}`;
}

const MODE_LABELS: Record<DateRangeMode, string> = {
  day: 'This Day',
  week: 'This Week',
  month: 'This Month',
  custom: 'Custom',
};

export default function DateRangeFilter({
  value,
  onChange,
  size,
  modes = ['day', 'month', 'custom'],
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  size?: 'sm';
  modes?: DateRangeMode[];
}) {
  const setMode = (mode: DateRangeMode) => {
    onChange(resolveDateRange(mode, value.from, value.to));
  };

  return (
    <div className="d-flex align-items-end gap-2 flex-wrap">
      <ButtonGroup size={size}>
        {modes.map((m) => (
          <Button
            key={m}
            variant={value.mode === m ? 'primary' : 'outline-primary'}
            onClick={() => setMode(m)}
          >
            {MODE_LABELS[m]}
          </Button>
        ))}
      </ButtonGroup>
      {value.mode === 'custom' && (
        <>
          <Form.Group>
            <Form.Label className="small mb-0">From</Form.Label>
            <Form.Control
              size={size}
              type="date"
              value={value.from}
              onChange={(e) => onChange({ mode: 'custom', from: e.target.value, to: value.to })}
            />
          </Form.Group>
          <Form.Group>
            <Form.Label className="small mb-0">To</Form.Label>
            <Form.Control
              size={size}
              type="date"
              value={value.to}
              onChange={(e) => onChange({ mode: 'custom', from: value.from, to: e.target.value })}
            />
          </Form.Group>
        </>
      )}
    </div>
  );
}
