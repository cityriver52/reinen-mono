# Re:年モノ

**「去年の今ごろ特に動いていた仕事」を、今年もそろそろ思い出させるためのツールです。**

正式表記: **Re:年モノ**  
読み: **レイネンモノ**  
Repository: `reinen-mono`

## 現在の構成

Google Sheets のコンテナバインド Apps Script として動作します。

```text
Re:年モノ スプレッドシート
├─ Config   配布先ごとの通知設定 / 対象フォルダ / 対象ユーザー
├─ View     利用者向けの見やすい候補一覧
├─ Data     毎回再生成する内部集計結果
└─ State    今年は不要 / スヌーズ / 通知済み状態
        │
        └─ 必要な候補だけ Google Chat へPush
```

## 検出の考え方

単に「去年の今ごろ使われていたファイル」ではなく、**昨年度（4/1〜翌3/31）の他の時期と比べて、今ごろ特に使われていたファイル**を抽出します。

初期設定では:

- 1年前の今日を中心に ±21日を「今ごろ」とする
- 比較対象は、その日が属する **年度（4/1〜翌3/31）**
- 今ごろの活動日密度が、年度内のその他期間の **2倍以上**
- 今ごろに2日以上活動、または EDIT activity 3件以上

これにより、年度を通して毎月使われる常設ファイルを除外しやすくします。

4月初旬・3月末付近では、季節ウィンドウは比較対象年度の範囲内にクリップします。

### スコア

```text
base = 今ごろの活動日数 × 100
     + min(今ごろのEDIT activity, 50) × 5

score = base × min(季節性倍率, 5)
```

季節性倍率は、今ごろの活動日密度を年度内のその他期間の活動日密度と比較したものです。

## 配布先でのセットアップ

利用者は、通常 **Apps Scriptのソースファイルを開いて関数をRunしません**。コードが入ったスプレッドシートを開き、Configとカスタムメニューだけでセットアップします。

推奨手順:

1. Re:年モノ スプレッドシートを開く
2. Apps Script を **Webアプリとしてデプロイ**する
3. 通知先の Google Chat スペースで **Incoming Webhook** を作成する
4. Configの「通知設定」に **WebアプリURL / Chat Webhook URL** を入力する
5. `Re:年モノ > セットアップ > ① Chat接続テスト`
6. Configへ **対象フォルダURL / ID と対象ユーザーのメールアドレス** を入力する
7. `Re:年モノ > セットアップ > ② 対象範囲を検証・反映`
8. `Re:年モノ > セットアップ > ③ 実データ通知テスト`
   - 内部では `runWeeklyReinenDigest()` を実行する
9. Configで週次通知の曜日・時間帯を確認する
10. `Re:年モノ > セットアップ > ④ 週次トリガーを設定`

初回のメニュー操作時のみ、Googleの権限確認画面が表示されることがあります。

## Config

黄色セルが利用者の入力欄です。

### 通知設定

配布先ごとに変わるため、Script PropertiesではなくConfigを唯一の設定元とします。

- `WebアプリURL`
- `Chat Webhook URL`
- `週次通知曜日`
- `時間帯（0〜23時）`

曜日・時間帯を変更した場合は `④ 週次トリガーを設定` を再実行します。

### 対象範囲

利用者が入力するのは次だけです。

- 対象フォルダ: Google Drive フォルダURL / ID
- 対象ユーザー: メールアドレス

表示名、Folder ID、Actor ID、状態は `② 対象範囲を検証・反映` で自動取得します。

## View

利用者が候補全体を確認するための閲覧用シートです。`Data` の内部列をそのまま見せず、次だけを表示します。

- 開始目安
- ファイル名（Driveへのリンク）
- Driveルートからのフォルダ階層
- `昨年8月10日～8月25日の間に6回編集` のような活動要約
- `通知対象 / あとで / 今年は不要` の通知状態

`View` は `Data / State` を数式参照するため、内部集計を二重保存しません。Chatカードの **`集計スプシを見る`** はスプレッドシート先頭ではなく、この `View` タブを直接開きます。

## Script Properties

利用者ごとに書き換える設定は置きません。

Script Propertiesは内部設定だけを保持します。

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

`SPREADSHEET_ID` と不足キーはメニュー操作時に自動補完されます。`ACTION_SECRET` も自動生成されます。

旧バージョンの `CHAT_WEBHOOK_URL / WEB_APP_URL / WEEKLY_DAY / WEEKLY_HOUR` は使用せず、再構築時に削除します。

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

カードには以下を表示します。

- 開始時期までの日数 / 経過日数
- ファイル名
- Driveルートからのフォルダ階層
- `昨年8月10日～8月25日の間に6回編集` のような実績

季節性倍率や `2日活動` のような内部判定値はカードには表示しません。

操作:

- `開く`
- `今年は不要`
- `あとで`
- `集計スプシを見る` — `View` を直接開く

Google Chatへの投稿はトップレベルの本文テキストを付けず、カードのみ送信します。

Cards v2ではカード全体やSectionの背景色を任意指定できないため、視覚的な優先度はアクセントで表現します。

- そろそろ: 青系のタイミング表示 + 薄い青の `開く` ボタン
- 開始時期超過: 赤系のアクセント + 薄い赤の `開く` ボタン

開始時期を過ぎた通知では、

> 昨年の開始時期から約7日経っています。

のように簡潔に表示します。

## Product principle

**年度内の「季節的な偏り」を見つける。年中使う普通のファイルは静かに除外する。**

Re:年モノでは、取りこぼしをゼロにすることより、ユーザーが「そうそう、これだ」と思える通知の精度を優先します。
