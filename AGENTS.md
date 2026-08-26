# AGENTS.md

## Project

**Re:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ特に動いていた仕事」を再提示する業務支援ツールです。

## Product principles

- 主語は **業務ファイル**。個人の閲覧履歴を長期蓄積しない。
- UXは **静かなPush**。recallよりprecisionを優先する。
- 単なる昨年利用ではなく、**年度内での季節的な偏り**を検出する。
- ユーザー入力と内部データを分離する。
- 日常運用でApps Scriptのソースファイルを開かせない。**Config + カスタムメニュー**を操作面とする。
- 配布先ごとに変わる値は、Project SettingsではなくConfigで編集できるようにする。

## Architecture

- Runtime: Google Apps Script V8
- Deployment: Google Sheets container-bound script
- Config UI: `Config`
- Generated ledger: `Data`
- Persistent per-file state: `State`
- Data source: Drive Activity API v2 / `EDIT`
- Folder hierarchy: Drive API v3
- User resolution: People API directory search
- Identity: Drive File ID
- Primary UX: Google Chat weekly cards

## Sheet responsibilities

### Config

利用者が編集する設定面。

#### 通知設定

配布先ごとに変わる次の値をConfigへ置く。

- Web App URL
- Google Chat Incoming Webhook URL
- Weekly weekday
- Weekly hour band

これらをScript Propertiesへ戻さない。Configをsource of truthとし、時間主導トリガー実行時もスプレッドシートから読み直す。

#### 対象範囲

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

## Distribution setup flow

配布先の利用者が行う標準手順は次の順番。

1. Spreadsheetを開く
2. Web Appをdeploy
3. Google Chat spaceでIncoming Webhookを作成
4. ConfigへWeb App URL / Webhook URLを入力
5. `Re:年モノ > セットアップ > ① Chat接続テスト`
6. Folder URL / User emailを入力
7. `② 対象範囲を検証・反映`
8. `③ 実データ通知テスト`（`runWeeklyReinenDigest()`）
9. Configの曜日・時間帯を確認
10. `④ 週次トリガーを設定`

Apps Script editorから関数を直接Runすることを通常手順にしない。

Config反映・各メニュー操作時に、`SPREADSHEET_ID`、不足している内部Script Properties、`Data` / `State` の最低限の構造を補完する。

## Custom menu

### セットアップ

- ① Chat接続テスト
- ② 対象範囲を検証・反映
- ③ 実データ通知テスト
- ④ 週次トリガーを設定

### 運用

- 集計を更新
- 週次通知を今すぐ実行
- 履歴診断
- Configを再構築

## Script Properties

**内部設定のみ**。配布先の利用者が通常編集する場所ではない。

主なもの:

- `SPREADSHEET_ID`
- `ACTION_SECRET`
- `UPCOMING_DAYS`
- `WEEKLY_MAX_ITEMS`
- `SNOOZE_DAYS`
- `MAX_OVERDUE_ALERTS_PER_RUN`
- `SEASONAL_WINDOW_DAYS`
- `MIN_SEASONAL_ACTIVE_DAYS`
- `MIN_SEASONAL_EDIT_ACTIVITIES`
- `MIN_SEASONAL_LIFT`
- `MAX_RESULTS`
- `PAGE_SIZE`
- `MAX_PAGES`

次はScript Propertiesへ置かない:

- `CHAT_WEBHOOK_URL`
- `WEB_APP_URL`
- `WEEKLY_DAY`
- `WEEKLY_HOUR`

`ACTION_SECRET`はConfigへ出さず内部生成する。

## Detection logic

1年前の今日を中心とした `±SEASONAL_WINDOW_DAYS` を季節ウィンドウとする。

比較対象は、その1年前の日付が属する **年度（4月1日〜翌年3月31日）**。同じファイルについて、季節ウィンドウと年度内のその他期間の活動日密度を比較する。

初期値では以下を満たすものだけ候補化する。

- 季節ウィンドウで2活動日以上、またはEDIT activity 3件以上
- 季節ウィンドウの活動日密度が年度内の他時期の2倍以上

```text
base = seasonal_active_days * 100
     + min(seasonal_edit_activities, 50) * 5

score = base * min(seasonal_lift, 5)
```

`seasonal_lift` は季節ウィンドウの活動日率 ÷ 年度内その他期間の活動日率。

**current-year / recent-90-days inactivity filter は使わない。**

4月初旬・3月末付近では季節ウィンドウを比較対象年度内にクリップする。

## Folder hierarchy

候補に絞った後で Drive parent hierarchy をルートまで解決する。全履歴ファイルへ階層取得を行ってAPI負荷を増やさない。

Chatカードにも `folder_path` を表示する。

## User filtering

Drive Activity queryではActorを直接指定できないため、folder/time/actionで取得後、KnownUser Actor ID (`people/...`) でpost-filterする。

選択フォルダが重複する場合、同一activityを二重計上しない。

## Google Chat

- Incoming Webhookを使用
- payloadは `cardsV2` のみ。トップレベル `text` は付けない
- 一覧ボタン文言は **`集計スプシを見る`**
- overdue headerは `昨年の開始時期から約N日経っています。`
- `今年は不要` / `あとで` はWeb App経由で `State` へ保存

## Guardrails

1. Product display name is exactly `Re:年モノ`.
2. Keep container-bound spreadsheet architecture.
3. `File ID` is the durable business-asset identifier.
4. Do not add LLM/AI without a concrete need.
5. Do not assert a guaranteed Drive Activity retention period.
6. Do not store file contents unnecessarily.
7. Webhook URL / Web App URL / weekly schedule are Config-managed distribution settings.
8. `ACTION_SECRET` remains internal and must not be exposed in Config.
9. Preserve `SPREADSHEET_ID` fallback for time-driven triggers.
10. Prefer explainable seasonality metrics over opaque scoring.
11. Year-round frequently used files should normally be filtered out rather than ranked highly.
12. The comparison period is fiscal year (Apr 1–Mar 31), not calendar year or rolling 365 days.
13. Do not make editor-based function execution part of normal user operations.
