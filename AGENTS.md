# AGENTS.md

## Project

**Re:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ動いていた仕事」を再提示する業務支援ツールです。

## Product principles

- 主語は **業務ファイル**。個人の閲覧履歴を長期蓄積しない。
- UXは **静かなPush**。recallよりprecisionを優先する。
- ユーザーが入力する設定を極力減らす。
- 内部データとユーザー設定を分離する。

## Current architecture

- Runtime: Google Apps Script V8
- Deployment: Google Sheets container-bound script
- Config UI: `Config`
- Generated ledger: `Data`
- Persistent per-file state: `State`
- Data source: Drive Activity API v2 / `EDIT`
- User resolution: People API directory search
- Identity: Drive File ID
- Seasonal window: one year ago ±21 days by default
- Current-year dormancy filter: **none**
- Primary UX: Google Chat weekly push

## Sheet responsibilities

### Config

User-editable values are only:

- Drive folder URL / ID
- User email address

All other columns are automatically resolved. A non-empty input row is enabled; do not reintroduce enable checkboxes or an all-users toggle unless explicitly requested.

### Data

Internal generated data only. Row 1 is machine-oriented headers. Do not add product titles, catchphrases, explanatory blocks, or dashboard decoration.

Data is regenerated on each run and is not a source of persistent user state.

### State

Persistent file-level UX state:

- `skip_this_year`
- `snooze_until`
- `overdue_sent_at`
- `updated_at`

Do not move these back to Script Properties.

## Script Properties

Script Properties are for static operational settings only. `setupReinenMonoWorkbook()` creates all expected keys once; later maintenance is manual in Apps Script Project Settings.

Never store per-file dynamic state in Script Properties.

## Detection logic

Only last year's same-period activity is used for candidate qualification and scoring.

```text
score = last_year_active_days * 100
      + min(last_year_edit_activities, 50) * 5
```

Do not add a recent-90-days / current-year inactivity filter unless explicitly requested.

## User filtering

Drive Activity query cannot directly select actors, so query by folder/time/action and post-filter using KnownUser Actor IDs (`people/...`). Email addresses are resolved through People API and cached in Config.

If selected folders overlap, deduplicate the same activity before scoring.

## Guardrails

1. Product display name is exactly `Re:年モノ`.
2. Keep container-bound spreadsheet architecture; do not return to standalone Script + separate output Sheet.
3. `File ID` is the durable business-asset identifier.
4. Do not add LLM/AI unless a concrete need emerges.
5. Do not assert a guaranteed Drive Activity retention period.
6. Do not store file contents unnecessarily.
7. Webhook URLs and secrets stay in Script Properties, never Git.
8. Preserve `SPREADSHEET_ID` fallback so time-driven triggers can reopen the bound workbook.
9. Prefer simple, explainable scoring and explicit state tables.

## Google Chat

MVP uses Incoming Webhook. `今年は不要` / `あとで` open the Apps Script Web App and write to `State`.

## Naming

- Display: `Re:年モノ`
- Reading: レイネンモノ
- Repository: `reinen-mono`
