# Performance

## 現在の取得戦略

Re:年モノは、対象フォルダ配下の昨年度1年分のDrive Activityを毎回総なめしない。

### Phase A: 季節ウィンドウだけ広く取得

対象フォルダごとに、1年前の今日を中心とする `±SEASONAL_WINDOW_DAYS`（デフォルト±21日、通常43日）の `EDIT` activityだけを取得する。

ここで次の最低活動量を満たしたファイルだけを候補にする。

- `MIN_SEASONAL_ACTIVE_DAYS` 以上の活動日
- または `MIN_SEASONAL_EDIT_ACTIVITIES` 以上のEDIT activity

### Phase B: 候補ファイルだけ年度背景を取得

Phase Aで候補になったFile IDについてのみ、Drive Activity APIの `itemName=items/FILE_ID` を使い、比較年度（4/1〜翌3/31）のうち季節ウィンドウ以外を照会する。

年度背景は各ファイルで独立しているため、Apps Scriptの `UrlFetchApp.fetchAll()` で複数ファイルを並列取得する。

```text
対象フォルダ
    ↓
今頃43日だけ検索
    ↓
季節候補 30ファイル
    ↓
30ファイルだけ年度背景を並列照会
    ↓
seasonal_lift計算
```

旧方式は対象フォルダの年度1年分を全取得していたため、年中編集が多い大規模フォルダほどページング量が増えていた。

## 精度

候補判定の意味は変更しない。

- 比較単位: 年度（4/1〜翌3/31）
- 季節ウィンドウ: 1年前の今日±21日（デフォルト）
- `seasonal_lift`: 季節ウィンドウの活動日密度 / 年度内その他期間の活動日密度

取得順序だけを変えている。

## 計測

`runReinenMono()` と `diagnoseHistory()` の戻り値に `elapsedSeconds` を含める。

実行ログには次も出力する。

- 季節ウィンドウで見つかったファイル数
- 年度背景まで調べる候補ファイル数
- 季節ウィンドウ検索の経過秒数
- seasonality query全体の経過秒数

## まだ重い場合

次に疑う箇所は以下。

1. 季節ウィンドウ43日だけでもActivity量が非常に多い巨大フォルダ
2. 季節候補ファイル自体が数百〜数千件になるケース
3. 上位候補の `folder_path` 解決（Drive APIで親階層を辿る処理）

必要になれば、候補パスの永続キャッシュ、対象フォルダの分割、Activity集計キャッシュを次段階で検討する。
