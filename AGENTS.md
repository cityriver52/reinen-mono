# AGENTS.md

## Project

**RE:年モノ（レイネンモノ）** は、Google Drive の活動履歴から「去年の今ごろ使っていたが、今年はまだ動いていないファイル」を再提示する業務支援ツールです。

## Product principle

このプロジェクトの主語は **ユーザー個人ではなく、業務ファイル** です。

人事異動がある組織で使うため、個人の閲覧履歴や長期的な個人プロファイルへの依存を避けてください。

## Current MVP

- Runtime: Google Apps Script (V8)
- Data source: Google Drive Activity API v2
- Main signal: `EDIT` activity
- Identity: Google Drive File ID
- Seasonal window: one year ago ±21 days
- Dormancy window: recent 90 days
- Output: Google Sheets
- Output folder: Google Drive `RE:年モノ`

## Critical unknown

Drive Activity API が実環境で約1年前の activity を十分に返すかは未検証です。

長期保持を前提に機能を増やす前に `diagnoseHistory()` の実測結果を確認してください。

0件だった場合も即座に「保持されていない」と断定せず、当時確実に編集した既知ファイルで照合してください。

## Guardrails

1. 担当者名・メールアドレスを推薦ロジックの主キーにしない。
2. `File ID` を継続的な業務資産の識別子として扱う。
3. MVP段階では LLM / AI を追加しない。まず履歴シグナルだけの有用性を検証する。
4. スコアは説明可能に保つ。複雑化する場合は `docs/MVP.md` に式と理由を書く。
5. Google Drive Activity API の保持期間をコードや文書で断定しない。
6. 出力ファイルはユーザー指定の `RE:年モノ` Driveフォルダへ保存する。
7. 共有ドライブ / My Drive の違いを無視しない。対象部署フォルダがある場合は `configureSourceFolder()` で明示する。
8. 個人情報やファイル本文を不要に保存しない。MVPではタイトル、File ID、activity日時程度に留める。

## Naming

- Product display name: `RE:年モノ`
- Reading: `レイネンモノ`
- Repository / code identifier: `reinen-mono`

将来 mono 系の機能名を使う場合も、意味のある機能区分として使い、ダジャレだけで機能を分割しない。

## Preferred next steps

実環境検証が成功した場合の優先順位:

1. 既知の例年モノを使ってprecisionを評価
2. 2年前・3年前の同時期も取得できるか確認
3. 年ごとの再現性を用いた「例年モノ度」を追加
4. 年間タイムライン / ヒートマップ可視化
5. 週次リマインド導線
6. ユーザーが「役に立った / 違う」を返せるフィードバック

## Do not prematurely optimize

「Frecencyを使いたい」こと自体を目的にしないでください。

RE:年モノの目的は、**担当者が忘れる前に、組織の過去の仕事が今年の仕事を思い出させること**です。
