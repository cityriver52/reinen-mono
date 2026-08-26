# Re:年モノ

**「去年の今ごろ特に動いていた仕事」を、今年もそろそろ思い出させるためのツールです。**

正式表記: **Re:年モノ**  
読み: **レイネンモノ**  
Repository: `reinen-mono`

## 現在の構成

Google Sheets のコンテナバインド Apps Script として動作します。

```text
Re:年モノ スプレッドシート
├─ Config   対象フォルダ / 対象ユーザー
├─ Data     毎回再生成する集計結果
└─ State    今年は不要 / スヌーズ / 通知済み状態
        │
        └─ 必要な候補だけ Google Chat へPush
```

## 検出の考え方

単に「去年の今ごろ使われていたファイル」ではなく、**去年の他の時期と比べて今ごろ特に使われていたファイル**を抽出します。

初期設定では:

- 1年前の今日を中心に ±21日（43日間）を「今ごろ」とする
- その周囲を含む365日間を比較期間とする
- 今ごろの活動日密度が他時期の **2倍以上**
- 365日間の全活動日のうち **30%以上** が今ごろに集中
- 今ごろに2日以上活動、または EDIT activity 3件以上

これにより、年中毎月使われる常設ファイルを除外しやすくします。

### スコア

```text
base = 今ごろの活動日数 × 100
     + min(今ごろのEDIT activity, 50) × 5

score = base × min(季節性倍率, 5)
```

季節性倍率は、今ごろの「1日あたり活動率」を他時期の活動率と比較したものです。

## Script Properties

初回 `setupReinenMonoWorkbook()` で必要なプロパティを作成します。以後は Apps Script のプロジェクト設定から直接変更します。

主な季節性設定:

- `SEASONAL_WINDOW_DAYS` = `21`
- `SEASONAL_COMPARISON_DAYS` = `365`
- `MIN_SEASONAL_ACTIVE_DAYS` = `2`
- `MIN_SEASONAL_EDIT_ACTIVITIES` = `3`
- `MIN_SEASONAL_LIFT` = `2`
- `MIN_SEASONAL_ACTIVITY_SHARE` = `0.30`

通知設定:

- `CHAT_WEBHOOK_URL`
- `WEB_APP_URL`
- `WEEKLY_DAY`
- `WEEKLY_HOUR`
- `UPCOMING_DAYS`
- `WEEKLY_MAX_ITEMS`
- `SNOOZE_DAYS`

新しいプロパティを追加したリリースへ更新した場合は、`setupReinenMonoWorkbook()` を再実行すると不足キーだけ補完されます。既存値は上書きしません。

## Config

ユーザーが入力するのは黄色セルだけです。

- 対象フォルダ: Google Drive フォルダURL / ID
- 対象ユーザー: メールアドレス

表示名、Folder ID、Actor ID、状態は自動取得します。

## Data

内部集計用シートです。タイトルや説明文は置きません。

主な列:

- `score`
- `file_name`
- `folder_path` — ファイル直上だけでなくDriveルートからの階層
- `last_year_active_days`
- `last_year_edit_activities`
- `other_period_active_days`
- `other_period_edit_activities`
- `seasonal_lift`
- `seasonal_activity_share`
- `last_year_first_activity`
- `last_year_last_activity`
- `expected_start`
- `drive_url`
- `file_id`

## State

動的な状態は Script Properties ではなく表管理します。

- `skip_this_year`
- `snooze_until`
- `overdue_sent_at`

## Google Chat

通常は週1回・最大3件だけ通知します。

カードにはファイル名に加えて **Driveのフォルダ階層** と季節性倍率を表示します。

操作:

- `開く`
- `今年は不要`
- `あとで`
- `集計スプシを見る`

Google Chatへの投稿はトップレベルの本文テキストを付けず、カードのみ送信します。

開始時期を過ぎた通知では、`去年なら、もう始まっていました` という見出しは使わず、

> 昨年の開始時期から約7日経っています。

のように簡潔に表示します。

## セットアップ

1. 管理用Googleスプレッドシートを開く
2. **拡張機能 → Apps Script**
3. このリポジトリの `.gs` と `appsscript.json` を配置
4. Drive Activity API / People API を有効化
5. `setupReinenMonoWorkbook()`
6. ConfigへフォルダURLとメールアドレスを入力
7. `refreshReinenConfig()`
8. `diagnoseHistory()`
9. `runReinenMono()`

## Product principle

**年次的な「偏り」を見つける。年中使う普通のファイルは静かに除外する。**

Re:年モノでは、取りこぼしをゼロにすることより、ユーザーが「そうそう、これだ」と思える通知の精度を優先します。
