# Re:年モノ MVP 設計

## 目的

毎年繰り返す仕事を、担当者個人の記憶ではなく Google Drive 上のファイル活動から再発見する。

現在の主眼は、**昨年の中でも今ごろに活動が偏っていたファイル**を見つけ、静かなPushで提示すること。

## データフロー

```text
Google Drive Activity API / EDIT
              ↓
比較期間 約365日
              ↓
ConfigのFolder / Actor条件
              ↓
File ID単位で集計
      ┌──────────────┐
      │ 今ごろ ±21日 │
      │ その他期間   │
      └──────┬───────┘
             ↓
       季節性を評価
          ┌──┴────┐
          ↓       ↓
        Data     通知判定 ← State
                   ↓
               Google Chat
```

## 候補判定

### 季節ウィンドウ

実行日の1年前を中心に±21日。デフォルト43日間。

この期間に次のどちらかを満たすこと:

- 2日以上の活動日
- EDIT activity 3件以上

### 他時期との比較

1年前の今日を中心とした365日間を比較期間とし、季節ウィンドウ以外を「他時期」とする。

```text
seasonal_rate = 季節ウィンドウ活動日数 / 季節ウィンドウ日数
background_rate = 他時期活動日数 / 他時期日数
seasonal_lift = seasonal_rate / background_rate
```

他時期が0日のときは無限大にせず、比較期間で1日活動した相当の下限値を使う。

デフォルトでは:

- `seasonal_lift >= 2.0`
- `seasonal_activity_share >= 0.30`

を両方要求する。

`seasonal_activity_share` は比較期間の全活動日のうち季節ウィンドウに含まれる割合。

これにより、年中継続して使うファイルを除外しやすくする。

**直近90日や今年の稼働有無は条件に含めない。**

## スコア

```text
base = seasonal_active_days × 100
     + min(seasonal_edit_activities, 50) × 5

score = base × min(seasonal_lift, 5)
```

活動量だけでなく「その時期らしさ」も順位へ反映する。

## フォルダ階層

候補に絞り込んだ後、Driveの親フォルダをルート方向へ辿り、`folder_path` として保存する。

例:

```text
共有ドライブ / ○○部 / ○○課 / 年次業務 / 2025
```

ファイル名が曖昧でも業務文脈を判断しやすくするため、Chatカードにも表示する。

## データ管理

### Config

ユーザー入力はフォルダURL / IDとメールアドレスだけ。その他は自動解決する。

### Data

毎回再生成する内部データ。主な季節性列:

- `folder_path`
- `last_year_active_days`
- `other_period_active_days`
- `seasonal_lift`
- `seasonal_activity_share`

### State

継続する通知状態を表管理する。

- `skip_this_year`
- `snooze_until`
- `overdue_sent_at`
- `updated_at`

### Script Properties

Webhook URL、Web App URL、トリガー時刻、季節性閾値などの静的運用設定だけを持つ。

## Push UX

- まだ早い: 通知しない
- そろそろ: 週1回、最大3件
- 開始時期超過: 1ファイルにつき暦年1回
- 今年は不要: Stateでその年を抑制
- あとで: Stateでスヌーズ
- Chat投稿はcard-only
- 集計へのリンク文言は `集計スプシを見る`

## 現在やらないこと

- 直近90日休眠フィルタ
- 今年着手済みかの自動判定
- LLMによる本文理解
- 個人嗜好学習
- 2年以上を使った周期性判定
- 自動業務クラスタリング

## 次段階

1. `MIN_SEASONAL_LIFT` / `MIN_SEASONAL_ACTIVITY_SHARE` を実データで調整
2. 実運用でprecisionと通知量を評価
3. 関連ファイルをSeasonal Workへクラスタ化
4. 2〜3年前を使った年次再現性スコアを検討
