# RE:年モノ

**「去年の今ごろ動いていた仕事」を、今年もそろそろ思い出させるためのツールです。**

正式表記: **RE:年モノ**  
読み: **レイネンモノ**  
Repository: `reinen-mono`

## UX

RE:年モノは「一覧を見に行くツール」ではなく、**普段は存在を忘れていてよく、必要な時だけ静かに思い出させるツール**を目指します。

- 通常通知は週1回・最大3件
- 昨年の開始時期まで22日以上あるものは通知しない
- 開始時期を過ぎても今年動いていない場合は、1ファイルにつき年1回だけ強めに通知
- 今年編集が始まったら自動で黙る
- `開く / 今年は不要 / あとで` を用意

詳細: [`docs/UX.md`](docs/UX.md)

## 現在の構成

**Google Sheets のコンテナバインド Apps Script** として動かします。

```text
RE:年モノ スプレッドシート
├─ Config       ← 対象フォルダ・対象ユーザーを複数選択
└─ おすすめ     ← 全候補の裏側台帳
        │
        └─ 必要なものだけ Google Chat へPush
```

対象は担当者個人の閲覧履歴ではなく、Drive Activity API の **EDIT activity** です。

## Config

`RE:年モノ > 初期設定 / Configを作成` を実行すると Config シートが作られます。

### 対象フォルダ

行ごとに次を設定します。

- `有効` チェックボックス
- `表示名`（自動取得）
- `フォルダURL または ID`
- `状態`

複数のフォルダを同時に有効化できます。親フォルダと子フォルダを重複選択しても、同一activityは二重計上しません。

### 対象ユーザー

行ごとに次を設定します。

- `有効` チェックボックス
- `表示名`（自動取得）
- `メールアドレス`
- `Actor ID`（People APIから自動取得）
- `状態`

`全ユーザーを対象` をONにするとユーザー指定を無視します。

Drive Activity API のquery filterではActorを直接指定できないため、日時・EDITで取得後、返却されたKnownUserの `people/...` IDで絞り込みます。

## セットアップ

1. 管理用Googleスプレッドシートを作成
2. **拡張機能 → Apps Script** でコンテナバインドプロジェクトを開く
3. このリポジトリの `.gs` と `appsscript.json` を配置
4. Drive Activity API と People API を有効化
5. `setupReinenMonoWorkbook()` を1回実行
6. ConfigにフォルダURLとユーザーメールを登録してチェック
7. `refreshReinenConfig()` で検証・Actor ID解決
8. `diagnoseHistory()` で過去履歴を確認
9. `runReinenMono()` で候補を更新

メニューからも主要操作を実行できます。

## 検出ロジック

実行日を基準に、次を候補化します。

- 昨年の同日を中心に **±21日**
- その期間に **2日以上** EDIT、または EDIT activity **3件以上**
- 直近 **90日** はEDITなし
- Configで有効なフォルダ配下のみ
- Configで有効なユーザーが編集したactivityのみ（全ユーザーモードを除く）

スコアは説明可能性を優先し、活動日数を強く評価します。

## Google Chat Push

Incoming Webhookを保存:

```javascript
configureChatWebhook('https://chat.googleapis.com/...');
```

疎通確認:

```javascript
sendTestReinenNotification();
```

週次トリガー（デフォルト: 月曜9時ごろ）:

```javascript
setupWeeklyReinenTrigger();
```

`今年は不要 / あとで` を使う場合はWeb Appとしてデプロイします。

## API / 権限上の注意

- Drive Activity API のサーバー側filterは、現在 `time` と `detail.action_detail_case` が中心で、Actor指定はできません。そのためユーザー条件は取得後に適用します。
- ユーザーのメールアドレスからDrive ActivityのKnownUser IDを得るため、People API の社内ディレクトリ検索を使います。
- People API のディレクトリ利用には `directory.readonly` と、組織側のディレクトリ共有設定が必要です。
- Drive Activity API が返す長期履歴は環境で実測してください。

## Product principle

**取りこぼしをゼロにすることより、余計な通知をしないこと。**

人事異動がある組織でも使えるよう、個人の長期ログではなく、業務ファイルそのものを主語にします。
