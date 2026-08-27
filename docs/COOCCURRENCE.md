# 共起（「一緒に使う」）

Re:年モノでは、季節性とは別の説明軸として、過去の編集履歴から「このファイルと近い日程で一緒に動くファイル」を抽出する。

## 目的

季節性スコアは「今年そろそろ使いそうか」を表す。

共起はその順位を上げ下げするためではなく、候補を見た利用者に対して、同じ業務でまとまって動くファイルを思い出させるための補助情報として使う。

したがって、共起スコアを季節性scoreへ混ぜない。

## 対象データ

- Drive Activity API v2 の `EDIT`
- Configで指定した対象ユーザーのみ
- 比較年度は4月1日〜翌年3月31日
- 季節性候補の年度内履歴を再利用する

追加のDrive Activity API照会は行わない。

複数ユーザーが設定されている場合も、異なるユーザー同士の操作を直接ペアにはしない。同じactorが両方のファイルを編集した日だけを比較する。

## 近接判定

2ファイル A / B について、同じactorの編集日を比較する。

- 7日以内: 共起候補
- 8日以上: 共起とみなさない

同一年度で活動日を時系列に並べ、1つの活動日が大量の相手日と重複カウントされないよう、近い日同士を1対1でgreedy matchingする。

## 時間減衰

近いほど強く評価する。

```text
weight = 0.5 ^ (gap_days / 3)
```

半減期は3日。

例:

- 0日差: 1.00
- 1日差: 約0.79
- 3日差: 0.50
- 6日差: 0.25

## 時間重み付きJaccard

```text
weighted_jaccard
  = weighted_matches
  / (active_days_A + active_days_B - weighted_matches)
```

単純な共起回数ではなく、両ファイルの活動量で正規化する。

これにより、たまたま活動回数が多いファイルだけが上位になることを抑える。

## Lift補正

年中頻繁に使うファイルは、どのファイルの近くにも偶然出現しやすい。

そこでactorごとに、Bの活動日±7日が年度全体の何%を覆うかを「偶然Bの近くになる基礎確率」とする。

Aの活動日のうち実際にBの±7日に入った割合と比較し、方向別Liftを求める。

```text
lift_A_to_B = observed_A_near_B / baseline_B_window_coverage
lift_B_to_A = observed_B_near_A / baseline_A_window_coverage

pair_lift = sqrt(lift_A_to_B * lift_B_to_A)
```

最終共起スコアは:

```text
cooccurrence_score
  = weighted_jaccard * min(max(pair_lift, 0), 3)
```

Liftが1未満なら、通年・高頻度ファイルとの偶然の近接を減点する。Liftが極端に大きくなっても最大3倍までに抑え、Jaccardを主役にする。

## 採用条件

初期値:

- 7日以内の1対1近接が2回以上
- `cooccurrence_score >= 0.08`
- 各ファイルにつき上位3件まで

## 表示

`Data` に以下を保存する。

- `related_files`
- `cooccurrence_score`
- `cooccurrence_matches`
- `cooccurrence_lift`
- `cooccurrence_avg_gap_days`
- `related_file_ids`

`View` では「一緒に使う」列として、例:

```text
通知文.docx（近接3回・平均1.7日差）
決裁メモ.docx（近接2回・平均3日差）
```

のように表示する。

## 非目標

- 共起を季節性scoreへ混ぜてブラックボックス化しない
- 現年度の未着手判定には使わない
- ファイル本文を保存・解析しない
- actorをまたいだ疑似的な共起を作らない

将来、現在年度の「Aを触った直後にBを推薦する」リアルタイム寄りの機能を追加する場合も、この年度共起グラフを基礎データとして利用できる。
