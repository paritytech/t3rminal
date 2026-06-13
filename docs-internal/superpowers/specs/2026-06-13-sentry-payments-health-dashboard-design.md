# Sentry "Payments Health" Dashboard — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm), pending spec review
**Consumer:** engineering reliability (per [[t3rminal-sentry-project]] effort)
**Org/project:** `paritytech` / `t3rminal`, EU region (`de.sentry.io`)

## Goal
One dashboard answering **"are payments working, and how fast?"** for t3rminal's Payments E2E
workflow, with reporting failures and host anomalies as rows. Built via the Sentry dashboards
REST API; widget JSON checked into the repo.

## Hard constraints (carried from the instrumentation work)
1. **No custom numeric aggregation.** Verified: custom numeric attrs/measurements are string-typed
   in this project's EAP (`sum()`/`avg()`/`p95()` 400). Every metric here uses `count()`,
   `count_if(<stringAttr>,equals,<val>)`, equations over those, or `p50/p95(span.duration)`
   (built-in numeric). See [[t3rminal-sentry-numeric-eap]].
2. **Environment scoping via the native dashboard dropdown**, NOT hardcoded per widget. Widgets are
   env-agnostic; the dashboard's "All Envs ▾" filter selects `production` / `preview` / `local` /
   `probe`. This is why the deploy workflow now labels PR previews `environment=preview` (commit
   `38541e5`) — so prod and preview are separable in the dropdown.
3. **Exclude synthetic e2e traffic** with `!tag:e2e-*` on every widget (the Playwright suite tags
   spans `tag=e2e-t3rminal`; this is a scope tag, independent of environment, so it needs its own
   exclusion even when the env dropdown is set to production).
4. **Data availability:** prod has no traffic yet (no prod DSN). Widgets will be empty until the
   secret is set on `main` and merchants generate spans. Validate widget queries against the
   `preview` env (the `pr14` app, telemetry live) and the `probe` env, not production, for now.

## Attribute vocabulary used (all strings unless noted)
- `payment.outcome` span: `payment.outcome` (success|failure), `payment.method` (voucher|coins),
  `payment.source` (direct|items), `payment.sad` (true|false), `payment.failure_reason`.
- `payment.finalization` span: `finalization.finalized`, `finalization.sad`; latency = `span.duration`.
- `payment.coinage.topup` span: `topup.attempt`; latency = `span.duration`; failures → span status + a
  warning event (kind is in the **warning title**, not a span attr).
- `journey.terminal-payment` span: full QR→paid; duration = `span.duration`; `journey.sad`.
- Warning/error events (dataset `error-events`): titles `topUp failed*`, `topUp retry*`,
  `reorg invalidated settled tx*`, `statement subscription interrupted*`, `no Polkadot host*`;
  report failures carry `component` (daily-report|bulletin), `phase`, `expected`.
- Built-in: `span.op`, `span.duration`, `span.status`, `is_transaction`.

## Widget catalog

> **Widget conventions.** Span widgets: `widgetType: "spans"`. Warning/error widgets:
> `widgetType: "error-events"`. Equation widgets set `selectedAggregate: <index of the equation|>`.
> Every widget's `conditions` ends with `!tag:e2e-*`. Root-span KPIs add `is_transaction:true`.
> No `environment:` literal in conditions (dropdown handles it). On POST, omit the `projects` field
> (it 403s even with org:write — attach in UI after).

### Row 1 — KPI strip (big_number, interval 5m)
| # | Title | widgetType | fields / aggregates | conditions |
|---|---|---|---|---|
| 1 | Payment volume | spans | `count()` | `span.op:payment.outcome payment.outcome:success !tag:e2e-*` |
| 2 | Success rate | spans | `count_if(payment.outcome,equals,success)`, `count()`, `equation\|count_if(payment.outcome,equals,success)*100/count()` (selectedAggregate 2) | `span.op:payment.outcome !tag:e2e-*` |
| 3 | topUp p95 | spans | `p95(span.duration)` | `span.op:payment.coinage.topup !tag:e2e-*` |
| 4 | Finality p95 (success) | spans | `p95(span.duration)` | `span.op:payment.finalization finalization.finalized:true !tag:e2e-*` |
| 5 | SAD % | spans | `count_if(payment.sad,equals,true)`, `count()`, `equation\|count_if(payment.sad,equals,true)*100/count()` (selectedAggregate 2) | `span.op:payment.outcome !tag:e2e-*` |

### Row 2 — Trends (line, interval 1h)
| 6 | Success vs friction over time | spans | series: `count_if(payment.outcome,equals,success)`, `count_if(payment.sad,equals,true)` | `span.op:payment.outcome !tag:e2e-*` |
| 7 | End-to-end payment duration | spans | `p50(span.duration)`, `p95(span.duration)` | `span.op:journey.terminal-payment !tag:e2e-*` |

### Row 3 — Breakdowns (table, interval 5m)
| 8 | By method / source | spans | columns: `payment.method`, `payment.source`, `count()`, `equation\|count_if(payment.outcome,equals,success)*100/count()` | `span.op:payment.outcome !tag:e2e-*` |
| 9 | Phase latency | spans | columns: `span.op`, `p50(span.duration)`, `p95(span.duration)`, `count()`; orderby `-p95(span.duration)` | `span.op:payment.* !tag:e2e-*` (NO `is_transaction` — child spans intended) |

### Row 4 — Failures & host anomalies
| 10 | topUp failures over time | error-events (line, 1h) | `count()` | `title:"topUp failed*" !tag:e2e-*` |
| 11 | Finalization timeouts | spans (big_number, 5m) | `count()` | `span.op:payment.finalization finalization.sad:true !tag:e2e-*` *(split from #4 per decision: more info > less)* |
| 12 | Duplicate-topUp warnings | error-events (big_number, 5m) | `count()` | `title:"topUp retry*" !tag:e2e-*` — expect ~0; spike ⇒ #170 |
| 13 | Reorg invalidations | error-events (big_number, 5m) | `count()` | `title:"reorg invalidated settled tx*" !tag:e2e-*` — data-integrity alarm |
| 14 | Host drops | error-events (line, 1h) | `count()` | `(title:"statement subscription interrupted*" OR title:"no Polkadot host*") !tag:e2e-*` |

### Row 5 — Reporting (table, error-events, 5m)
| 15 | Report failures | error-events | columns: `component`, `phase`, `count()` | `(component:daily-report OR component:bulletin) !expected:true !tag:e2e-*` — only real failures |

Every non-obvious widget gets a description (runbook: what it measures / when to worry / what to do),
per the triangle-deploy convention.

## Build approach
1. Create the dashboard via `POST https://de.sentry.io/api/0/organizations/paritytech/dashboards/`
   with `{title, widgets:[...]}` — **omit `projects`** (403 footgun). Token from keychain
   (`security find-generic-password -s sentry-api-token -w`).
2. After creation, **back up** the live JSON to `sentry/dashboards/<id>.json` and add a
   `sentry/backup-dashboards.sh` + `restore-dashboard.sh` (mirror triangle-deploy). PUT is
   destructive — always back up before any later edit.
3. Record the dashboard ID in [[t3rminal-sentry-project]] and the status file.

## Verification (before declaring done)
- For each widget's exact fields+conditions, run `search_events` (REST, `dataset=spans` or
  `error-events`) and confirm **no 400** (especially equations #2/#5/#8 and the `p95(span.duration)`
  widgets). A 400 "string type field" means a field is mis-typed — fix before relying on it.
- Validate against `environment:preview` (the live pr14 app) + `environment:probe` since production
  is empty. Confirm the env dropdown lists production/preview/local/probe.
- Confirm `!tag:e2e-*` actually excludes the CI e2e spans (compare counts with/without).

## Out of scope (later dashboards)
Failures-detail drill-down and an E2E-health (tag:e2e-*) dashboard — the triangle-deploy 3-dashboard
pattern. Build after this one proves data flows.
