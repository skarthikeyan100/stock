"""
generate_video.py — HTML Table Explainer Video Generator

Produces an MP4 where each table row is highlighted on screen while an AI
voice (OpenAI TTS) narrates the explanation for that row.

Usage:
  python generate_video.py [--html <file>] [--output <path>] [--api-key <key>] [--dry-run]

Defaults:
  --html     uses the built-in SAMPLE_MARKDOWN (stock analysis Quick Reference table)
  --output   ./output.mp4
  --api-key  reads from OPENAI_API_KEY environment variable
  --dry-run  skips TTS, uses 3s silent clips — good for testing layout
"""

import os
import sys
import argparse
import tempfile
import subprocess
import shutil
from html.parser import HTMLParser

# ── ffmpeg path (must be set before importing moviepy) ────────────────────────
if not shutil.which("ffmpeg"):
    os.environ.setdefault("FFMPEG_BINARY", "/snap/bin/ffmpeg")

# ── Narration Script ──────────────────────────────────────────────────────────
# Edit the text for each row here. Keys are 0-based row indices.
NARRATION: dict = {
    0: (
        "Standard Pivot Points use the previous day's High, Low, and Close to compute "
        "a central Pivot Point — the average of those three prices. "
        "Three resistance levels are derived above and three support levels below. "
        "This is the most widely used method because it is fully deterministic: "
        "every analyst calculating from the same data gets the exact same numbers."
    ),
    1: (
        "Fibonacci Pivot Points apply the ratios 0.382, 0.618, and 1.0 to the "
        "previous day's price range. The pivot is calculated identically to standard "
        "pivots, but the resistance and support distances scale by these Fibonacci "
        "ratios. Traders use them because Fibonacci levels tend to act as natural "
        "retracement zones in trending markets."
    ),
    2: (
        "Camarilla Pivots are derived from the previous day's close and range, "
        "scaled by the constant 1.1. They produce eight levels — four above and "
        "four below — that get progressively wider. R4 and S4 are the critical "
        "levels: a break above R4 signals a strong breakout, while a drop below "
        "S4 signals a breakdown."
    ),
    3: (
        "Swing Highs and Swing Lows identify local price extremes using five bars "
        "on each side. A swing high occurs when a bar's high exceeds all five "
        "surrounding bars on both sides. The most recent three swing highs act as "
        "resistance, and the three most recent swing lows form support. "
        "The more a level is tested, the stronger it becomes."
    ),
    4: (
        "Price Cluster Zones use the 14-day Average True Range to define bucket "
        "sizes — each bucket is half an ATR wide. Every daily High and Low is "
        "snapped to its nearest bucket. Buckets with the most touches are the "
        "strongest historical zones. The top three by touch count are the key "
        "support and resistance areas."
    ),
    5: (
        "The Weighted Composite Score measures momentum across multiple timeframes, "
        "weighting longer periods more heavily. The one-year return gets a weight "
        "of 4, six months gets 3, three months gets 2, and one month gets 1. "
        "The one-week return is excluded as noise. A higher score means consistently "
        "strong performance where it matters most."
    ),
    6: (
        "The Rank Score takes a cross-sectional view. For each return period, all "
        "stocks are ranked from best to worst — rank 1 for the highest return. "
        "Each stock's ranks across all five periods are then averaged. A lower "
        "average rank means the stock consistently appeared near the top, which "
        "is the definition of persistent momentum."
    ),
    7: (
        "The 12-minus-1 Momentum factor comes from the classic Jegadeesh and Titman "
        "paper. It is the twelve-month return minus the one-month return. Subtracting "
        "the last month removes the short-term reversal effect — stocks that surged "
        "recently often retrace briefly. A high score indicates a sustained uptrend "
        "without near-term exhaustion."
    ),
}

# ── Visual Settings ────────────────────────────────────────────────────────────
VIDEO_WIDTH  = 1280
VIDEO_HEIGHT = 720
FPS          = 24
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# ── OpenAI TTS Settings ────────────────────────────────────────────────────────
TTS_MODEL = "tts-1"
TTS_VOICE = "nova"

# ── Color Palette ──────────────────────────────────────────────────────────────
COLOR_BG        = (255, 255, 255)
COLOR_HEADER_BG = (30,  80, 160)
COLOR_HEADER_FG = (255, 255, 255)
COLOR_ROW_ALT   = (245, 247, 250)
COLOR_ROW_NORM  = (255, 255, 255)
COLOR_HIGHLIGHT = (255, 251, 180)
COLOR_ACCENT    = (30,  80, 160)
COLOR_GRID      = (200, 210, 220)
COLOR_TEXT      = (30,  30,  30)
COLOR_TITLE     = (30,  80, 160)
COLOR_SUBTITLE  = (100, 100, 100)
COLOR_FOOTER    = (160, 160, 160)

# ── Sample Table (built-in default) ───────────────────────────────────────────
SAMPLE_MARKDOWN = """\
| Section | Method | Formula |
|---|---|---|
| Standard Pivots | PP = (H+L+C)/3, R1/R2/R3, S1/S2/S3 | Deterministic, most widely used |
| Fibonacci Pivots | PP +/- 0.382/0.618/1.0 x (H-L) | Fib ratios applied to range |
| Camarilla Pivots | C +/- 1.1x(H-L)/12..2 | R4/S4 = key breakout levels |
| Swing Highs/Lows | 5-bar local extremes | Last 3 swing H + 3 swing L |
| Price Clusters | ATR-bucketed touch count | Top 3 most-tested price zones |
| Weighted Score | (1Yx4 + 6Mx3 + 3Mx2 + 1Mx1) / 10 | Longer periods weighted higher |
| Rank Score | Average rank across all 5 periods | Lower = stronger momentum |
| 12-1 Momentum | 1Y return - 1M return | Classic Jegadeesh-Titman factor |
"""


# ─────────────────────────────────────────────────────────────────────────────
# Parsing helpers
# ─────────────────────────────────────────────────────────────────────────────

def markdown_to_html(md: str) -> str:
    """Convert a GitHub-flavored markdown table to a minimal HTML table string."""
    lines = [ln.strip() for ln in md.strip().splitlines() if ln.strip()]
    # Remove separator line (contains only |, -, and spaces)
    lines = [ln for ln in lines if not all(c in "|-: " for c in ln)]

    def parse_row(line: str) -> list:
        cells = line.split("|")
        # Strip leading/trailing empty cells from outer pipes
        if cells and cells[0].strip() == "":
            cells = cells[1:]
        if cells and cells[-1].strip() == "":
            cells = cells[:-1]
        return [c.strip() for c in cells]

    if not lines:
        return "<table></table>"

    header_cells = parse_row(lines[0])
    thead = "<tr>" + "".join(f"<th>{c}</th>" for c in header_cells) + "</tr>"
    tbody_rows = ""
    for line in lines[1:]:
        row_cells = parse_row(line)
        tbody_rows += "<tr>" + "".join(f"<td>{c}</td>" for c in row_cells) + "</tr>"

    return f"<table><thead>{thead}</thead><tbody>{tbody_rows}</tbody></table>"


class _TableParser(HTMLParser):
    """Extract headers and rows from an HTML table."""

    def __init__(self):
        super().__init__()
        self.headers: list = []
        self.rows: list = []
        self._current_row: list = []
        self._current_cell: str = ""
        self._in_cell: bool = False
        self._in_header: bool = False

    def handle_starttag(self, tag, attrs):
        if tag in ("th", "td"):
            self._in_cell = True
            self._in_header = (tag == "th")
            self._current_cell = ""

    def handle_endtag(self, tag):
        if tag in ("th", "td"):
            self._in_cell = False
            self._current_row.append(self._current_cell.strip())
        elif tag == "tr":
            if self._current_row:
                if self._in_header or (not self.headers and not self.rows):
                    self.headers = self._current_row[:]
                else:
                    self.rows.append(self._current_row[:])
            self._current_row = []

    def handle_data(self, data):
        if self._in_cell:
            self._current_cell += data


def parse_html_table(html: str):
    """Return (headers, rows) from an HTML table string."""
    parser = _TableParser()
    parser.feed(html)
    return parser.headers, parser.rows


# ─────────────────────────────────────────────────────────────────────────────
# Frame rendering
# ─────────────────────────────────────────────────────────────────────────────

def _load_font(path: str, size: int):
    from PIL import ImageFont
    try:
        return ImageFont.truetype(path, size)
    except (IOError, OSError):
        return ImageFont.load_default()


def _truncate_text(draw, text: str, font, max_width: int, padding: int = 10) -> str:
    from PIL import ImageDraw  # noqa — just for type hint context
    available = max_width - 2 * padding
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
    except AttributeError:
        text_w, _ = draw.textsize(text, font=font)
    if text_w <= available:
        return text
    while len(text) > 3:
        text = text[:-1]
        candidate = text + "..."
        try:
            bbox = draw.textbbox((0, 0), candidate, font=font)
            w = bbox[2] - bbox[0]
        except AttributeError:
            w, _ = draw.textsize(candidate, font=font)
        if w <= available:
            return candidate
    return "..."


def _draw_text_centered(draw, x: int, y: int, w: int, h: int, text: str, font, color):
    """Draw text centered within a rectangle (x, y, x+w, y+h)."""
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except AttributeError:
        tw, th = draw.textsize(text, font=font)
    tx = x + (w - tw) // 2
    ty = y + (h - th) // 2
    draw.text((tx, ty), text, font=font, fill=color)


def render_table_frame(headers: list, rows: list, highlight_index: int):
    """Render a 1280x720 PIL Image with the table drawn and one row highlighted."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (VIDEO_WIDTH, VIDEO_HEIGHT), COLOR_BG)
    draw = ImageDraw.Draw(img)

    font_title    = _load_font(FONT_BOLD,    28)
    font_subtitle = _load_font(FONT_REGULAR, 14)
    font_header   = _load_font(FONT_BOLD,    17)
    font_cell     = _load_font(FONT_REGULAR, 14)
    font_footer   = _load_font(FONT_REGULAR, 12)

    # Title
    draw.text((60, 20), "Stock Analysis \u2014 Quick Reference", font=font_title, fill=COLOR_TITLE)
    draw.text((60, 58), "Formula Reference: Support/Resistance and Momentum Scoring",
              font=font_subtitle, fill=COLOR_SUBTITLE)

    # Table layout
    TABLE_LEFT   = 60
    TABLE_TOP    = 88
    HEADER_H     = 44
    ROW_H        = 46
    ACCENT_W     = 4
    CELL_PAD     = 10
    TABLE_WIDTH  = VIDEO_WIDTH - TABLE_LEFT - 60  # 1160px

    # Column widths (fixed proportions summing to TABLE_WIDTH)
    col_widths = [260, 500, TABLE_WIDTH - 260 - 500]  # [260, 500, 400]

    def col_x(i: int) -> int:
        return TABLE_LEFT + sum(col_widths[:i])

    # Header row
    hx, hy = TABLE_LEFT, TABLE_TOP
    for ci, (header, cw) in enumerate(zip(headers, col_widths)):
        draw.rectangle([col_x(ci), hy, col_x(ci) + cw, hy + HEADER_H], fill=COLOR_HEADER_BG)
        text = _truncate_text(draw, header, font_header, cw, CELL_PAD)
        _draw_text_centered(draw, col_x(ci), hy, cw, HEADER_H, text, font_header, COLOR_HEADER_FG)

    # Data rows
    for ri, row in enumerate(rows):
        ry = TABLE_TOP + HEADER_H + ri * ROW_H
        is_highlighted = (ri == highlight_index)

        if is_highlighted:
            row_color = COLOR_HIGHLIGHT
        elif ri % 2 == 1:
            row_color = COLOR_ROW_ALT
        else:
            row_color = COLOR_ROW_NORM

        # Row background
        draw.rectangle([TABLE_LEFT, ry, TABLE_LEFT + TABLE_WIDTH, ry + ROW_H], fill=row_color)

        # Left accent bar for highlighted row
        if is_highlighted:
            draw.rectangle([TABLE_LEFT, ry, TABLE_LEFT + ACCENT_W, ry + ROW_H], fill=COLOR_ACCENT)

        # Cell text
        for ci, (cell, cw) in enumerate(zip(row, col_widths)):
            cx = col_x(ci)
            text = _truncate_text(draw, cell, font_cell, cw, CELL_PAD)
            # Vertically center text in row
            try:
                bbox = draw.textbbox((0, 0), text, font=font_cell)
                th = bbox[3] - bbox[1]
            except AttributeError:
                _, th = draw.textsize(text, font=font_cell)
            tx = cx + CELL_PAD + (ACCENT_W if (ci == 0 and is_highlighted) else 0)
            ty = ry + (ROW_H - th) // 2
            draw.text((tx, ty), text, font=font_cell, fill=COLOR_TEXT)

    # Grid lines — horizontal
    for ri in range(len(rows) + 1):
        gy = TABLE_TOP + HEADER_H + ri * ROW_H
        draw.line([(TABLE_LEFT, gy), (TABLE_LEFT + TABLE_WIDTH, gy)], fill=COLOR_GRID, width=1)
    # Grid lines — vertical
    for ci in range(len(col_widths) + 1):
        gx = col_x(ci) if ci < len(col_widths) else TABLE_LEFT + TABLE_WIDTH
        draw.line([(gx, TABLE_TOP), (gx, TABLE_TOP + HEADER_H + len(rows) * ROW_H)],
                  fill=COLOR_GRID, width=1)
    # Header bottom border (thicker)
    draw.line([(TABLE_LEFT, TABLE_TOP + HEADER_H),
               (TABLE_LEFT + TABLE_WIDTH, TABLE_TOP + HEADER_H)],
              fill=COLOR_HEADER_BG, width=2)

    # Footer
    footer_text = (
        f"Row {highlight_index + 1} of {len(rows)}  \u2014  "
        "Audio narration synced to highlight duration"
    )
    draw.text((60, VIDEO_HEIGHT - 28), footer_text, font=font_footer, fill=COLOR_FOOTER)

    return img


def frame_to_numpy(img):
    import numpy as np
    return np.array(img.convert("RGB"))


# ─────────────────────────────────────────────────────────────────────────────
# Audio helpers
# ─────────────────────────────────────────────────────────────────────────────

def generate_tts_audio(text: str, output_path: str, client) -> None:
    """Call OpenAI TTS API and save MP3 to output_path."""
    import time
    for attempt in range(2):
        try:
            response = client.audio.speech.create(
                model=TTS_MODEL,
                voice=TTS_VOICE,
                input=text,
            )
            response.stream_to_file(output_path)
            if os.path.getsize(output_path) == 0:
                raise RuntimeError(f"TTS output file is empty: {output_path}")
            return
        except Exception as e:
            if "rate_limit" in str(e).lower() and attempt == 0:
                print("  Rate limit hit, waiting 60s...")
                time.sleep(60)
            else:
                raise


def get_audio_duration(mp3_path: str) -> float:
    """Return duration of an MP3 file in seconds."""
    # Try pydub first
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_mp3(mp3_path)
        return len(audio) / 1000.0
    except Exception:
        pass
    # Fallback: ffprobe
    ffprobe = shutil.which("ffprobe") or "/snap/bin/ffprobe"
    result = subprocess.run(
        [ffprobe, "-i", mp3_path, "-show_entries", "format=duration",
         "-v", "quiet", "-of", "csv=p=0"],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 3.0  # fallback default


def make_silent_audio(duration: float, output_path: str) -> None:
    """Generate a silent MP3 of the given duration using ffmpeg."""
    ffmpeg = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg") or "/snap/bin/ffmpeg"
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=mono",
         "-t", str(duration), "-q:a", "9", "-acodec", "libmp3lame", output_path],
        capture_output=True, check=True
    )


# ─────────────────────────────────────────────────────────────────────────────
# Video assembly
# ─────────────────────────────────────────────────────────────────────────────

def generate_video(html: str, output_path: str, openai_api_key: str = None,
                   dry_run: bool = False) -> None:
    from moviepy.editor import ImageClip, AudioFileClip, concatenate_videoclips, concatenate_audioclips

    headers, rows = parse_html_table(html)
    if not rows:
        raise ValueError("No data rows found in the table.")

    missing = [i for i in range(len(rows)) if i not in NARRATION]
    if missing:
        print(f"Warning: no narration for row indices {missing} — using silent clips.")

    client = None
    if not dry_run:
        if openai_api_key is None:
            openai_api_key = os.environ.get("OPENAI_API_KEY")
        if not openai_api_key:
            raise EnvironmentError(
                "OPENAI_API_KEY not set. Pass --api-key or export OPENAI_API_KEY."
            )
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key)

    tmpdir = tempfile.mkdtemp(prefix="table_video_")
    print(f"Working directory: {tmpdir}")

    try:
        video_clips = []
        audio_clips = []

        for i, row in enumerate(rows):
            print(f"  Processing row {i + 1}/{len(rows)}: {row[0]}")
            audio_path = os.path.join(tmpdir, f"row_{i}.mp3")
            narration = NARRATION.get(i, "")

            if dry_run or not narration:
                duration = 3.0
                make_silent_audio(duration, audio_path)
            else:
                generate_tts_audio(narration, audio_path, client)
                duration = get_audio_duration(audio_path)

            frame_img = render_table_frame(headers, rows, highlight_index=i)
            arr = frame_to_numpy(frame_img)

            video_clips.append(ImageClip(arr).set_duration(duration))
            audio_clips.append(AudioFileClip(audio_path))

        print("Stitching video...")
        final_video = concatenate_videoclips(video_clips)
        final_audio = concatenate_audioclips(audio_clips)
        final_video = final_video.set_audio(final_audio)
        final_video.write_videofile(
            output_path,
            fps=FPS,
            codec="libx264",
            audio_codec="aac",
            logger="bar",
        )
        print(f"\nDone! Video saved to: {output_path}")

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate an explainer video from an HTML/markdown table.")
    parser.add_argument("--html",    help="Path to file containing an HTML <table> (omit to use built-in sample)")
    parser.add_argument("--output",  default="output.mp4", help="Output MP4 path (default: output.mp4)")
    parser.add_argument("--api-key", dest="api_key", help="OpenAI API key (default: $OPENAI_API_KEY)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip TTS; use 3s silent clips to test layout and stitching")
    args = parser.parse_args()

    if args.html:
        with open(args.html, "r", encoding="utf-8") as f:
            content = f.read().strip()
        # Accept either raw HTML or markdown
        if content.startswith("<"):
            html = content
        else:
            html = markdown_to_html(content)
    else:
        html = markdown_to_html(SAMPLE_MARKDOWN)

    generate_video(html, args.output, openai_api_key=args.api_key, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
