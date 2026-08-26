# Re:年モノ

**「去年の今ごろ動いていた仕事」を、今年もそろそろ思い出させるためのツールです。**

正式表記: **Re:年モノ**  
読み: **レイネンモノ**  
Repository: `reinen-mono`

## 構成

Google Sheets のコンテナバインド Apps Script として動かします。

```text
Re:年モノ スプレッドシート
├─ Config  ← ユーザー入力はフォルダURLとメールアドレスだけ
├─ Data    ← 毎回再生成する検出結果（内部データ）
└─ State   ← 今年は不要 / スヌーズ / 期限超過通知済みの状態
        │
        └─ 必要なものだけ Google Chat へPush
```

## Config

ユーザーが入力するのは黄色のセルだけです。

### 対象フォルダ

- `フォルダURL / ID（入力）`
- `表示名（自動）`
- `Folder ID（自動）`
- `状態（自動）`

空欄行は対象外です。複数行にURLを入れれば複数フォルダを対象にできます。

### 対象ユーザー

- `メールアドレス（入力）`
- `表示名（自動）`
- `Actor ID（自動）`
- `状態（自動）`

空欄行は対象外です。複数行にメールアドレスを入れれば複数ユーザーを対象にできます。

入力後に `Re:年モノ > Configを更新` を実行すると自動列が更新されます。

## Data

主UIではなく内部台帳です。タイトルやキャッチコピーは置かず、1行目から機械処理向けのヘッダーで始まります。

毎回 `runReinenMono()` / `runWeeklyReinenDigest()` で再生成します。

## State

ファイルごとの動的状態を表で保持します。

- `skip_this_year`: 「今年は不要」
- `snooze_until`: 「あとで」
- `overdue_sent_at`: 期限超過通知を送信済みか

これらは Script Properties には保存しません。

## Script Properties

`setupReinenMonoWorkbook()` の初回実行で必要なキーをすべて作成します。以後のメンテナンスは **Apps Script > プロジェクトの設定 > スクリプト プロパティ** から直接値を書き換えます。

主なキー:

- `SPREADSHEET_ID`
- `CHAT_WEBHOOK_URL`
- `WEB_APP_URL`
- `ACTION_SECRET`
- `WEEKLY_DAY` / `WEEKLY_HOUR`
- `UPCOMING_DAYS` / `WEEKLY_MAX_ITEMS`
- `SNOOZE_DAYS` / `MAX_OVERDUE_ALERTS_PER_RUN`
- `SEASONAL_WINDOW_DAYS`
- `MIN_SEASONAL_ACTIVE_DAYS`
- `MIN_SEASONAL_EDIT_ACTIVITIES`
- `MAX_RESULTS` / `PAGE_SIZE` / `MAX_PAGES`

## 検出ロジック

実行日を基準に昨年の同日を中心とした期間だけを見ます。

デフォルト:

- 昨年同時期: ±21日
- 2日以上にわたり EDIT activity が存在、または EDIT activity が3件以上
- Configで指定したフォルダ配下だけ
- Configで指定したユーザーのactivityだけ

**直近90日の稼働有無は判定条件に含めません。**

スコア:

```text
score = 昨年の活動日数 × 100
      + min(昨年のEDIT activity件数, 50) × 5
```

## セットアップ

1. 管理用Googleスプレッドシートを開く
2. **拡張機能 → Apps Script** でコンテナバインドプロジェクトを開く
3. このリポジトリの `.gs` と `appsscript.json` を配置
4. Drive Activity API と People API を有効化
5. `setupReinenMonoWorkbook()` を1回実行
6. Configの黄色セルにフォルダURL・ユーザーメールを入力
7. `refreshReinenConfig()` を実行
8. 必要に応じて Script Properties を編集
9. `diagnoseHistory()` / `runReinenMono()` で確認

Google Chatを使う場合は `CHAT_WEBHOOK_URL` と、フィードバックボタンを使う場合は `WEB_APP_URL` を Script Properties に設定します。

週次トリガーは `WEEKLY_DAY` / `WEEKLY_HOUR` を編集後、`setupWeeklyReinenTrigger()` を実行します。

## Product principle

**ユーザーに一覧を解読させない。通知しすぎない。設定箇所を増やしすぎない。**

人事異動がある組織でも使えるよう、個人の長期閲覧ログではなく、業務ファイルの過去activityを主語にします。
