// scripts/grafana-snapshot.mjs
//
// Pulls a 24h snapshot from GK Grafana WITHOUT a service-account token,
// using John's viewer login. Two modes:
//
//   SNAPSHOT_MODE=targeted (default)
//     Logs in over plain HTTP (Playwright fallback if that fails), then runs
//     a small set of our own InfluxQL queries through Grafana's
//     /api/ds/query proxy: server-side GROUP BY time(1h) aggregation, ~8
//     HTTP requests per run, explicit logout. Lighter on GK's stack than a
//     person watching the dashboard with auto-refresh on.
//
//   SNAPSHOT_MODE=discovery
//     Headless-browser capture of both dashboards' own panel queries.
//     Used to re-learn the schema when GK changes things.
//
// Schema (confirmed from the 2026-07-01 discovery run, Bankhead layout):
//   measurement "Double Eagle", tag Location in {Inlet, Outlet,
//   Flowmeter 1..2, Pump 1..6, Tank}; tanks disambiguated by Well tag
//   (SI-211, TQ-20). Fields: ORP, pH, Pump Rate, Fluid Volume,
//   Fluid Percentage, Conductivity, TDS, Chlorides, Dissolved Oxygen,
//   Corrosion, Specific Gravity, LSI, Stiff and Davis, H2S, Temperature.
//
// Env (set by the GitHub Actions workflow):
//   GRAFANA_USER, GRAFANA_PASS  - viewer login (from repo secrets)
//   GRAFANA_BASE                - https://gkoilfield.grafana.net
//   DS_UID                      - InfluxDB datasource uid
//   SNAPSHOT_MODE               - targeted | discovery
//   DASH_PATHS                  - discovery mode: comma-separated dashboards
//
// Outputs (data/ is gitignored; artifact + Supabase only, never the repo):
//   data/live_snapshot.json     - clean rolled-up series for the app
//   data/targeted-raw.json      - raw query responses (debug, private)
//   data/grafana-discovery.json - discovery mode only
//
// Exit codes: 1 bad env, 2 login form problem, 3 login failed,
//             4 no data captured.

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.GRAFANA_BASE || 'https://gkoilfield.grafana.net').replace(/\/$/, '');
const MODE = (process.env.SNAPSHOT_MODE || 'targeted').toLowerCase();
const DS_UID = process.env.DS_UID || 'c22413e3-e707-4321-bf14-85623533c02e';
const DASH_PATHS = (process.env.DASH_PATHS || '/d/tasp46j/supreme-on-the-fly-water-treatment,/d/tan2hlz/supreme-on-the-fly-tank-levels')
  .split(',').map((s) => s.trim()).filter(Boolean);
const USER = process.env.GRAFANA_USER;
const PASS = process.env.GRAFANA_PASS;

if (!USER || !PASS) {
  console.error('Missing GRAFANA_USER or GRAFANA_PASS environment variables.');
  process.exit(1);
}

mkdirSync('data', { recursive: true });

// ---------------------------------------------------------------------------
// Rollup helpers (no spread on large arrays; loop-based min/max)

function rollup(points) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0, latest = null, latestAt = null;
  for (const p of points) {
    if (p.v == null) continue;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v; n++;
    if (latestAt == null || (p.t != null && p.t >= latestAt)) { latest = p.v; latestAt = p.t; }
  }
  if (!n) return null;
  return { latest, latestAt: latestAt != null ? new Date(latestAt).toISOString() : null, mean24h: sum / n, min, max, count: n };
}

function seriesFromFrames(frames, fallbackName) {
  const out = [];
  for (const f of frames || []) {
    const fields = f.schema?.fields || [];
    const values = f.data?.values || [];
    if (!fields.length || !values.length) continue;
    const tIdx = fields.findIndex((fl) => fl.type === 'time');
    for (let i = 0; i < fields.length; i++) {
      if (i === tIdx || fields[i].type !== 'number') continue;
      const labels = fields[i].labels || {};
      const fieldName = fields[i].config?.displayNameFromDS || fields[i].name || fallbackName;
      const pts = [];
      const times = tIdx >= 0 ? values[tIdx] || [] : [];
      for (let j = 0; j < (values[i] || []).length; j++) {
        pts.push({ t: times[j] ?? null, v: values[i][j] });
      }
      const hourly = [];
      for (const p of pts) {
        if (p.t == null || p.v == null) continue;
        const iso = new Date(Math.floor(p.t / 3600000) * 3600000).toISOString();
        const last = hourly[hourly.length - 1];
        if (last && last.hour === iso) { last.sum += p.v; last.n++; }
        else hourly.push({ hour: iso, sum: p.v, n: 1 });
      }
      const r = rollup(pts);
      if (!r) continue;
      out.push({
        fieldName,
        tags: { location: labels.Location || null, well: labels.Well || null, pad: labels.Pad || null },
        ...r,
        hourly: hourly.slice(-24).map((h) => ({ hour: h.hour, avg: h.sum / h.n })),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Login: plain HTTP first, headless browser as fallback. Never logs values.

let cookieHeader = null;
let browser = null;

async function loginPlain() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: USER, password: PASS }),
    redirect: 'manual',
  });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const session = cookies.map((c) => c.split(';')[0]).filter((c) => /grafana_session/i.test(c));
  if (!res.ok || !session.length) {
    console.error(`Plain HTTP login not accepted (status ${res.status}); will try browser fallback.`);
    return false;
  }
  cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  console.log('Plain HTTP login OK.');
  return true;
}

async function loginBrowser() {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const userSelectors = [
    'input[name="user"]', 'input[name="login"]', 'input[name="email"]',
    'input[autocomplete="username"]', 'input[data-testid="data-testid Username input field"]',
    'input[aria-label="Username input field"]', 'input[type="email"]', 'input[type="text"]',
  ];
  const passSelectors = [
    'input[name="password"]', 'input[type="password"]',
    'input[autocomplete="current-password"]', 'input[data-testid="data-testid Password input field"]',
  ];
  const appeared = await page.waitForSelector([...userSelectors, ...passSelectors].join(', '), { timeout: 30000 })
    .then(() => true).catch(() => false);
  if (!appeared) {
    console.error(`Login form never rendered at ${page.url()} (title: "${await page.title()}").`);
    process.exit(2);
  }
  const fillFirst = async (sels, val) => {
    for (const sel of sels) {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => false))) { await el.fill(val); return sel; }
    }
    return null;
  };
  const u = await fillFirst(userSelectors, USER);
  const p = await fillFirst(passSelectors, PASS);
  if (!u || !p) { console.error('Could not fill login fields.'); process.exit(2); }
  for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Login")', 'button:has-text("Sign in")']) {
    const b = await page.$(sel);
    if (b) { await b.click(); break; }
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  try { const skip = await page.$('button:has-text("Skip")'); if (skip) await skip.click(); } catch {}
  await page.waitForTimeout(2000);
  if (page.url().includes('/login')) { console.error('LOGIN FAILED: still on /login after submit.'); await browser.close(); process.exit(3); }
  const cookies = await ctx.cookies(BASE);
  cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  console.log('Browser login OK.');
  return page;
}

async function logout() {
  try { await fetch(`${BASE}/logout`, { headers: { Cookie: cookieHeader }, redirect: 'manual' }); } catch {}
  if (browser) { try { await browser.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// Targeted mode

const M = '"Double Eagle"';
const T24 = 'time > now() - 24h';
const G1H = 'GROUP BY time(1h)';
const TARGETS = [
  { refId: 'orp',   label: 'ORP',        sql: `SELECT MEAN("ORP") FROM ${M} WHERE "Location"::tag =~ /^(Inlet|Outlet)$/ AND ${T24} ${G1H}, "Location"::tag fill(null)` },
  { refId: 'ph',    label: 'pH',         sql: `SELECT MEAN("pH") FROM ${M} WHERE "Location"::tag =~ /^(Inlet|Outlet)$/ AND ${T24} ${G1H}, "Location"::tag fill(null)` },
  { refId: 'flow',  label: 'Flow Rate',  sql: `SELECT MEAN("Pump Rate") FROM ${M} WHERE "Location"::tag =~ /^Flowmeter/ AND ${T24} ${G1H}, "Location"::tag fill(null)` },
  { refId: 'pumps', label: 'Pump Rate',  sql: `SELECT MEAN("Pump Rate") FROM ${M} WHERE "Location"::tag =~ /^Pump [0-9]/ AND ${T24} ${G1H}, "Location"::tag fill(null)` },
  { refId: 'tanks', label: 'Tank',       sql: `SELECT MEAN("Fluid Volume") AS "Fluid Volume", MEAN("Fluid Percentage") AS "Fluid Percentage" FROM ${M} WHERE "Location"::tag = 'Tank' AND ${T24} ${G1H}, "Well"::tag fill(null)` },
  { refId: 'chem',  label: 'Chemistry',  sql: `SELECT MEAN("Conductivity") AS "Conductivity", MEAN("TDS") AS "TDS", MEAN("Chlorides") AS "Chlorides", MEAN("Dissolved Oxygen") AS "Dissolved Oxygen", MEAN("Corrosion") AS "Corrosion", MEAN("Specific Gravity") AS "Specific Gravity", MEAN("LSI") AS "LSI", MEAN("Stiff and Davis") AS "Stiff and Davis", MEAN("H2S") AS "H2S", MEAN("Temperature") AS "Temperature" FROM ${M} WHERE ${T24} ${G1H} fill(null)` },
];

async function runTargeted() {
  const raw = [];
  const series = [];
  for (const t of TARGETS) {
    const body = {
      from: 'now-24h', to: 'now',
      queries: [{
        refId: t.refId,
        datasource: { type: 'influxdb', uid: DS_UID },
        query: t.sql, rawQuery: true, resultFormat: 'time_series',
        maxDataPoints: 30, intervalMs: 3600000,
      }],
    };
    let ok = false, json = null, status = 0;
    try {
      const res = await fetch(`${BASE}/api/ds/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Grafana-Org-Id': '1' },
        body: JSON.stringify(body),
      });
      status = res.status;
      json = await res.json().catch(() => null);
      ok = res.ok && json?.results;
    } catch (e) {
      console.error(`query ${t.refId} failed: ${String(e).slice(0, 120)}`);
    }
    raw.push({ refId: t.refId, status, response: json });
    if (!ok) { console.error(`query ${t.refId}: HTTP ${status}, skipping`); continue; }
    for (const ref of Object.keys(json.results)) {
      const extracted = seriesFromFrames(json.results[ref].frames, t.label);
      for (const s of extracted) {
        const tagPart = s.tags.well || s.tags.location;
        const label = tagPart ? `${s.fieldName} @ ${tagPart}` : s.fieldName;
        const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        series.push({ key, label, group: t.refId, field: s.fieldName, tags: s.tags,
          latest: s.latest, latestAt: s.latestAt, mean24h: s.mean24h, min: s.min, max: s.max,
          count: s.count, hourly: s.hourly });
      }
    }
  }
  return { raw, series };
}

// ---------------------------------------------------------------------------
// Discovery mode (headless capture of the dashboards' own queries)

async function runDiscovery() {
  const { chromium } = await import('playwright');
  if (!browser) browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    extraHTTPHeaders: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  const page = await ctx.newPage();
  const captured = [];
  const pending = new Set();
  page.on('response', (res) => {
    if (!res.url().includes('/api/ds/query')) return;
    const p = (async () => {
      try {
        const json = await res.json();
        let request = null;
        try { request = JSON.parse(res.request().postData() || 'null'); } catch {}
        captured.push({ url: res.url(), status: res.status(), pageUrl: page.url(), request, response: json });
      } catch {}
    })();
    pending.add(p); p.finally(() => pending.delete(p));
  });
  const dashUrls = [];
  for (const dp of DASH_PATHS) {
    const sep = dp.includes('?') ? '&' : '?';
    const u = `${BASE}${dp}${sep}orgId=1&from=now-24h&to=now`;
    dashUrls.push(u);
    await page.goto(u, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    for (let y = 0; y < 4; y++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(1500); }
    await page.waitForTimeout(4000);
  }
  await Promise.allSettled([...pending]);
  writeFileSync('data/grafana-discovery.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), dashUrls, queryCount: captured.length, captured }, null, 2));
  console.log(`discovery: captured ${captured.length} panel queries.`);
  return captured.length;
}

// ---------------------------------------------------------------------------
// Main

const plainOk = await loginPlain();
if (!plainOk) await loginBrowser();

let seriesCount = 0;
if (MODE === 'discovery') {
  const n = await runDiscovery();
  await logout();
  if (n === 0) { console.error('No panel queries captured.'); process.exit(4); }
} else {
  const { raw, series } = await runTargeted();
  await logout();
  writeFileSync('data/targeted-raw.json', JSON.stringify({ generatedAt: new Date().toISOString(), raw }, null, 2));
  writeFileSync('data/live_snapshot.json', JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: 'gk-grafana-targeted',
    window: '24h', interval: '1h',
    pad: 'BANKHEAD',
    seriesCount: series.length,
    series,
  }, null, 2));
  seriesCount = series.length;
  if (!seriesCount) { console.error('No series extracted — check queries/schema.'); process.exit(4); }
  console.log(`OK: ${seriesCount} series rolled up from ${TARGETS.length} targeted queries.`);
}
