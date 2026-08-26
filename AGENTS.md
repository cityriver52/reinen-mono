# AGENTS.md

## Project

**RE:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ使っていたが、今年はまだ動いていないファイル」を再提示する業務支援ツールです。

## Product principle

このプロジェクトの主語は **ユーザー個人ではなく、業務ファイル** です。

人事異動がある組織で使うため、個人の閲覧履歴や長期的な個人プロファイルへの依存を避けてください。

もう一つの重要原則は **静かなPush** です。RE:年モノでは recall より precision を優先し、余計な通知をしないことを品質として扱います。

## Current architecture

- Runtime: Google Apps Script V8
- Deployment shape: **Google Sheets container-bound script**
- Config UI: bound spreadsheet `Config` sheet
- Ledger: same spreadsheet `おすすめ` sheet
- Data source: Google Drive Activity API v2
- User resolution: People API directory search
- Main signal: `EDIT` activity
- Identity: Google Drive File ID
- Seasonal window: one year ago ±21 days
- Dormancy window: recent 90 days
- Primary UX: Google Chat weekly push
- Weekly digest: max 3 items
- Upcoming window: 0〜21 days before last year's start timing
- Overdue alert: once per file per calendar year, max 1 per run
- User controls: open / skip this year / snooze 14 days

## Config model

`Config` sheet contains two checkbox-based multi-select tables.

### Target folders

- enabled checkbox
- display name
- Drive folder URL or ID
- validation status

Multiple folders may be enabled. If parent/child folders overlap, the core must prevent the same activity from being counted twice.

### Target users

- enabled checkbox
- display name
- email address
- Drive Activity Actor ID (`people/...`)
- validation status

Email addresses are resolved to `people/...` through People API `searchDirectoryPeople` and cached in the sheet.

`全ユーザーを対象` bypasses the user filter.

Important: Drive Activity API's query filter supports time/action detail filters but not Actor selection. **User filtering is post-query** using KnownUser Actor IDs.

## UX hierarchy

1. **まだ早い** → 通知しない
2. **そろそろ** → 週1回のダイジェスト、最大3件
3. **去年ならもう始まっている** → 今年1回だけ強めに通知
4. **今年編集が始まった** → 自動的に黙る

Sheets は全候補を保持する裏側の台帳であり、主UIではありません。

## Guardrails

1. メールアドレスは設定入力であり、推薦の継続主キーにはしない。Drive activity照合には解決済みActor IDを使う。
2. `File ID` を業務資産の継続識別子として扱う。
3. MVP段階では LLM / AI を追加しない。
4. スコアは説明可能に保つ。
5. Drive Activity API の保持期間を断定しない。
6. スタンドアロンScript＋別出力Spreadsheet構成へ戻さない。管理Spreadsheet自身がコンテナ兼台帳。
7. 共有ドライブ / My Drive の違いを無視しない。
8. ファイル本文を不要に保存しない。
9. 通知数を増やして取りこぼしを減らそうとしない。false positive と通知疲れを優先して抑える。
10. ユーザーに「完了」操作を要求しない。今年の編集開始を自動停止シグナルにする。
11. Webhook URL や秘密値をGitにコミットしない。Script Properties に保存する。
12. Time-driven triggerでもSpreadsheetを開けるよう、初期設定時にbound spreadsheet IDをScript Propertiesへ保存する。

## Google Chat architecture

MVPは Incoming Webhook を送信経路に使います。

Webhook は一方向なので、`今年は不要` と `あとで` はカードの `openLink` から Apps Script Web App を開いて処理します。

本格的な対話型 Chat app / Marketplace app は、MVPで価値が確認できるまで導入しません。

## Naming

- Product display name: `RE:年モノ`
- Reading: `レイネンモノ`
- Repository / code identifier: `reinen-mono`

## Preferred next steps

1. Configで複数フォルダ・複数ユーザーを実環境検証
2. 実運用で週次通知のprecisionと通知量を評価
3. 複数ファイルを1つの Seasonal Work にクラスタ化
4. 2年前・3年前の同時期も取得できるか確認
5. 年ごとの再現性を用いた「例年モノ度」を追加

## Do not prematurely optimize

「Frecencyを使いたい」こと自体を目的にしないでください。

RE:年モノの目的は、**担当者が忘れる前に、組織の過去の仕事が今年の仕事を思い出させること**です。
