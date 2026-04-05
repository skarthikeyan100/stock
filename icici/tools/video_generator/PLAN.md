# Plan: HTML Table Video Generator

## Context
Create a Python script that takes a markdown/HTML table (specifically the stock analysis Quick Reference table from `tools/docs/formulas.md`) and produces an MP4 video where each row is highlighted on screen while an AI voice narrates an explanation of that row. Output is voiceover-only (no avatar).

---

## Output Files

| File | Purpose |
|---|---|
| `generate_video.py` | Single self-contained Python script |
| `requirements.txt` | pip dependencies |

---

## Dependencies (`requirements.txt`)

```
openai>=1.0.0
moviepy==1.0.3
Pillow>=9.0.0
numpy<2.0
pydub>=0.25.1
```

> Note: `numpy<2.0` pinned because moviepy 1.0.3 has `np.float` deprecation issues with numpy 2.x.
> System ffmpeg is at `/snap/bin/ffmpeg` — script sets `os.environ["FFMPEG_BINARY"]` before importing moviepy.

---

## Script Architecture

### Constants at Top of File (User-Editable)

```python
NARRATION: dict[int, str] = { 0: "...", 1: "...", ... 7: "..." }  # Edit narration here
TTS_MODEL = "tts-1"
TTS_VOICE = "nova"
VIDEO_WIDTH, VIDEO_HEIGHT = 1280, 720
FPS = 24
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
```

### Key Functions

| Function | Responsibility |
|---|---|
| `markdown_to_html(md)` | Convert GFM markdown table → HTML string (stdlib only) |
| `parse_html_table(html)` | Parse HTML → `(headers, rows)` using `html.parser.HTMLParser` |
| `calculate_column_widths(headers, rows, total_width)` | Proportional pixel widths per column |
| `render_table_frame(headers, rows, highlight_index)` | Draw full 1280×720 PIL image; highlighted row in yellow, header in blue |
| `generate_tts_audio(text, path, client)` | Call OpenAI TTS API → save MP3 |
| `get_audio_duration(mp3_path)` | Get duration via pydub (fallback: `ffprobe` subprocess) |
| `generate_video(html, output_path, api_key)` | Orchestrator: parse → TTS → frames → moviepy stitch → MP4 |
| `main()` | argparse: `--html`, `--output`, `--api-key`, `--dry-run` |

### Video Structure

```
For each row i (0..7):
  1. generate_tts_audio(NARRATION[i]) → /tmp/row_i.mp3  (duration = D_i seconds)
  2. render_table_frame(highlight_index=i) → PIL Image
  3. ImageClip(frame).set_duration(D_i)
  4. AudioFileClip(/tmp/row_i.mp3)

concatenate_videoclips([...]) + concatenate_audioclips([...]) → write_videofile(output.mp4)
```

### Frame Layout

```
y=20   Title: "Stock Analysis — Quick Reference"  (bold, blue, size 28)
y=58   Subtitle line (grey, size 14)
y=90   Table start — header row 44px (blue bg, white bold text)
y=134  Data rows, 46px each × 8 rows
       Highlighted row: yellow bg + 4px left accent bar
       Column widths: Section=260px, Method=500px, Formula=400px
       Grid lines between all rows and columns
y=680  Footer: "Row N of 8 | ..."
```

---

## Pre-Defined Narration (8 Rows)

**Row 0 — Standard Pivots:** "Standard Pivot Points use the previous day's High, Low, and Close to compute a central Pivot Point — the average of those three prices. Three resistance levels are derived above and three support levels below. This is the most widely used method because it is fully deterministic: every analyst gets the exact same numbers."

**Row 1 — Fibonacci Pivots:** "Fibonacci Pivot Points apply the ratios 0.382, 0.618, and 1.0 to the previous day's price range. The pivot is calculated identically to standard pivots, but resistance and support distances scale by these Fibonacci ratios. Traders use them because Fibonacci levels tend to act as natural retracement zones in trending markets."

**Row 2 — Camarilla Pivots:** "Camarilla Pivots are derived from the previous day's close and range, scaled by 1.1. They produce eight levels — four above and four below — that get progressively wider. R4 and S4 are the critical levels: a break above R4 signals a strong breakout while a drop below S4 signals a breakdown."

**Row 3 — Swing Highs/Lows:** "Swing Highs and Swing Lows identify local price extremes using five bars on each side. A swing high occurs when a bar's high exceeds all five surrounding bars on both sides. The most recent three swing highs act as resistance and the three most recent swing lows form support. The more a level is tested, the stronger it becomes."

**Row 4 — Price Clusters:** "Price Cluster Zones use the 14-day Average True Range to define bucket sizes — each bucket is half an ATR wide. Every daily High and Low is snapped to its nearest bucket. Buckets with the most touches are the strongest historical zones. The top three by touch count are the key support and resistance areas."

**Row 5 — Weighted Score:** "The Weighted Composite Score measures momentum across multiple timeframes, weighting longer periods more heavily. The one-year return gets a weight of 4, six months gets 3, three months gets 2, and one month gets 1. The one-week return is excluded as noise. A higher score means consistently strong performance where it matters most."

**Row 6 — Rank Score:** "The Rank Score takes a cross-sectional view. For each return period, all stocks are ranked from best to worst — rank 1 for the highest return. Each stock's ranks across all five periods are then averaged. A lower average rank means the stock consistently appeared near the top, which is the definition of persistent momentum."

**Row 7 — 12-1 Momentum:** "The 12-minus-1 Momentum factor comes from the classic Jegadeesh and Titman paper. It is the twelve-month return minus the one-month return. Subtracting the last month removes the short-term reversal effect — stocks that surged recently often retrace briefly. A high score indicates a sustained uptrend without near-term exhaustion."

---

## Usage

```bash
# Install deps
pip install -r requirements.txt

# Dry run (no API key needed — uses 3s silent clips to verify video stitching)
python generate_video.py --dry-run --output /tmp/test_silent.mp4

# Full run
export OPENAI_API_KEY=sk-...
python generate_video.py --output output.mp4

# Custom HTML table
python generate_video.py --html table.html --output output.mp4
```

---

## Verification Steps

1. **Frame test** (no deps): Run `render_table_frame()` for each row index, save as PNG, confirm yellow highlight and blue header render correctly
2. **Dry run**: `--dry-run` generates silent MP4 — confirm 8 segments × 3s = 24s video in VLC/ffplay
3. **TTS test**: Call OpenAI TTS with one sentence to confirm API key works before full run
4. **Full run**: ~90–120s video; verify each row stays highlighted for exactly as long as its narration plays (no desync)

---

## Key Pitfall Mitigations

- Set `os.environ["FFMPEG_BINARY"] = "/snap/bin/ffmpeg"` before importing moviepy (ffmpeg is in `/snap/bin`)
- `numpy<2.0` in requirements to avoid `np.float` deprecation in moviepy 1.0.3
- Font fallback: if DejaVu fonts missing, fall back to `PIL.ImageFont.load_default()`
- Unicode chars (`×`, `±`, `−`) in table cells: DejaVuSans supports them
- API key never hardcoded — read from `OPENAI_API_KEY` env var or `--api-key` flag
