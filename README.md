# AI Release Radar

**Live dashboard: https://sambenner-123.github.io/ai-release-radar/**

An hourly dashboard of what Polymarket traders think OpenAI, Anthropic, Google, xAI, Meta and DeepSeek will release next. It also logs big moves in the odds.

It runs entirely on GitHub's free tier. There's no server, no API key and no AI model involved.

- `scripts/update.mjs` runs every hour on GitHub Actions (`.github/workflows/update.yml`). It pulls every open "released by…?" and "released on…?" market from Polymarket's public API, then turns each model's markets into one release-date curve.
- `scripts/core.mjs` holds the maths:
  - Daily buckets are normalised and cumulated.
  - A volume-weighted isotonic fit keeps P(released by t) non-decreasing.
  - Between deadlines it interpolates at a constant hazard rate.
- `docs/index.html` is the dashboard, served by GitHub Pages.
- The previous run's history is read back from the live site. So nothing is committed each hour, and the repo stays small.

To refresh by hand: **Actions → Update release radar → Run workflow**.

## Big-move alerts

Every flagged move appears in the dashboard's "Big moves" list. A move is flagged when:

- a model's 7- or 30-day odds shift **15+ points in 24h**, or
- they shift **10+ points since the last hourly run**, or
- a single market with $1k+ traded moves **15+ points in a day**.

Moves of **20+ points** also open a GitHub issue. GitHub emails you about these, and the GitHub mobile app can push them to your phone. To switch that off, change `NOTIFY: 'true'` to `'false'` in `.github/workflows/update.yml`.

To change the thresholds, edit `THRESHOLDS` in `scripts/core.mjs`. To change which labs are tracked, edit `LABS` in the same file.

## Notes

- GitHub pauses scheduled workflows in a repo with no activity for 60 days. If that happens, the Actions tab shows a banner; click **Enable workflow**.
- To run it locally (Node 20+): `node scripts/update.mjs` pulls the live markets and writes `docs/data/`.
- Prices are Polymarket's displayed probabilities. This is not financial advice.
