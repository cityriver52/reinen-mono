# AGENTS.md

## Project

**RE:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ使っていたが、今年はまだ動いていないファイル」を再提示する業務支援ツールです。

## Product principle

このプロジェクトの主語は **ユーザー個人ではなく、業務ファイル** です。

人事異動がある組織で使うため、個人の閲覧履歴や長期的な個人プロファイルへの依存を避けてください。

もう一つの重要原則は **静かなPush** です。

ユーザーに一覧を定期巡回させず、必要な時だけ少量を通知します。RE:年モノでは recall より precision を優先し、余計な通知をしないことを品質として扱います。

## Current MVP

- Runtime: Google Apps Script (V8)
- Data source: Google Drive Activity API v2
- Main signal: `EDIT` activity
- Identity: Google Drive File ID
- Seasonal window: one year ago ±21 days
- Dormancy window: recent 90 days
- Ledger: Google Sheets
- Primary UX: Google Chat weekly push
- Weekly digest: max 3 items
- Upcoming window: 0〜21 days before last year's start timing
- Overdue alert: once per file per calendar year, max 1 per run
- User controls: open / skip this year / snooze 14 days
- Output folder: Google Drive `RE:年モノ`

## UX hierarchy

1. **まだ早い** → 通知しない
2. **そろそろ** → 週1回のダイジェスト、最大3件
3. **去年ならもう始まっている** → 今年1回だけ強めに通知
4. **今年編集が始まった** → 自動的に黙る

Sheets は全候補を保持する裏側の台帳であり、主UIではありません。

詳細は `docs/UX.md` を参照してください。

## Guardrails

1. 担当者名・メールアドレスを推薦ロジックの主キーにしない。
2. `File ID` を継続的な業務資産の識別子として扱う。
3. MVP段階では LLM / AI を追加しない。まず履歴シグナルと通知UXの有用性を検証する。
4. スコアは説明可能に保つ。複雑化する場合は `docs/MVP.md` に式と理由を書く。
5. Google Drive Activity API の保持期間をコードや文書で断定しない。
6. 出力ファイルはユーザー指定の `RE:年モノ` Driveフォルダへ保存する。
7. 共有ドライブ / My Drive の違いを無視しない。対象部署フォルダがある場合は `configureSourceFolder()` で明示する。
8. 個人情報やファイル本文を不要に保存しない。MVPではタイトル、File ID、activity日時程度に留める。
9. 通知数を増やして取りこぼしを減らそうとしない。まず false positive と通知疲れを抑える。
10. ユーザーに「完了」操作を要求しない。今年の編集開始を可能な限り自動停止シグナルにする。
11. Webhook URL や秘密値をGitにコミットしない。Script Properties に保存する。

## Google Chat architecture

MVPは Incoming Webhook を送信経路に使います。

Webhook は一方向なので、`今年は不要` と `あとで` はChat interaction eventではなく、カードの `openLink` から Apps Script Web App を開いて処理します。

本格的な対話型 Chat app / Marketplace app は、MVPで価値が確認できるまで導入しません。

## Naming

- Product display name: `RE:年モノ`
- Reading: `レイネンモノ`
- Repository / code identifier: `reinen-mono`

将来 mono 系の機能名を使う場合も、意味のある機能区分として使い、ダジャレだけで機能を分割しない。

## Preferred next steps

1. 実運用で週次通知のprecisionと通知量を評価
2. 「今年は不要」「あとで」の利用状況を見て閾値を調整
3. 複数ファイルを1つの Seasonal Work にクラスタ化
4. 2年前・3年前の同時期も取得できるか確認
5. 年ごとの再現性を用いた「例年モノ度」を追加
6. 年間タイムライン / ヒートマップ可視化

## Do not prematurely optimize

「Frecencyを使いたい」こと自体を目的にしないでください。

RE:年モノの目的は、**担当者が忘れる前に、組織の過去の仕事が今年の仕事を思い出させること**です。
