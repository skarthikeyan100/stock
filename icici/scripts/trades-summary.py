#!/usr/bin/env python3
"""Per-day trades report (HTML): one row per closed buy+sell pair, with buy/sell reasons, the cumulative realized
and unrealized P&L at each exit. One table per strategy per broker (and per round when --reset is used).

Usage:
  node scripts/trades-summary-dump.js 2026-10-28 <dir>
  python3 scripts/trades-summary.py 2026-10-28 <dir> [--out FILE] [--reset "Strategy=HH:MM:SS"]... [--note "text"]...

--reset splits a strategy's rows into rounds at that clock time (rows entered before it are Round 1, the rest
"Retest"). --note adds a bullet under Notes. Reasons come from the fills, leg lineage and, when orchestrator.log is
from the same day, its MAX LOSS / MAX PROFIT TRIPPED lines.

Unrealized (strategy) = mark-to-market of the strategy's OTHER legs still open at that row's exit. No tick history is
stored, so a leg's mark is the latest fill/exit price seen for that contract at or before the exit (entry price if none
yet): an approximation, flagged as such in the report.
"""
import argparse, datetime as dt, html, json, os, re

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument('date')
ap.add_argument('dir')
ap.add_argument('--out')
ap.add_argument('--reset', action='append', default=[])
ap.add_argument('--note', action='append', default=[])
args = ap.parse_args()
DAY = dt.date.fromisoformat(args.date)
out_path = args.out or os.path.join(REPO, f'trades-{args.date}.html')


def load(n): return json.load(open(os.path.join(args.dir, n)))


closed, fills, lineage = load('closed.json'), load('trade.json'), load('lineage.json')


def P(s):  # ISO (UTC) -> naive IST datetime
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(IST).replace(tzinfo=None)


def hms(d): return d.strftime('%H:%M:%S')
def at(hhmmss): return dt.datetime.combine(DAY, dt.time.fromisoformat(hhmmss))


RESETS = {}
for spec in args.reset:
    name, _, t = spec.partition('=')
    RESETS.setdefault(name, []).append(at(t))
for v in RESETS.values(): v.sort()

# --- MAX LOSS / MAX PROFIT trips from orchestrator.log (only when the log is from the report's day) ---
trips = []
logp = os.path.join(REPO, 'orchestrator.log')
if os.path.exists(logp) and dt.datetime.fromtimestamp(os.path.getmtime(logp)).date() == DAY:
    for line in open(logp, errors='replace'):
        m = re.match(r'\[(\d\d:\d\d:\d\d)\].*?\[(\w+Strategy)\].*?MAX (LOSS|PROFIT) TRIPPED - (.*)', line)
        if m:
            d = re.search(r'(\S+P&L=\S+|cumulative=\S+|day P&L=\S+) threshold=(\S+)', m.group(4))
            trips.append((at(m.group(1)), m.group(2), m.group(3).lower(), f'{d.group(1)} vs {d.group(2)}' if d else m.group(4)[:80]))

rows = [dict(strategy=r['user'], broker=r['broker'], tsym=r['tsym'], qty=r['quantity'], entry=P(r['entryTime']),
             exit=P(r['exitTime']), ein=r['entryPrice'], eout=r['exitPrice'], pnl=round(r['realizedPnL'], 2)) for r in closed]
rows.sort(key=lambda x: x['exit'])

tsym_by_ref = {l['legRef']: l['tsym'] for l in lineage}
buys = [dict(user=f['user'], broker=f['broker'], tsym=f['tsym'], qty=f['quantity'], px=f['price'], t=P(f['entryTime']))
        for f in fills if f['action'] == 'Buy']


def buy_fills(row):  # the buy fills that make up this closed quantity, walking back from the exit
    cand = sorted([b for b in buys if b['user'] == row['strategy'] and b['broker'] == row['broker'] and b['tsym'] == row['tsym']
                   and row['entry'] - dt.timedelta(hours=2) <= b['t'] <= row['exit']], key=lambda b: b['t'], reverse=True)
    got, tot = [], 0
    for b in cand:
        if tot >= row['qty']: break
        got.append(b); tot += b['qty']
    return sorted(got, key=lambda b: b['t'])


def is_put(tsym): return bool(re.search(r'PE$|\dP\d+$', tsym))


def overlaps(row):  # another row of the same strategy+contract held at the same time
    return any(o is not row and o['strategy'] == row['strategy'] and o['tsym'] == row['tsym'] and o['broker'] == row['broker']
               and o['entry'] < row['exit'] and row['entry'] < o['exit'] for o in rows)


def trip_for(row):
    tag = 'ContinuousStrategy' if row['strategy'].startswith('Continuous') else 'BulkPcrStrategy' if row['strategy'].startswith('BulkPcr') else None
    c = [t for t in trips if t[1] == tag and row['exit'] - dt.timedelta(seconds=120) <= t[0] <= row['exit'] + dt.timedelta(seconds=2)]
    return min(c, key=lambda t: abs((t[0] - row['exit']).total_seconds())) if c else None


def forced_cluster(row):  # >=2 losing exits of this strategy within 90s: a close-all, not a per-leg stop
    return sum(1 for o in rows if o['strategy'] == row['strategy'] and o['pnl'] < 0 and abs((o['exit'] - row['exit']).total_seconds()) <= 90) >= 2


def buy_reason(row, prev_same, fl):
    ent = fl[0]['t'] if fl else row['entry']
    first_px = fl[0]['px'] if fl else row['ein']
    if row['strategy'].startswith('BulkPcr'):
        r = f"{row['entry'].strftime('%H:%M')} slot entry ({'put' if is_put(row['tsym']) else 'call'} leg, opposite-side pair)"
        return r + (f"; {len(fl)} buy fills blended" if len(fl) > 1 else '')
    if not row['strategy'].startswith('Continuous'):
        return 'Entry'
    if overlaps(row):
        return 'Possible duplicate refill: another leg held this contract at the same time'
    if prev_same and prev_same[-1]['exit'] <= ent and abs(prev_same[-1]['first_px'] - first_px) < 0.011:
        r = f'Refill: resting limit buy at the previous entry price {first_px:.2f} after the earlier leg hit target'
    else:
        r = None
        for l in sorted([l for l in lineage if l['tsym'] == row['tsym'] and ent - dt.timedelta(seconds=20) <= P(l['createdAt']) <= row['exit']], key=lambda l: l['isRoot']):
            if not l['isRoot']:
                r = f"Hedge spawn Level {l['parentLevel']} under {tsym_by_ref.get(l.get('parentLegRef'), 'a parent leg')} (parent moved adverse by the level step)"
                break
        r = r or 'Root entry: ContinuousStrategy entry gate'
    if len(fl) > 1:
        r += '; plus average adds: ' + ', '.join(f"{b['qty']} @ {b['px']:.2f} ({hms(b['t'])})" for b in fl[1:])
    return r


def sell_reason(row):
    pts = row['eout'] - row['ein']
    if row['pnl'] >= 0:
        if row['strategy'].startswith('BulkPcr'): return f'Resting limit sell filled at target ({pts:+.0f} points)'
        return 'Target hit: self-monitored price target (limit/market sell)'
    t = trip_for(row)
    if t: return f"Max-{t[2]} stop ({t[3]}): all legs closed at market"
    if forced_cluster(row): return 'Forced close-all with other legs (likely a max-loss stop; no log line found for it)'
    return 'Stop-loss / forced exit'


prev = {}
for r in rows:
    key = (r['strategy'], r['tsym'], r['broker'])
    prev.setdefault(key, [])
    fl = buy_fills(r)
    r['buy_t'] = fl[0]['t'] if fl else r['entry']
    r['first_px'] = fl[0]['px'] if fl else r['ein']
    r['buy_reason'] = buy_reason(r, prev[key], fl)
    r['sell_reason'] = sell_reason(r)
    prev[key].append(r)

# --- price evidence per contract for the unrealized mark ---
evidence = {}
for f in fills:
    if f.get('status') == 'COMPLETE' and f.get('price'):
        evidence.setdefault(f['tsym'], []).append((P(f['entryTime']), f['price']))
for r in rows:
    evidence.setdefault(r['tsym'], []).extend([(r['buy_t'], r['ein']), (r['exit'], r['eout'])])
for v in evidence.values(): v.sort()


def mark(tsym, since, t, fallback):
    px = fallback
    for et, p in evidence.get(tsym, []):
        if et > t: break
        if et >= since: px = p
    return px


def unrealized_at(row):
    t = row['exit']
    return round(sum((mark(o['tsym'], o['buy_t'], t, o['ein']) - o['ein']) * o['qty'] for o in rows
                     if o is not row and o['strategy'] == row['strategy'] and o['broker'] == row['broker'] and o['buy_t'] <= t < o['exit']), 2)


run_s = {}
for r in rows:
    k = (r['strategy'], r['broker'])
    run_s[k] = run_s.get(k, 0.0) + r['pnl']
    r['run_s'] = round(run_s[k], 2)
    r['unreal'] = unrealized_at(r)


def fmt(x): return f'{x:,.2f}'
def cls(x): return 'pos' if x > 0 else ('neg' if x < 0 else '')
def num(x): return f"<td class='n {cls(x)}'>{fmt(x)}</td>"


def table(rs):
    out = ['<div class="scroll"><table><thead><tr><th>#</th><th>Strategy</th><th>Broker</th><th>Contract</th><th class="n">Qty</th>'
           '<th>Buy time</th><th class="n">Buy price</th><th>Reason for buy</th><th>Sell time</th><th class="n">Sell price</th>'
           '<th>Reason for sell</th><th class="n">P&amp;L</th><th class="n">Realized (cumulative)</th>'
           '<th class="n">Unrealized</th></tr></thead><tbody>']
    for i, r in enumerate(rs, 1):
        out.append(
            f"<tr><td>{i}</td><td>{html.escape(r['strategy'])}</td><td>{r['broker']}</td><td>{html.escape(r['tsym'])}</td><td class='n'>{r['qty']}</td>"
            f"<td>{hms(r['buy_t'])}</td><td class='n'>{r['ein']:.2f}</td><td>{html.escape(r['buy_reason'])}</td>"
            f"<td>{hms(r['exit'])}</td><td class='n'>{r['eout']:.2f}</td><td>{html.escape(r['sell_reason'])}</td>"
            f"{num(r['pnl'])}{num(r['run_s'])}{num(r['unreal'])}</tr>")
    sub = round(sum(x['pnl'] for x in rs), 2)
    out.append(f"<tr class='sub'><td colspan='11'>Subtotal ({len(rs)} trades)</td>{num(sub)}<td colspan='2'></td></tr>")
    out.append('</tbody></table></div>')
    return '\n'.join(out), sub


def rounds(strat, srows):
    cuts = RESETS.get(strat, [])
    groups = [[r for r in srows if (i == 0 or r['entry'] >= cuts[i - 1]) and (i == len(cuts) or r['entry'] < cuts[i])] for i in range(len(cuts) + 1)]
    titles = ['Round 1'] + [f"Retest{'' if len(cuts) == 1 else ' ' + str(i)}: after the reset at {hms(cuts[i - 1])}" for i in range(1, len(cuts) + 1)]
    return [(t, g) for t, g in zip(titles, groups) if g]


sections, summary = [], []
for strat in sorted({r['strategy'] for r in rows}):
    sections.append(f'<h2>{html.escape(strat)}</h2>')
    for broker in sorted({r['broker'] for r in rows if r['strategy'] == strat}):
        for title, rs in rounds(strat, [r for r in rows if r['strategy'] == strat and r['broker'] == broker]):
            label = f'{broker} · {title}'
            t, sub = table(sorted(rs, key=lambda x: x['exit']))
            sections.append(f'<h3>{html.escape(label)}</h3>\n{t}')
            summary.append((strat, label, len(rs), sub))

grand = round(sum(s[3] for s in summary), 2)
assert abs(grand - round(sum(r['pnl'] for r in rows), 2)) < 0.01
sumrows = ''.join(f"<tr><td>{html.escape(a)}</td><td>{html.escape(b)}</td><td class='n'>{c}</td>{num(d)}</tr>" for a, b, c, d in summary)
by = {}
for a, b, c, d in summary: by[a] = round(by.get(a, 0) + d, 2)
byrows = ''.join(f"<tr class='sub'><td colspan='2'>{html.escape(k)} total</td><td class='n'>{sum(1 for r in rows if r['strategy'] == k)}</td>{num(v)}</tr>" for k, v in by.items())
notes = ['Reasons for buy and sell are derived from the fills, the leg lineage and, where the orchestrator log is from the same day, its MAX LOSS / MAX PROFIT TRIPPED lines.',
         'Unrealized is the mark-to-market of the same strategy and broker\'s other legs still open at that row\'s exit. No tick history is stored, so each open leg is marked at the latest fill or exit price seen for its contract (its entry price if none yet): an approximation, not an exact tick-time figure.'] + args.note
notes_html = ''.join(f'<li>{html.escape(n)}</li>' for n in notes)

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trades {args.date}</title>
<style>
:root{{--bg:#ffffff;--fg:#1c2330;--muted:#5d6878;--line:#d9dee7;--head:#eef1f6;--pos:#0a7d3c;--neg:#c0262d;--sub:#f6f8fb}}
@media (prefers-color-scheme: dark){{:root{{--bg:#12161d;--fg:#e4e8ef;--muted:#9aa5b5;--line:#2c3441;--head:#1b212b;--pos:#4cc47f;--neg:#ff6b72;--sub:#171c25}}}}
body{{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
h1{{margin:0 0 4px;font-size:22px}} h2{{margin:32px 0 4px;font-size:18px}} h3{{margin:20px 0 8px;font-size:15px;color:var(--muted);font-weight:600}}
p.meta{{margin:0 0 8px;color:var(--muted)}}
.scroll{{overflow-x:auto;border:1px solid var(--line);border-radius:8px}}
table{{border-collapse:collapse;width:100%;min-width:1600px}}
th,td{{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}}
th{{background:var(--head);position:sticky;top:0;font-weight:600;white-space:nowrap}}
td.n,th.n{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.pos{{color:var(--pos)}} .neg{{color:var(--neg)}}
tr.sub td{{background:var(--sub);font-weight:600}}
table.sum{{min-width:0;max-width:760px}} .grand td{{font-size:16px;font-weight:700;background:var(--head)}}
ul.notes{{color:var(--muted);max-width:900px}}
</style></head><body>
<h1>Trades, {args.date}</h1>
<p class="meta">One row per closed buy+sell pair ({len(rows)} trades). P&amp;L is gross of brokerage and taxes. Realized is the cumulative realized P&amp;L of that table's strategy and broker after that exit, in exit-time order.</p>
{''.join(sections)}
<h2>Totals (sum of P&amp;L)</h2>
<table class="sum"><thead><tr><th>Strategy</th><th>Broker · round</th><th class="n">Trades</th><th class="n">P&amp;L</th></tr></thead><tbody>
{sumrows}{byrows}
<tr class="grand"><td colspan="2">Grand total</td><td class="n">{len(rows)}</td>{num(grand)}</tr></tbody></table>
<h3>Notes</h3>
<ul class="notes">{notes_html}</ul>
</body></html>
"""
open(out_path, 'w').write(page)
print(out_path, len(rows), 'rows, grand', fmt(grand))
