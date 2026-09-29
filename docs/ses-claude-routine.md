# SESバッチを Claude の環境（ルーティン）で動かす — 検討と手順

GitHub Actions ＋ サービスアカウント（DWD）の代わりに、Claude Code のクラウド環境で定期実行（ルーティン）する案。
このブランチ（`claude/ses-claude-env-routine`）は検討用の試作。

## 結論

- **可能**。バッチのコード（収集 → 抽出 → 照合 → 案件スプレッドシート → 営業リスト）はそのまま、この環境の中で動く。
- 認証を **本人のGoogleアカウントのOAuth（リフレッシュトークン）1つ** にまとめる。
  - サービスアカウント・DWD・シートの共有・GitHub Secrets は不要。
  - Gmail は `SES` ラベルのメールだけを **読み取り専用** で読む。
  - スプレッドシートは本人として読み書きする。要員リストも営業リストも本人のファイルなので、共有の手間がない。
- 営業リストは Sheets API で書くため、**色分け・プルダウン・要員別タブがそのまま付く**。

## この環境で確かめたこと

| 項目 | 結果 | 影響 |
|---|---|---|
| sheets / gmail / oauth2.googleapis.com | 到達できる（HTTPS） | Sheets・Gmail API を直接呼べる |
| api.anthropic.com | 到達できる | 抽出・判定は今までどおり API で行う |
| IMAP（993番ポート） | **閉じている** | Xserver の IMAP（既定の `MAIL_PROVIDER=xserver`）は使えない → Gmail 経由にする |
| コンテナの寿命 | 実行ごとに作り直し | 処理済みID・状態はローカルでなく案件スプレッドシート（`DB_PROVIDER=sheets`）に置く（対応済みの仕組み） |

### 採らなかった案

- **Gmail コネクタ（MCP）でメールを読む**：1日数千通の本文を会話に読み込むことになり、時間・使用量が見合わない。
  このため、コネクタはこれまでどおり仮ランや確認にだけ使う。
- **Drive コネクタで営業リストを作る**：ファイルを新規作成することしかできず、中身の更新も色付けもできない。

## 仕組み

```
ルーティン（平日 10:00 / 14:00 など）
  └ 新しいセッション → リポジトリを clone → npm ci → npm run build → npm run ses:preflight → npm run ses
       ├ Gmail API（本人のOAuth・読み取り専用・label:SES）で新着を収集
       ├ Claude API で案件を抽出（Haiku）・判定（Sonnet）
       ├ 案件スプレッドシート（DB）へ保存・処理済みIDも保存
       ├ 要員リスト（本人のシート）を読み、プロパー候補を照合
       └ 営業リスト（本人のシート）を「全体」＋要員別タブ・色分けで書き直す
  └ セッションは件数だけを報告（氏名・案件名は会話に出さない）
```

OAuth モードでは **下書きの作成とサマリメールの送信はしない**（トークンが読み取り専用のため）。結果は営業リストで確認する。

## 設定（環境の変数）

クラウド環境の設定（セッションのタイトルバーの環境メニュー → Edit）で、環境変数として登録する。
**キー・トークンをチャットに貼らないこと。**

| 変数 | 値 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API のキー（ZDR 推奨） |
| `MAIL_PROVIDER` | `gmail` |
| `SES_TARGET_GMAIL` | 本人の Gmail アドレス |
| `SES_GMAIL_LABEL` | `SES` |
| `SES_GOOGLE_OAUTH_CLIENT_ID` / `SES_GOOGLE_OAUTH_CLIENT_SECRET` | 下の手順で作る OAuth クライアント |
| `SES_GOOGLE_OAUTH_REFRESH_TOKEN` | 下の手順で得るリフレッシュトークン |
| `DB_PROVIDER` | `sheets` |
| `SHEETS_DB_SPREADSHEET_ID` | 案件スプレッドシート（空のシートを作ってURL） |
| `PROPER_ROSTER_SPREADSHEET_ID` | 要員リストのURL |
| `PROPER_SALES_SPREADSHEET_ID` | 営業リストのURL（今使っているシートをそのまま指定。毎回同じシートを更新する） |
| `SES_PRICING_POLICY_JSON` | 粗利下限・交渉幅（GitHub Actions と同じ値） |

### OAuth のリフレッシュトークンを得る（初回だけ・5分程度）

1. Google Cloud コンソールでプロジェクトを作り、**Gmail API** と **Google Sheets API** を有効にする。
2. 「OAuth 同意画面」を「外部」で作り、テストユーザーに本人を追加する。
   - その後、**公開ステータスを「本番環境」にする**。「テスト」のままだと、トークンが7日で切れる。
   - 未確認アプリの警告が出るが、本人だけが使うので問題ない。
3. 「認証情報」→「OAuth クライアント ID」→ 種類「ウェブアプリケーション」を選ぶ。
   - 承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground` を追加する。
4. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) で次の順に操作する。
   - 右上の歯車 →「Use your own OAuth credentials」に、3 のクライアント ID とシークレットを入れる。
   - スコープに次の2つを入力して「Authorize APIs」を押し、本人のアカウントで許可する。
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/spreadsheets`
   - 「Exchange authorization code for tokens」を押し、表示された **Refresh token** を環境変数に登録する。

## ルーティン

環境変数を登録したあと、Claude にルーティンの作成を依頼する（平日 10:00 / 14:00 JST、実行ごとに新しいセッション）。
ルーティンの指示の案：

> executive-clone-ai を `claude/ses-claude-env-routine` で開き、`npm ci && npm run build && npm run ses:preflight && npm run ses` を実行する。
> 報告は件数（収集・抽出・候補・営業リストの行数）と警告・失敗の要点だけにする。
> 氏名・案件名・メール本文は会話に書かない。コミット・プッシュはしない。

## 費用・制約

- **Claude API**：これまでの見積もりと同じ（案件だけの抽出で月 約3.5万円、プロンプトのキャッシュで約2.2万円）。
- **ルーティンのセッション**：コマンドを実行して件数を報告するだけなので、使用量は小さい。
- **1回の処理時間**：既定では1回20分まで。残りは次回に続きから処理する。
  - 朝のピークに追いつかなければ、実行回数を増やす（例：平日の毎時）。
- **下書きとサマリメール**：この方式では作らない。必要になったら、トークンに `gmail.compose` を足して対応する。
  - ただし、sales@ として送るには Gmail の「別のアドレスから送信」の設定が別に要る。
- **トークンの権限**：本人の Gmail 全体を読める権限になる。
  - コードは `SES_GMAIL_LABEL` のラベルのメールだけを検索し、ラベルが未設定なら収集を止める。
  - トークンは環境変数だけに置き、ログには出さない。

## このブランチの変更

- `SES_GOOGLE_OAUTH_*`：本人の OAuth。Gmail（`SES_TARGET_GMAIL` のメールボックスだけ）とスプレッドシートに使う。
  - サービスアカウントの鍵があれば、スプレッドシートにはそちらを優先する。
- `SES_GMAIL_LABEL`：収集をラベルで絞る。OAuth モードでは必須。
- OAuth モードでは、下書き・送信を無効にする。
- 事前チェック（`ses:preflight`）を OAuth モードに対応させた。サービスアカウント・`SES_ALLOWED_SENDERS` を必須にしない。
- テスト：`ses:eval:rules` に OAuth モードの確認5件を追加した。
