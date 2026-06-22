// scripts/grafana-snapshot.mjs
//
// Pulls a 24h snapshot from GK Grafana WITHOUT a service-account token.
// It logs in like a normal user with a headless browser, then reads the
// same /api/ds/query responses the dashboard itself makes, and rolls them
// up into data/live_snapshot.json for the app to display.
//
// The first run is also a DISCOVERY run: it writes data/grafana-discovery.json
// with the raw captured queries so we can see the exact field names and query
// format coming back, then refine the per-field math.
//
// Env (set by the GitHub Actions workflow):
//   GRAFANA_USER, GRAFANA_PASS  - your Grafana login (from repo secrets)
//   GRAFANA_BASE                - https://gkoilfield.grafana.net
//   DASH_PATH                   - /d/tasp46j/supreme-on-the-fly-water-treatment
//   PAD                         - pad to filter to (e.g. DAUNTLESS EAST)

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.GRAFANA_BASE || 'https://gkoilfield.grafana.net').replace(/\/$/, '');
const DASH_PATH = process.env.DASH_PATH || '/d/tasp46j/supreme-on-the-fly-water-treatment';
const PAD = process.env.PAD || '';
const USER = process.env.GRAFANA_USER;
const PASS = process.env.GRAFANA_PASS;

if (!USER || !PASS) {
  console.error('Missing GRAFANA_USER or GRAFANA_PASS environment variables.');
  process.exit(1);
}

const captured = [];

function pickField(fields, pred) {
  for (let i = 0; i < fields.length; i++) if (pred(fields[i], i)) return i;
  return -1;
}

function hourlyBuckets(points) {
  const map = new Map();
  for (const p of points) {
    if (p.t == null || p.v == null) continue;
    const h = Math.floor(p.t / 3600000) * 3600000;
    if (!map.has(h)) map.set(h, []);
    map.get(h).push(p.v);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, vs]) => ({ hour: new Date(h).toISOString(), avg: vs.reduce((a, b) => a + b, 0) / vs.length }))
    .slice(-24);
}

function extractSeries(caps) {
  const series = [];
  for (const c of caps) {
    const results = (c.response && c.response.results) || {};
    for (const ref of Object.keys(results)) {
      const frames = results[ref].frames || [];
      for (const f of frames) {
        const fields = (f.schema && f.schema.fields) || [];
        const values = (f.data && f.data.values) || [];
        if (!fields.length || !values.length) continue;
        const tIdx = pickField(fields, (fl) => fl.type === 'time' || /time/i.test(fl.name || ''));
        const vIdx = pickField(fields, (fl, i) => i !== tIdx && fl.type === 'number');
        if (vIdx < 0) continue;
        const name =
          (fields[vIdx].config && fields[vIdx].config.displayNameFromDS) ||
          fields[vIdx].name ||
          (f.schema && f.schema.name) ||
          ref;
        const times = tIdx >= 0 ? values[tIdx] || [] : [];
        const vals = values[vIdx] || [];
        const points = [];
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] == null) continue;
          points.push({ t: times[i] != null ? times[i] : null, v: vals[i] });
        }
        if (!points.length) continue;
        const nums = points.map((p) => p.v);
        series.push({
          name,
          latest: nums[nums.length - 1],
          mean24h: nums.reduce((a, b) => a + b, 0) / nums.length,
          min: Math.min(...nums),
          max: Math.max(...nums),
          count: nums.length,
          hourly: hourlyBuckets(points)
        });
      }
    }
  }
  return series;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();

page.on('response', async (res) => {
  if (!res.url().includes('/api/ds/query')) return;
  try {
    const json = await res.json();
    let request = null;
    try { request = JSON.parse(res.request().postData() || 'null'); } catch {}
    captured.push({ url: res.url(), status: res.status(), request, response: json });
  } catch {}
});

// 1) Log in
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const userSelectors = ['input[name="user"]', 'input[name="login"]', 'input[name="email"]', 'input[type="email"]'];
const passSelectors = ['input[name="password"]', 'input[type="password"]'];

async function fillFirst(selectors, value) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.fill(value); return true; }
  }
  return false;
}

const gotUser = await fillFirst(userSelectors, USER);
const gotPass = await fillFirst(passSelectors, PASS);
if (!gotUser || !gotPass) {
  console.error(`Could not find login fields at ${page.url()} (title: "${await page.title()}").`);
  console.error('The login page may use SSO. Adjust selectors after inspecting it.');
  await browser.close();
  process.exit(2);
}

for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Login")']) {
  const b = await page.$(sel);
  if (b) { await b.click(); break; }
}
await page.waitForLoadState('networkidle').catch(() => {});

// Grafana may show a change-password step with a "Skip" button
try { const skip = await page.$('button:has-text("Skip")'); if (skip) await skip.click(); } catch {}
await page.waitForTimeout(2000);
const loggedIn = !page.url().includes('/login');

// 2) Open the dashboard for the last 24h so its panels run their queries
const sep = DASH_PATH.includes('?') ? '&' : '?';
let dashUrl = `${BASE}${DASH_PATH}${sep}orgId=1&from=now-24h&to=now`;
if (PAD) dashUrl += `&var-Pad=${encodeURIComponent(PAD)}`;
await page.goto(dashUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});

// nudge lazy-loaded panels into view
for (let y = 0; y < 4; y++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(1500); }
await page.waitForTimeout(4000);

// 3) Write outputs
mkdirSync('data', { recursive: true });
writeFileSync(
  'data/grafana-discovery.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), dashUrl, loggedIn, queryCount: captured.length, captured }, null, 2)
);

const series = extractSeries(captured);
writeFileSync(
  'data/live_snapshot.json',
  JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      pad: PAD || null,
      source: 'GK Grafana, headless session scrape of /api/ds/query',
      loggedIn,
      queryCount: captured.length,
      seriesCount: series.length,
      series
    },
    null,
    2
  )
);

await browser.close();

// 4) Fail loudly so a broken login never silently publishes empty tiles
if (!loggedIn) { console.error('LOGIN FAILED: still on /login after submit.'); process.exit(3); }
if (captured.length === 0) { console.error('No /api/ds/query captured. Check DASH_PATH and dashboard access.'); process.exit(4); }
console.log(`OK: captured ${captured.length} queries, extracted ${series.length} series.`);
