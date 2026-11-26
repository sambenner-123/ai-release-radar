// Core logic: turn Polymarket events into per-model release-date curves.
// Pure functions only (no network, no files) so they can be tested anywhere.

export const LABS = [
  { id: 'openai',    name: 'OpenAI',    tags: ['openai', 'gpt', 'chatgpt', 'gpt-releases'], re: /\b(gpt|openai|chatgpt|sora)\b/i },
  { id: 'anthropic', name: 'Anthropic', tags: ['anthropic', 'claude'],                     re: /\b(claude|anthropic|opus|sonnet|haiku|fable|mythos)\b/i },
  { id: 'google',    name: 'Google',    tags: ['google', 'gemini', 'deepmind'],            re: /\b(gemini|google|deepmind)\b/i },
  { id: 'xai',       name: 'xAI',       tags: ['xai', 'grok', 'spacexai'],                 re: /\b(grok|xai)\b/i },
  { id: 'meta',      name: 'Meta',      tags: ['meta', 'llama', 'muse-spark', 'muse'],     re: /\b(muse|llama|meta)\b/i },
  { id: 'deepseek',  name: 'DeepSeek',  tags: ['deepseek'],                                re: /\bdeepseek\b/i },
];

const RELEASE_RE = /\b(released|made available)\s+(by|on)\b/i;
const DAY = 86400000;

export function labFor(event) {
  const tags = (event.tags || []).map(t => (typeof t === 'string' ? t : t.slug));
  for (const lab of LABS) if (lab.tags.some(t => tags.includes(t))) return lab.id;
  for (const lab of LABS) if (lab.re.test(event.title)) return lab.id;
  return null;
}

export function isReleaseEvent(event) {
  return RELEASE_RE.test(event.title || '');
}

export function modelName(title) {
  return title.replace(/\s*(released|made available)\s+(by|on)\b.*$/i, '').trim();
}

// Tidier label for the dashboard: "Next Google Gemini Pro Model" -> "Next Gemini Pro"
export function displayName(title) {
  return modelName(title).replace(/\bGoogle\s+/, '').replace(/\s+Model\b/, '').replace(/\s{2,}/g, ' ').trim();
}

// "Next Muse Spark Model (1.4+)" and "Next Muse Spark (1.4+)" -> same key
export function modelKey(title) {
  return modelName(title)
    .toLowerCase()
    .replace(/\b(next|the|model|google|meta|alibaba)\b/g, ' ')
    .replace(/[^a-z0-9.+]/g, '');
}

function yesPrice(m) {
  let p = m.outcomePrices;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const v = Array.isArray(p) ? parseFloat(p[0]) : NaN;
  return Number.isFinite(v) ? v : null;
}

const isNoReleaseBucket = m =>
  /^no release/i.test(m.groupItemTitle || '') || /will there be no\b/i.test(m.question || '');

// Points (t = deadline ms, p = P(released by t), w = weight) from one event.
export function eventPoints(event, now) {
  const open = (event.markets || []).filter(m =>
    !m.closed && yesPrice(m) !== null && Date.parse(m.endDate) > now);
  if (!open.length) return [];

  if (event.negRisk) {
    // Mutually exclusive daily buckets + a "no release by X" catch-all.
    const buckets = open.filter(m => !isNoReleaseBucket(m))
      .sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate));
    const none = open.find(isNoReleaseBucket);
    const total = buckets.reduce((s, m) => s + yesPrice(m), 0) + (none ? yesPrice(none) : 0);
    if (!(total > 0) || !none) return [];          // can't normalise without the catch-all
    const w = open.reduce((s, m) => s + (m.volumeNum || 0), 0) + 1;
    let cum = 0;
    return buckets.map(m => {
      cum += yesPrice(m) / total;
      return { t: Date.parse(m.endDate), p: Math.min(cum, 1), w };
    });
  }
  // Cumulative "released by <date>?" ladder.
  return open.map(m => ({ t: Date.parse(m.endDate), p: yesPrice(m), w: (m.volumeNum || 0) + 1 }));
}

// Weighted isotonic regression (pool-adjacent-violators): P(by t) can't fall as t grows.
export function isotonic(points) {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const blocks = [];
  for (const pt of pts) {
    blocks.push({ ts: [pt.t], p: pt.p, w: pt.w });
    while (blocks.length > 1 && blocks[blocks.length - 2].p > blocks[blocks.length - 1].p) {
      const b = blocks.pop(), a = blocks.pop();
      const w = a.w + b.w;
      blocks.push({ ts: a.ts.concat(b.ts), p: (a.p * a.w + b.p * b.w) / w, w });
    }
  }
  const out = [];
  for (const b of blocks) for (const t of b.ts) out.push({ t, p: b.p });
  // collapse duplicate deadlines
  return out.filter((pt, i) => i === out.length - 1 || out[i + 1].t !== pt.t);
}

// P(released by `target`), interpolating survival at a constant hazard between points.
// Past the last market deadline we don't guess: we return that deadline's probability
// as a floor (atLeast: true), since P(by t) can only grow with t.
export function probBy(curve, now, target) {
  const pts = [{ t: now, p: 0 }, ...curve.filter(c => c.t > now)];
  if (pts.length < 2) return { p: null, atLeast: false };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (target <= b.t) {
      const f = (target - a.t) / (b.t - a.t);
      const Sa = 1 - a.p, Sb = 1 - b.p;
      if (Sa <= 0) return { p: 1, atLeast: false };
      if (Sb <= 0) return { p: a.p + f * (b.p - a.p), atLeast: false };
      return { p: 1 - Sa * Math.pow(Sb / Sa, f), atLeast: false };
    }
  }
  return { p: pts[pts.length - 1].p, atLeast: true };
}

// Date by which the market thinks release is 50/50.
export function medianDate(curve, now) {
  const pts = [{ t: now, p: 0 }, ...curve.filter(c => c.t > now)];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.p >= 0.5) {
      const Sa = 1 - a.p, Sb = 1 - b.p;
      const f = Sb <= 0 ? (0.5 - a.p) / (b.p - a.p) : Math.log(0.5 / Sa) / Math.log(Sb / Sa);
      return a.t + f * (b.t - a.t);
    }
  }
  return null;
}

export function buildModels(events, now) {
  const groups = new Map();
  for (const ev of events) {
    if (!isReleaseEvent(ev)) continue;
    const lab = labFor(ev);
    if (!lab) continue;
    const key = modelKey(ev.title);
    if (!groups.has(key)) groups.set(key, { key, lab, events: [] });
    groups.get(key).events.push(ev);
  }

  const models = [];
  for (const g of groups.values()) {
    const points = g.events.flatMap(ev => eventPoints(ev, now));
    if (!points.length) continue;
    const curve = isotonic(points);
    const p7 = probBy(curve, now, now + 7 * DAY);
    const p30 = probBy(curve, now, now + 30 * DAY);
    const main = [...g.events].sort((a, b) => (b.volume || 0) - (a.volume || 0))[0];
    const markets = g.events.flatMap(ev => (ev.markets || [])
      .filter(m => !m.closed && yesPrice(m) !== null && Date.parse(m.endDate) > now)
      .map(m => ({
        id: String(m.id),
        q: m.question,
        label: m.groupItemTitle || '',
        price: yesPrice(m),
        vol: Math.round(m.volumeNum || 0),
        d1: m.oneDayPriceChange ?? null,
        d7: m.oneWeekPriceChange ?? null,
        end: m.endDate,
        url: `https://polymarket.com/event/${ev.slug}`,
      })));
    const volume = markets.reduce((s, m) => s + m.vol, 0);
    models.push({
      key: g.key,
      name: displayName(main.title),
      lab: g.lab,
      p7: round(p7.p), p7AtLeast: p7.atLeast,
      p30: round(p30.p), p30AtLeast: p30.atLeast,
      median: medianDate(curve, now),
      lastDeadline: curve.length ? curve[curve.length - 1].t : null,
      curve: curve.map(c => ({ t: c.t, p: round(c.p) })),
      volume,
      thin: volume < 2000,
      url: `https://polymarket.com/event/${main.slug}`,
      markets,
    });
  }
  return models.sort((a, b) => (b.p30 ?? 0) - (a.p30 ?? 0));
}

// P(at least one release from each lab in 30 days), assuming models are independent.
export function labSummary(models) {
  return LABS.map(lab => {
    const ms = models.filter(m => m.lab === lab.id && m.p30 != null);
    const anyP30 = ms.length ? 1 - ms.reduce((s, m) => s * (1 - m.p30), 1) : null;
    const top = [...ms].sort((a, b) => b.p30 - a.p30)[0] || null;
    return { id: lab.id, name: lab.name, anyP30: round(anyP30), top: top ? top.key : null, count: ms.length };
  });
}

function round(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

// ---------- Big-move detection ----------
export const THRESHOLDS = {
  model24h: 0.15,     // model's 30-day probability moves 15+ points vs ~24h ago
  modelHour: 0.10,    // ...or 10+ points since the previous hourly run
  market24h: 0.15,    // a single market moves 15+ points in 24h (Polymarket's own figure)
  marketMinVol: 1000, // ignore markets with < $1k traded
  dedupeHours: 24,    // don't repeat the same alert within this window
};

// history: { ts: [ms...], series: { key: { name, lab, p7: [...], p30: [...] } } }
export function valueAt(history, key, field, targetTs, toleranceMs) {
  const s = history.series[key];
  if (!s) return null;
  let best = null, bestGap = Infinity;
  history.ts.forEach((t, i) => {
    const gap = Math.abs(t - targetTs);
    if (gap < bestGap && s[field][i] != null) { best = s[field][i]; bestGap = gap; }
  });
  return bestGap <= toleranceMs ? best : null;
}

export function detectMoves(models, history, now, T = THRESHOLDS) {
  const alerts = [];
  const lastTs = history.ts.length ? history.ts[history.ts.length - 1] : null;
  for (const m of models) {
    for (const field of ['p30', 'p7']) {
      if (m[field] == null) continue;
      const ago = valueAt(history, m.key, field, now - DAY, 3 * 3600000);
      if (ago != null && Math.abs(m[field] - ago) >= T.model24h) {
        alerts.push(alert('model', m, field, ago, m[field], '24h', now));
      } else if (lastTs && now - lastTs < 3 * 3600000) {
        const prev = valueAt(history, m.key, field, lastTs, 60000);
        if (prev != null && Math.abs(m[field] - prev) >= T.modelHour)
          alerts.push(alert('model', m, field, prev, m[field], '1h', now));
      }
    }
    for (const mk of m.markets) {
      if (mk.vol < T.marketMinVol || mk.d1 == null || Math.abs(mk.d1) < T.market24h) continue;
      alerts.push({
        id: `market:${mk.id}:${mk.d1 > 0 ? 'up' : 'down'}`,
        kind: 'market', ts: now, lab: m.lab, model: m.name, key: m.key,
        text: mk.q, from: round(mk.price - mk.d1), to: round(mk.price), window: '24h', url: mk.url,
      });
    }
  }
  return alerts;
}

function alert(kind, m, field, from, to, window, now) {
  const horizon = field === 'p7' ? '7 days' : '30 days';
  return {
    id: `model:${m.key}:${field}:${to > from ? 'up' : 'down'}`,
    kind, ts: now, lab: m.lab, model: m.name, key: m.key,
    text: `${m.name}: chance of release within ${horizon}`,
    from: round(from), to: round(to), window, url: m.url,
  };
}

export function mergeAlerts(existing, fresh, now, T = THRESHOLDS, max = 200) {
  const recent = new Map();
  for (const a of existing) if (now - a.ts < T.dedupeHours * 3600000 && !recent.has(a.id)) recent.set(a.id, a);
  const added = fresh.filter(a => !recent.has(a.id));
  return { added, all: [...added, ...existing].slice(0, max) };
}

export function appendHistory(history, models, now, keepDays = 45) {
  const h = { ts: [...history.ts], series: JSON.parse(JSON.stringify(history.series)) };
  h.ts.push(now);
  const n = h.ts.length;
  for (const m of models) {
    if (!h.series[m.key]) h.series[m.key] = { name: m.name, lab: m.lab, p7: Array(n - 1).fill(null), p30: Array(n - 1).fill(null) };
    const s = h.series[m.key];
    s.name = m.name; s.lab = m.lab;
    s.p7.push(m.p7); s.p30.push(m.p30);
  }
  for (const s of Object.values(h.series)) {
    while (s.p7.length < n) s.p7.push(null);
    while (s.p30.length < n) s.p30.push(null);
  }
  // prune old entries
  const cutoff = now - keepDays * DAY;
  const drop = h.ts.findIndex(t => t >= cutoff);
  if (drop > 0) {
    h.ts = h.ts.slice(drop);
    for (const s of Object.values(h.series)) { s.p7 = s.p7.slice(drop); s.p30 = s.p30.slice(drop); }
  }
  for (const [k, s] of Object.entries(h.series)) if (s.p30.every(v => v == null)) delete h.series[k];
  return h;
}
