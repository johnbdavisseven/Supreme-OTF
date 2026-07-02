# Live Snapshot Pipeline — Plan and State

Goal: supreme-otf.com Live Dashboard shows a 24-hour snapshot of GK Grafana
sensor data (hourly refresh), and the "Open in Grafana" button becomes
"Live View". Data flows: GitHub Actions (hourly) -> headless Grafana session
-> rollup -> Supabase (gated write) -> app tiles (public read).

## Hard constraints

- NEVER commit snapshot data to the repo. main is served publicly by GitHub
  Pages at supreme-otf.com. `data/` is gitignored; outputs go to a private
  7-day artifact and to Supabase only.
- NEVER print secrets. Grafana creds come from repo secrets GRAFANA_USER /
  GRAFANA_PASS. Snapshot writes use SNAPSHOT_WRITE_KEY (to be created).
- Low footprint on GK: no forced template vars, one login per run, explicit
  logout once steady-state lands, server-side aggregation (GROUP BY time(1h)),
  hourly cadence, workflow disabled between iteration runs. Only cleaned tile
  series go to Supabase — no GK query text, datasource UIDs, or dashboard
  internals.
- Pushes to main = production deploys. All work lands on feat/live-snapshot;
  main moves only via PR merge by JD.

## Phases

- [x] Phase 0a: multi-dashboard discovery script (this branch) — capture both
      /d/tasp46j/supreme-on-the-fly-water-treatment and
      /d/tan2hlz/supreme-on-the-fly-tank-levels with dashboard defaults
      (Bankhead), no var-Pad forcing.
- [x] Phase 0b: DONE 2026-07-01 (run 28565326515). Confirmed: production
      measurement "Double Eagle" (demo repointed); tag Location in {Inlet,
      Outlet, Flowmeter 1..2, Pump 1..6, Tank}; tanks use Well tag (SI-211,
      TQ-20); Flow Rate = field "Pump Rate" @ Flowmeter 1/2; fields
      Fluid Volume / Fluid Percentage @ Location=Tank; chem fields unscoped;
      Treatment Effect = Grafana expression (compute app-side); GK quirk:
      their "Temperature" stat actually reads pH — we bypass with our own
      queries. Datasource uid c22413e3-e707-4321-bf14-85623533c02e confirmed.
- [x] Phase 1: DONE 2026-07-02 (validated run 28565630863: plain-HTTP login,
      6 queries, ~1s, 63 series). Targeted InfluxQL queries replace passive
      panel capture
      (stable series naming: measurement/field/Location), min/max via reduce,
      no capture race, keep login diagnostics + fail-loud exits (2/3/4).
- [x] Phase 2: DONE 2026-07-02, expanded to include server-side portal auth
      per JD. Tables live_snapshot + portal_users + portal_sessions +
      portal_config (all RLS on, zero policies, service-role-only via edge
      fns). Edge fns: portal-login/portal-logout (session tokens),
      snapshot-put (x-snapshot-key, sha256 fingerprint embedded; plaintext
      only in GitHub secret SNAPSHOT_WRITE_KEY), snapshot-get (session
      required), docs-list + reports-get patched with enforcement gated by
      portal_config.enforce_portal_auth (currently 'false'; flip to 'true'
      right after the front-end PR merges — that is the auth cutover step).
      All 9 smoke tests passed. Original plan item: live_snapshot table
      (RLS on), snapshot-put edge fn gated by x-snapshot-key header matching
      SNAPSHOT_WRITE_KEY (mirror reports-admin), snapshot-get public read
      (mirror reports-get). Workflow POSTs rollup after each run.
- [x] Phase 3: DONE 2026-07-02 (browser verification pending). Also swapped
      the client-side credential list for portal-login sessions, wired tank
      tiles to snapshot volumes, and ppm is computed from real flowmeter
      rate (hidden while flow is 0) instead of GK's hardcoded 252,000 GPH.
      Original plan item: index.html — tiles read snapshot-get (same pattern as
      fetchReports ~line 419), badge "24-hr snapshot · as of HH:MM",
      "Open in Grafana" button (~line 831-851) renamed "Live View",
      stale-guard (>2h old -> delayed-data state, keep mock fallback).
- [ ] Phase 4: PR merge by JD (single production deploy), re-enable hourly
      cron, scheduled soak check (workflow green + snapshot freshness),
      then done.

## Key facts

- Repo: johnbdavisseven/Supreme-OTF (public). Pages: main / -> supreme-otf.com.
- Workflow: grafana-snapshot (id 300438142). Dispatch from this branch:
  `gh workflow run grafana-snapshot.yml -R johnbdavisseven/Supreme-OTF --ref feat/live-snapshot`
  Artifact: `gh run download <id> -n grafana-snapshot`. Keep workflow DISABLED
  between iteration runs (enable -> dispatch -> download -> disable).
- Grafana: gkoilfield.grafana.net, InfluxQL, datasource uid
  c22413e3-e707-4321-bf14-85623533c02e (from June 22 discovery; reconfirm).
- June 22 discovery (pre-redesign): dashboard then read "Double Eagle Demo";
  fields ORP/pH tagged Location=Inlet|Outlet; H2S; Conductivity, TDS,
  Chlorides, Dissolved Oxygen, Specific Gravity, LSI, Stiff and Davis,
  Temperature. Pump 1/2 Rate (GPH) were aliased Corrosion/H2S fields — do not
  carry forward. July 1 layout adds: Flow Rate 1/2 (Bbl/min), Treatment
  Effect, Inlet/Outlet Alerts, Chemical Dosing pumps, Tank Levels dashboard
  (SI-211 / TQ-20 volume + percent full).
- Supabase edge fn deploys + migration were approved by JD 2026-07-01
  (present exact DDL before applying). ppm math is computed app-side from
  real flow + dose once available; GK's hardcoded flow assumption is wrong.
