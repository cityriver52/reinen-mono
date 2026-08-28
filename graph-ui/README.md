# Re:年モノ Graph UI

既存のRe:年モノとは別に動かす、ファイル共起ネットワーク専用のApps Script Webアプリです。

## 目的

表やChat通知ではなく、Google Drive上の業務ファイル同士の関係をObsidianのGraph Viewに近い操作感で眺めることだけに特化します。

- ノード: Google Driveファイル
- エッジ: 同じ対象ユーザーが7日以内に編集した関係
- ノードサイズ: 活動日数・接続数
- ノード色: 共起ネットワークから自動検出したコミュニティ
- 線の強さ: 時間重み付きJaccard × Lift補正

既存の季節性推薦scoreやGoogle Chat通知ロジックとは独立しています。

## 専用スプレッドシート

`Re:年モノ Graph` という専用Google Sheetを使います。

シート構成:

- `Config`: 対象フォルダ・対象ユーザー・比較年度だけを設定
- `GraphCache`: Web UI用JSONキャッシュ。非表示

スプレッドシートIDはコードへ固定しません。コピー先ごとに異なるため、初回にカスタムメニューからそのスプレッドシート自身をApps Scriptへ登録します。

### Config

- A4:A23: 対象DriveフォルダURL / ID
- C4:C23: 対象ユーザーのメールアドレス
- E4: 比較年度。空欄なら1年前の今日が属する年度を自動設定

B列とD列は解決したフォルダ名・ユーザー表示名を自動記入します。

## 初回セットアップ

1. `Re:年モノ Graph` スプレッドシートに `graph-ui/` のApps Scriptコードを配置する
2. スプレッドシートを再読み込みする
3. A列・C列（必要ならE4）を入力する
4. スプレッドシート上部メニューから `Re:年モノ Graph > ① このスプシをGraphに接続` を実行する
5. 初回権限確認を許可する
6. B列のフォルダ名、D列の表示名が自動入力されることを確認する
7. 必要なら `② Configを検証・自動欄を更新` で再検証する
8. Webアプリとしてデプロイする

Webアプリ実行時は「アクティブなスプレッドシート」という概念がないため、初回接続時にScript PropertiesへそのスプレッドシートIDを保存します。これによりコピー先でも元テンプレートのIDへ誤接続しません。

## UI

Webアプリはフルスクリーンのダークキャンバスです。

- ドラッグ（空白）: パン
- ドラッグ（ノード）: ノード移動
- マウスホイール: ズーム
- ノードクリック: 近傍だけを強調し詳細パネルを開く
- ノードダブルクリック: Driveファイルを開く
- 検索: ファイル名からノードへ移動
- 「関係の強さ」: 弱いエッジを非表示
- Fit: 全体表示
- Refresh: Drive Activity APIから比較年度を再集計

## アルゴリズム

比較年度は4月1日〜翌3月31日。

Drive Activity API v2の`EDIT`を対象フォルダ配下から取得し、Configで指定したactorだけを残します。

2ファイルについて同じactorの活動日を比較し、7日以内の活動日を1対1でgreedy matchingします。

時間差は半減期3日で減衰します。

```text
weight = 0.5 ^ (gap_days / 3)
```

基本指標は時間重み付きJaccard。

```text
weighted_jaccard
  = weighted_matches
  / (active_days_A + active_days_B - weighted_matches)
```

年中頻繁に使うファイルが何にでも結び付くのを抑えるため、±7日の基礎カバー率からLiftを計算します。

```text
edge_score = weighted_jaccard * clamp(lift, 0, 3)
```

初期条件:

- 近接2回以上
- edge score 0.08以上
- 最大250ノード
- 最大1500エッジ

関連ペア候補は全ファイルの総当たりではなく、actorごとの活動日を時系列に並べた7日スライディングウィンドウから生成します。

## コミュニティ

エッジ重みを使った軽量なlabel propagationを10回まで実行し、まとまりを自動検出します。コミュニティはUI上のノード色にだけ使い、推薦scoreには使用しません。

## キャッシュ

Graph payloadは`GraphCache`へJSONを分割保存し、24時間再利用します。

Configの対象フォルダ・対象ユーザー・比較年度が変わるとSHA-256 fingerprintが変わるため、自動的にキャッシュを無効化します。比較年度を空欄にしている場合も、4月の年度切替で実効年度が変われば自動的に無効化されます。

Refreshボタンはキャッシュを無視して再計算します。

## Apps Scriptプロジェクト

`graph-ui/` は既存Re:年モノのApps Scriptとは別プロジェクトとして配置してください。

必要なAdvanced Services:

- Drive Activity API v2
- Drive API v3
- People API v1

`appsscript.json`に必要なサービスとOAuth scopeを記載済みです。

Webアプリとしてデプロイすると`Index.html`がUIになります。実行ユーザーはDrive Activity / People Directory / 対象Driveファイルを参照できる必要があります。

## ファイル構成

```text
graph-ui/
├─ appsscript.json
├─ Config.gs       専用Sheet / 対象範囲 / 年度 / スプシ自己登録
├─ Activity.gs     Drive Activity取得
├─ Model.gs        共起・Lift・コミュニティ
├─ Cache.gs        GraphCache
├─ Web.gs          WebアプリAPI / Drive詳細
├─ Index.html      UIシェル
├─ Styles.html     UIスタイル
├─ Layout.html     浮遊パネルのレイアウト補正
├─ Refresh.html    再計算後の安全な再読込
└─ App.html        Canvas描画・物理演算・操作
```
