// Hourly job: pull Polymarket AI release markets, rank models, log big moves.
// Run with: node scripts/update.mjs        (Node 20+, no dependencies)
// Test offline: node scripts/update.mjs --fixture path/to/events.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  LABS, THRESHOLDS, buildModels, labSummary, detectMoves, mergeAlerts, appendHistory, isReleaseEvent, valueAt,
} from './core.mjs';

const API = 'https://gamma-api.polymarket.com';
const OUT = new URL('../docs/data/', import.meta.url);
const TAGS = ['ai-releases', 'gpt-releases', 'ai'];
// Issue (= email/app notification from GitHub) only for really big moves.
const ISSUE_MIN_MOVE = 0.20;

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'release-radar/1.0' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 2000 * i));
    }
  }
}

async function fetchEvents() {
  const byId = new Map();
  for (const tag of TAGS) {
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await getJSON(`${API}/events?tag_slug=${tag}&active=true&closed=false&limit=100&offset=${offset}`);
      for (const ev of page) if (isReleaseEvent(ev)) byId.set(ev.id, ev);
      if (page.length < 100) break;
    }
  }
  return [...byId.values()];
}

// Previous history/alerts come from the live site (PRIOR_URL) when running on GitHub,
// so nothing is committed to the repo. Locally they come from docs/data/.
async function readJSON(name, fallback) {
  const prior = process.env.PRIOR_URL;
  if (prior) {
    const r = await fetch(new URL(name, prior.endsWith('/') ? prior : prior + '/'), { cache: 'no-store' });
    if (r.status === 404) return fallback;                       // first ever run
    if (!r.ok) throw new Error(`Could not read previous ${name}: ${r.status}`); // abort, keep live site intact
    return r.json();
  }
  try { return JSON.parse(await readFile(new URL(name, OUT), 'utf8')); } catch { return fallback; }
}
const writeJSON = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data));

async function openIssue(alerts) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, NOTIFY } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || NOTIFY === 'false') return;
  const big = alerts.filter(a => Math.abs(a.to - a.from) >= ISSUE_MIN_MOVE);
  if (!big.length) return;
  const pct = v => `${Math.round(v * 100)}%`;
  const body = big.map(a => `- **${a.model}**: ${a.text} — ${pct(a.from)} → ${pct(a.to)} (${a.window}) [market](${a.url})`).join('\n');
  const title = `Big move: ${big[0].model} ${pct(big[0].from)} → ${pct(big[0].to)}` + (big.length > 1 ? ` (+${big.length - 1} more)` : '');
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    body: JSON.stringify({ title, body }),
  });
  if (!r.ok) console.warn('Could not open issue:', r.status, await r.text());
}

async function main() {
  const fixture = process.argv.indexOf('--fixture');
  const nowArg = process.argv.indexOf('--now');
  const now = nowArg > 0 ? Date.parse(process.argv[nowArg + 1]) : Date.now();
  const events = fixture > 0
    ? JSON.parse(await readFile(process.argv[fixture + 1], 'utf8'))
    : await fetchEvents();

  await mkdir(OUT, { recursive: true });
  const models = buildModels(events, now);
  const history = await readJSON('history.json', { ts: [], series: {} });
  for (const m of models) {          // change vs ~24h ago (null until there's a day of history)
    for (const f of ['p7', 'p30']) {
      const ago = valueAt(history, m.key, f, now - 86400000, 3 * 3600000);
      m[`d24${f}`] = ago == null || m[f] == null ? null : Math.round((m[f] - ago) * 1000) / 1000;
    }
  }
  const fresh = detectMoves(models, history, now);
  const { added, all } = mergeAlerts(await readJSON('alerts.json', []), fresh, now);

  await writeJSON('latest.json', {
    updated: now,
    labs: LABS.map(l => ({ id: l.id, name: l.name })),
    labSummary: labSummary(models),
    thresholds: THRESHOLDS,
    models,
  });
  await writeJSON('history.json', appendHistory(history, models, now));
  await writeJSON('alerts.json', all);
  await openIssue(added);

  console.log(`${events.length} release events -> ${models.length} models; ${added.length} new alerts`);
  for (const m of models.slice(0, 10))
    console.log(`  ${m.lab.padEnd(9)} ${m.name.padEnd(36)} 7d ${fmt(m.p7)}  30d ${fmt(m.p30)}`);
}
const fmt = v => (v == null ? '  -' : `${Math.round(v * 100)}%`.padStart(4));

main().catch(e => { console.error(e); process.exit(1); });
