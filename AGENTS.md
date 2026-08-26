# AGENTS.md

## Project

**Re:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ特に動いていた仕事」を再提示する業務支援ツールです。

## Product principles

- 主語は **業務ファイル**。個人の閲覧履歴を長期蓄積しない。
- UXは **静かなPush**。recallよりprecisionを優先する。
- 単なる昨年利用ではなく、**年間の中での季節的な偏り**を検出する。
- ユーザー入力と内部データを分離する。

## Architecture

- Runtime: Google Apps Script V8
- Deployment: Google Sheets container-bound script
- Config UI: `Config`
- Generated ledger: `Data`
- Persistent per-file state: `State`
- Data source: Drive Activity API v2 / `EDIT`
- User resolution: People API directory search
- Identity: Drive File ID
- Primary UX: Google Chat weekly cards

## Sheet responsibilities

### Config

ユーザーが入力するのは次だけ。

- Drive folder URL / ID
- User email address

表示名、Folder ID、Actor ID、状態は自動解決する。チェックボックスや all-users toggle は再導入しない。

### Data

内部生成データのみ。Row 1 は machine-oriented headers。タイトル、キャッチコピー、説明ブロックは置かない。

`folder_path` にはファイル直上フォルダだけでなく、Driveルートからの階層を保存する。

### State

永続的なファイル単位UX状態:

- `skip_this_year`
- `snooze_until`
- `overdue_sent_at`
- `updated_at`

これらを Script Properties に戻さない。

## Script Properties

静的運用設定のみ。初回 `setupReinenMonoWorkbook()` で不足キーを作り、以後は Apps Script Project Settings から手動メンテナンスする。

主要な季節性設定:

- `SEASONAL_WINDOW_DAYS=21`
- `SEASONAL_COMPARISON_DAYS=365`
- `MIN_SEASONAL_ACTIVE_DAYS=2`
- `MIN_SEASONAL_EDIT_ACTIVITIES=3`
- `MIN_SEASONAL_LIFT=2`
- `MIN_SEASONAL_ACTIVITY_SHARE=0.30`

## Detection logic

1年前の今日を中心とした `±SEASONAL_WINDOW_DAYS` を季節ウィンドウとする。

その周囲を含む `SEASONAL_COMPARISON_DAYS` のEDIT履歴を取得し、同じファイルについて季節ウィンドウとその他期間を比較する。

初期値では以下を両方満たすものだけ候補化する。

- 季節ウィンドウの活動日密度が他時期の2倍以上
- 比較期間全体の活動日の30%以上が季節ウィンドウに集中

さらに季節ウィンドウで2活動日以上、またはEDIT activity 3件以上を要求する。

```text
base = seasonal_active_days * 100
     + min(seasonal_edit_activities, 50) * 5

score = base * min(seasonal_lift, 5)
```

**current-year / recent-90-days inactivity filter は使わない。**

## Folder hierarchy

候補に絞った後で Drive parent hierarchy を解決する。全履歴ファイルへ階層取得を行ってAPI負荷を増やさない。

Chatカードにも `folder_path` を表示する。

## User filtering

Drive Activity queryではActorを直接指定できないため、folder/time/actionで取得後、KnownUser Actor ID (`people/...`) でpost-filterする。

選択フォルダが重複する場合、同一activityを二重計上しない。

## Google Chat

- Incoming Webhookを使用
- payloadは `cardsV2` のみ。トップレベル `text` は付けない
- 一覧ボタン文言は **`集計スプシを見る`**
- overdueカードで `去年なら、もう始まっていました` は使わない
- overdue headerは `昨年の開始時期から約N日経っています。`
- `今年は不要` / `あとで` はWeb App経由で `State` へ保存

## Guardrails

1. Product display name is exactly `Re:年モノ`.
2. Keep container-bound spreadsheet architecture.
3. `File ID` is the durable business-asset identifier.
4. Do not add LLM/AI without a concrete need.
5. Do not assert a guaranteed Drive Activity retention period.
6. Do not store file contents unnecessarily.
7. Webhook URLs and secrets stay in Script Properties.
8. Preserve `SPREADSHEET_ID` fallback for time-driven triggers.
9. Prefer explainable seasonality metrics over opaque scoring.
10. Year-round frequently used files should normally be filtered out rather than ranked highly.
