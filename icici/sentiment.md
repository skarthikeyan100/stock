# Stock Sentiment Analyzer

**File:** `src/tools/sentiment.ts`
**Output:** `sentiment_results.csv`
**Input:** `stocks.csv`

Fetches news and social content from five free sources, scores each text using VADER sentiment analysis, and writes a per-stock sentiment summary to CSV.

---

## Usage

```bash
# Compile and run with defaults
npm run sentiment

# Conservative rate limiting (large lists)
npm run sentiment:slow

# Custom paths and options
node dist/tools/sentiment.js \
  --input  stocks.csv \
  --output sentiment_results.csv \
  --concurrency 3 \
  --delay 1500
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--input` | `stocks.csv` | Path to input CSV |
| `--output` | `sentiment_results.csv` | Path to output CSV |
| `--concurrency` | `3` | Number of stocks processed in parallel |
| `--delay` | `1500` | Milliseconds to wait between batches |

---

## Input CSV Format

Minimum required: a `Stock` or `Symbol` column. `Name` is optional but improves search accuracy.

```csv
Stock,Name
RELIANCE,Reliance Industries
TCS,Tata Consultancy Services
GOLD,Gold price India
NATURALGAS,Natural Gas MCX India
```

Accepted column names for symbol: `Stock`, `Symbol`, `symbol`, `SYMBOL`
Accepted column names for name: `Name`, `name`, `Company`

---

## Data Sources

All five sources are fetched in parallel for each stock. No API keys required.

### 1. Google News RSS
- **URL:** `https://news.google.com/rss/search?q=<query>&hl=en-IN&gl=IN&ceid=IN:en`
- **What it fetches:** Up to 10 article titles + snippets per query
- **Queries per stock:** Two — one by ticker symbol (`RELIANCE NSE stock India`) and one by full name (`"Reliance Industries" stock India`)
- **Best for:** Breaking news, earnings reports, regulatory announcements

### 2. Reddit JSON API
- **URLs:**
  - `r/IndianStockMarket` restricted search
  - Global Reddit search with `NSE India` appended
- **What it fetches:** Post titles + body text (first 500 chars), last 10 posts per query, within the past month
- **Requires:** `User-Agent` header (no login)
- **Rate limit:** 60 requests/minute — respected via concurrency limit
- **Best for:** Retail investor sentiment, discussion threads

### 3. Economic Times RSS
- **Feeds:**
  - Stocks news: `economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms`
  - Markets: `economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms`
- **What it fetches:** Full feed, filtered to items that mention the stock symbol or name
- **Best for:** Indian institutional/analyst coverage, earnings commentary

### 4. Moneycontrol RSS
- **Feeds:**
  - Top news: `moneycontrol.com/rss/MCtopnews.xml`
  - Market reports: `moneycontrol.com/rss/marketreports.xml`
  - Results: `moneycontrol.com/rss/results.xml`
- **What it fetches:** Full feed, filtered by symbol/name match
- **Best for:** Indian retail investor news, quarterly results, broker calls

### 5. Yahoo Finance
- **Endpoints:**
  - News search: `query2.finance.yahoo.com/v1/finance/search?q=<symbol>.NS&newsCount=10`
  - Quote summary: `query2.finance.yahoo.com/v10/finance/quoteSummary/<symbol>.NS?modules=assetProfile,recommendationTrend`
- **What it fetches:**
  - News headlines (10 articles)
  - Business summary text
  - Analyst recommendation counts (strongBuy / buy / hold / sell / strongSell) — converted to sentiment phrases
- **Symbol format:** NSE symbols are suffixed with `.NS` (e.g. `RELIANCE.NS`)
- **Best for:** Analyst consensus, FII-tracked large caps

---

## NLP Engine — VADER Sentiment

VADER (Valence Aware Dictionary and sEntiment Reasoner) is a lexicon-based sentiment analyzer designed specifically for short social/news text. It handles punctuation, capitalization, and negation without any training data.

### How scoring works

1. Each fetched text is cleaned (non-ASCII removed, whitespace normalized)
2. VADER scores each text individually, producing four values:
   - `pos` — proportion of positive sentiment (0–1)
   - `neg` — proportion of negative sentiment (0–1)
   - `neu` — proportion of neutral sentiment (0–1)
   - `compound` — normalized overall score (−1.0 to +1.0)
3. All per-text compound scores are averaged to produce the stock's final score

### Classification thresholds (VADER standard)

| Compound | Label |
|----------|-------|
| >= +0.05 | Positive |
| <= −0.05 | Negative |
| between  | Neutral |

### Confidence

```
Confidence(%) = |compound| × 100
```

Measures how far from neutral the average sentiment is — not a statistical probability.

| Confidence | Interpretation |
|------------|----------------|
| 0–9% | Effectively neutral, weak signal |
| 10–29% | Mild directional bias |
| 30–49% | Moderate sentiment skew |
| 50%+ | Strong consensus signal |

---

## Output CSV

**File:** `sentiment_results.csv`

| Column | Type | Description |
|--------|------|-------------|
| `Symbol` | string | Stock ticker as given in input |
| `Name` | string | Full name as given in input |
| `Sentiment` | string | `Positive`, `Negative`, or `Neutral` |
| `Confidence(%)` | 0–100 | Strength of sentiment signal |
| `Compound` | −1.0–1.0 | Raw VADER average compound score |
| `Positive` | 0–1 | Average positive component across all texts |
| `Negative` | 0–1 | Average negative component across all texts |
| `Neutral` | 0–1 | Average neutral component across all texts |
| `GoogleNewsCount` | integer | Texts fetched from Google News |
| `RedditCount` | integer | Texts fetched from Reddit |
| `EconomicTimesCount` | integer | Texts matched from ET RSS feeds |
| `MoneycontrolCount` | integer | Texts matched from Moneycontrol RSS feeds |
| `YahooFinanceCount` | integer | Texts fetched from Yahoo Finance |
| `SampleCount` | integer | Total texts actually scored by VADER |
| `Timestamp` | ISO 8601 | Time the stock was processed |

### Sample output

```
Symbol,Name,Sentiment,Confidence(%),Compound,...,SampleCount,Timestamp
RELIANCE,Reliance Industries,Positive,21,0.207,...,94,2026-04-03T14:57:56Z
SBIN,State Bank of India,Positive,25,0.255,...,73,2026-04-03T14:58:00Z
GOLD,Gold price India,Positive,10,0.10,...,50,2026-04-03T14:58:10Z
```

---

## Rate Limiting

| Source | Strategy |
|--------|----------|
| Google News | Max 3 concurrent stocks, 10 articles per query |
| Reddit | `User-Agent` header required; back off on HTTP 429 |
| Economic Times | RSS feeds cached per run (one fetch per feed per run) |
| Moneycontrol | RSS feeds cached per run |
| Yahoo Finance | `User-Agent: Mozilla/5.0` header; 404s silently skipped |
| Inter-stock | `--delay` ms pause between each stock batch |

For lists of 50+ stocks, use `--concurrency 2 --delay 2500` to avoid triggering rate limits.

---

## Known Limitations

- **VADER is English-only.** Hindi text in Reddit posts scores as Neutral.
- **ET / Moneycontrol use general feeds.** Small-cap or newly listed stocks may return 0 matches if they aren't in current headlines.
- **Yahoo Finance uses `.NS` suffix.** Commodity entries like `GOLD` or `NATURALGAS` may return fewer results since they aren't NSE equity symbols.
- **Low SampleCount = unreliable.** Treat any stock with `SampleCount < 5` as inconclusive regardless of the sentiment label.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `vader-sentiment` | VADER NLP scoring |
| `rss-parser` | RSS/Atom feed parsing |
| `axios` | HTTP client for Reddit and Yahoo Finance |
| `csv-parse` | Reading input CSV |
| `csv-stringify` | Writing output CSV |
| `p-limit` | Concurrency control |
