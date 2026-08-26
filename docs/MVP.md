# Re:年モノ MVP 設計

## 目的

毎年繰り返す仕事を、担当者個人の記憶ではなく Google Drive 上のファイル活動から再発見する。

現在の主眼は、**昨年同時期のactivityだけから有用な候補を作り、静かなPushで提示すること**。

## データフロー

```text
Google Drive Activity API / EDIT
              ↓
     昨年同時期 ±21日
              ↓
 ConfigのFolder / Actor条件
              ↓
       File ID単位で集計
              ↓
        候補スコアリング
          ┌───┴────┐
          ↓        ↓
        Data      通知判定 ← State
                    ↓
                Google Chat
```

## 候補判定

デフォルトでは実行日の1年前を中心に±21日を見る。

次のどちらかを満たせば候補:

- 2日以上にわたって EDIT activity が存在
- EDIT activity が3件以上

**直近90日や今年の稼働有無は条件に含めない。**

## スコア

```text
score = 昨年の活動日数 × 100
      + min(昨年のEDIT activity件数, 50) × 5
```

活動日数を強く評価し、単日に大量編集されたファイルだけが上位を独占しにくくする。

## データ管理

### Config

ユーザー入力はフォルダURL / IDとメールアドレスだけ。その他は自動解決する。

### Data

毎回再生成する内部データ。タイトル・キャッチコピー等は置かず1行目からヘッダー。

### State

継続する通知状態を表管理する。

- `skip_this_year`
- `snooze_until`
- `overdue_sent_at`
- `updated_at`

ファイルごとの状態をScript Propertiesには保存しない。

### Script Properties

Webhook URL、Web App URL、トリガー時刻、閾値などの静的運用設定だけを持つ。初回セットアップで必要キーを全部作成し、その後はProject Settingsから直接編集する。

## Push UX

- まだ早い: 通知しない
- そろそろ: 週1回、最大3件
- 去年ならもう始まっていた: 1ファイルにつき暦年1回の強通知
- 今年は不要: Stateでその年を抑制
- あとで: Stateでスヌーズ

## 現在やらないこと

- 直近90日休眠フィルタ
- 今年着手済みかの自動判定
- LLMによる本文理解
- 個人嗜好学習
- 2年以上を使った周期性判定
- 自動業務クラスタリング

## 次段階

1. 実運用でprecisionと通知量を評価
2. 関連ファイルをSeasonal Workへクラスタ化
3. 2〜3年前を使った年次再現性スコアを検討
