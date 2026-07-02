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
- [ ] Phase 0b: run discovery from this branch, confirm: production
      measurement name (expect "Double Eagle", not "Double Eagle Demo"),
      new template var names (var-Fleet, var-Source...), Flow Rate 1/2
      field+location names, alert/Treatment Effect fields, tank fields.
- [ ] Phase 1: targeted InfluxQL queries replace passive panel capture
      (stable series naming: measurement/field/Location), min/max via reduce,
      no capture race, keep login diagnostics + fail-loud exits (2/3/4).
- [ ] Phase 2: Supabase (project bfpsvvojskrbzrhcuuwe): live_snapshot table
      (RLS on), snapshot-put edge fn gated by x-snapshot-key header matching
      SNAPSHOT_WRITE_KEY (mirror reports-admin), snapshot-get public read
      (mirror reports-get). Workflow POSTs rollup after each run.
- [ ] Phase 3: index.html — tiles read snapshot-get (same pattern as
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
