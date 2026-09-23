# SES案件・要員マッチングシステム 導入マニュアル

このドキュメントは、SESマッチング機能を**ゼロから本番稼働させるまで**の手順書です。
まず外部接続なしの `demo` で動作を確認し、その後に実データへ接続する流れを推奨します。

- 設計の詳細: `docs/ses-matching-requirements.md` / `ses-matching-basic-design.md` / `ses-matching-detailed-design.md`
- 追加機能（交渉提案・バンド分け・全員に返信・メーラー切替）: `docs/ses-matching-addendum.md`
- **GitHub Actions で平日10:00／14:00に自動実行する本番導入（サーバー不要・非エンジニア向け）: `docs/ses-deploy-github-actions.md`**
  （必要なアカウント、スプレッドシートの共有、Secrets／Variables の一覧、メール量の測定、導入チェックリスト）

---

## 0. 全体像（何が起きるか）

```
sales@（共有メーリス）── 収集 ─→ 抽出(Haiku) ─→ マッチング(ルール＋Sonnet最終判定)
                                                      │
                          ┌───────────────────────────┤
                          ▼                           ▼
                    Notion（案件/要員/マッチDB）    確認UI（レビュー・下書き・ステータス）
                                                      │
                                             「全員に返信」下書き（営業個人アドレス）
```

- **1日2回のバッチ**で共有メーリスを巡回し、粗利下限（既定10万円/月）を満たすペアを検出。
- 結果は **Notion** に保存され、**サマリメール**が届き、**確認UI**でレビューできます。
- 紹介文は**「全員に返信」の下書き**として用意され、**担当営業個人の会社アドレス**から送る形になります（送信自体は人が最終確認）。

---

## 1. 前提条件（必要なもの）

| 区分 | 必要なもの | 備考 |
| --- | --- | --- |
| 実行環境 | Node.js 20+ / npm | ESM・TypeScript |
| LLM | Anthropic APIキー | **ZDR（ゼロデータリテンション）キー強く推奨**（要員情報は個人情報） |
| メール | 共有メーリス `sales@`（Xserver）または Google Workspace | 既定は Xserver（IMAP/SMTP） |
| DB | Notion ワークスペース＋内部インテグレーション | 案件/要員/マッチ ほか計6DB（後述） |

> APIキーが無くても `demo` は完全オフラインで動きます。まずはそちらで挙動確認できます。

---

## 2. インストール

```bash
git clone <このリポジトリ>
cd executive-clone-ai
npm install
npm run setup     # .env.local の雛形を生成
npm run build     # TypeScriptビルド確認（成功すればOK）
```

---

## 3. まず demo で動かす（外部接続なし）

APIキー等の設定前に、fixtureデータで一連の流れを確認します。

```bash
npm run ses:demo            # 収集→抽出→マッチング→サマリ（コンソール出力）
npm run ses:own-match:demo  # 自社社員→合いそうな案件の突合
npm run ses:web:demo        # 確認UI（http://127.0.0.1:8788）
```

`ses:demo` で「成立候補／交渉提案／参考提案／要確認」が表示され、
`data/ses-demo/` に下書きテキストが生成されれば正常です。

> demo は `DEMO_MODE=true`（または手元で `ANTHROPIC_API_KEY` 未設定）で有効になり、
> メール・Notion・LLMいずれも呼びません。本番設定を汚しません（成果は `data/ses-demo/`、確認UI用は `data/ses-demo/review/`）。
> ただし **CI（GitHub Actions）上や `SES_REQUIRE_LIVE=true` では、鍵が無いとdemoに切り替えずエラー終了**します
> （Secretsの渡し忘れで fixture の結果を「成功」として出さないため）。

---

## 4. データ保存先の準備（Notion または スプレッドシート）

保存先は `DB_PROVIDER` で選べます。**Notion（既定・4-1〜4-6）** か **Googleスプレッドシート（4-7）** のどちらか一方を準備すればOKです。
スプシ派のチーム・Notionの追加課金を避けたい場合は 4-7 のスプレッドシート方式が手軽です（DB手作成が不要）。

Notion を使う場合: 内部インテグレーションを作成し、対象データベースに**コネクト（共有）**します。
各DBは以下のプロパティ名で作成してください（**名前は完全一致**が必要です）。

### 4-1. 案件DB（`NOTION_PROJECT_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| 案件名 | タイトル |
| 必須スキル / 尚可スキル | マルチセレクト |
| 単金下限 / 単金上限 | 数値 |
| **案件ID** / 勤務地 / 開始時期 / 商流メモ / 営業元会社 / 営業元担当 / 営業元メール / 元メールID / **返信メタ** | テキスト |
| リモート / ステータス | セレクト |
| 受信日 / **開始日** | 日付 |

> **返信メタ**は「全員に返信」のスレッド情報（元メールの宛先・Message-ID）を保持する内部用プロパティです。
> これが無いと `--match-only` 実行時の下書きがスレッド返信になりません。**開始日**は時期マッチ判定に使います。
> **案件ID / 要員ID / マッチID** は再実行で重複ページを作らないための安定IDです（案件ID×要員IDでマッチIDが決まる）。
> 無ければバッチが初回に自動で追加します（インテグレーションにDBの編集権限が必要）。

### 4-2. 要員DB（`NOTION_ENGINEER_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| 表示名 | タイトル |
| スキル | マルチセレクト |
| 経験年数 / 希望単金 | 数値 |
| **要員ID** / 居住地 / 営業元 / 元メールID / **返信メタ** | テキスト |
| リモート希望 / ステータス | セレクト |
| 受信日 / 稼働開始可能日 | 日付 |

### 4-3. マッチ結果DB（`NOTION_MATCH_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| マッチ名 | タイトル |
| 粗利額 / 適合スコア | 数値 |
| **マッチID** / 判定根拠 / 案件側下書きURL / 要員側下書きURL | テキスト |
| ステータス | セレクト |
| 検出日時 | 日付 |
| 案件 / 要員 | リレーション（案件DB / 要員DB へ） |

### 4-4. 自社社員DB（`NOTION_OWN_ENGINEER_DB_ID`・任意）
| プロパティ | 型 | 備考 |
| --- | --- | --- |
| 表示名 | タイトル | |
| スキル | マルチセレクト | |
| 経験年数 / **必要案件単価** | 数値 | 必要案件単価＝この社員に付けたい案件単金の下限 |
| 居住地 | テキスト | |
| リモート希望 / ステータス | セレクト | ステータス`稼働可`のみ突合対象 |
| 稼働可能日 | 日付 | |

### 4-5. フィードバックDB（`NOTION_FEEDBACK_DB_ID`・任意）
| プロパティ | 型 |
| --- | --- |
| マッチ | タイトル |
| 元マッチID / メモ / 評価者 | テキスト |
| 評価 / バンド | セレクト |
| 日時 | 日付 |

### 4-6. スキル同義辞書DB（`NOTION_SKILL_EQUIV_DB_ID`・任意）
| プロパティ | 型 |
| --- | --- |
| スキルA | タイトル |
| スキルB | テキスト |

> DB IDは各DBのURLに含まれる32桁の英数字です。起動時に自動で `data_source_id` に解決されます。
> 4-4〜4-6は未設定でも縮退動作します（自社社員突合・学習機能がスキップされるだけ）。

### 4-7. 【代替】Googleスプレッドシートを保存先にする（`DB_PROVIDER=sheets`）

Notionのかわりに、**1つのスプレッドシート**をデータ保存先にできます。
データタブ（案件／要員／マッチ／自社社員／評価／スキル同義／プロパー候補）と状態タブ（処理済みメール／_状態）、
**ヘッダー行は初回実行時に自動生成**されるため、Notionのような手動DB作成は不要です。
営業チームが普段のスプシ操作でソート・フィルタできる利点もあります（並べ替え後もバッチは行位置を検証してから更新します）。

**手順**:
1. Googleドライブで**空のスプレッドシートを1つ作成**し、URLの `/d/` と `/edit` の間のIDを控える
2. そのシートを**サービスアカウントのメールアドレス（JSON鍵の `client_email`）に「編集者」として共有**する
   （DWD＝ドメイン全体委任は不要。個人Googleアカウントのシートでも可）
3. `.env.local`（GitHub Actions では Secrets）に設定:
```
DB_PROVIDER=sheets
SHEETS_DB_SPREADSHEET_ID=<手順1のID>
GOOGLE_SA_KEY_JSON={"type":"service_account",...}   # JSON鍵の中身を丸ごと（または GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY）
```

- 特定ユーザーとして読み書きしたい場合のみ `SHEETS_DB_IMPERSONATE=<ユーザーのメール>`（要DWD＋`spreadsheets` スコープ）
- **処理済みメールID（「処理済みメール」タブ）と隔離リスト（「_状態」タブ）もこのシートに保存**されるため、
  毎回クリーンな環境で動く GitHub Actions 等でも二重処理・無限再試行を防げます
- 既存シートのヘッダーが古い（末尾の列が足りない）場合は自動で列を追記します。列の並びが違う場合は警告のみで上書きしません

- Notion用の `NOTION_*_DB_ID` は不要になります（`NOTION_TOKEN` も SES用途では不要）
- マッチのステータス更新（確認UI）・評価・同義辞書もすべて同じシートに読み書きされます

#### 担当者メール列による下書き作成（常駐UIなしの運用）

Sheets運用の本番では、確認UIを常駐させなくても「担当営業本人のアドレスで全員に返信の下書き」を作れます。
「マッチ」タブの末尾に次の列が自動で追加されます。

| 列 | 書く人 | 内容 |
| --- | --- | --- |
| 担当者メール | 営業 | 送信元にする**自分の会社メールアドレス**（1件のみ。全角で入力しても可） |
| 案件側下書き状態 / 要員側下書き状態 | バッチ（営業も可） | 空欄・`未作成`＝作成待ち／`作成中`／`作成済 YYYY-MM-DD HH:mm`（JST）／`エラー: 理由`／`不要`（文面なし・作らない） |
| 案件側文面 / 要員側文面 | バッチ | To・Cc・件名つきの下書き本文（確認用。書き換えても下書きには反映されません） |
| 下書きデータ | バッチ | 下書き作成に使うJSON（編集しないでください） |

1. バッチが成立候補・交渉提案の文面を用意し、状態を `未作成` にする（参考提案・要確認は `不要`）
2. 営業が文面を確認し、送る行の「担当者メール」に自分のアドレスを入れる（片側だけなら、もう片側の状態を `不要` に）
3. **次回のバッチ（平日10:00／14:00）の最初**に、そのアドレスを From とした「全員に返信」下書きを作成し、状態を `作成済 日時` にする
   （xserver=共有メールボックスの下書きフォルダ／gmail=本人のGmail。送信は本人が内容を確認してから）
4. 失敗した側は `エラー: 理由` になり、**次回バッチで自動的に再試行**します（担当者メールを直せば反映）。
   止めたい場合は状態を `不要` にしてください。`作成済`・`送信済`・`作成中`・`不要` の側には触りません

- `SES_ALLOWED_SENDER_DOMAINS=example.co.jp`（カンマ区切り・完全一致）で送信元に使えるドメインを制限できます。
  シートの編集者なら誰でも任意の From で下書きを作れてしまうため、**本番では設定を推奨**します（確認UIにも適用）
- `作成中` のまま残った行は、作成直後の状態書き戻しに失敗したものです（二重作成を避けるため自動では再作成しません）。
  下書きフォルダを確認し、無ければ状態を空欄に戻してください
- 再検出で同じマッチが保存し直されても、ステータス・担当者メール・状態は保持され、`作成済` 等になった側の文面は固定されます
- メールの下書き作成設定（xserverのIMAP、gmailのサービスアカウント）が未設定の間は依頼を消化せずに残します
- 下書き作成の件数（担当者指定分）と依頼方法はサマリメールに載ります。担当者メール・文面はActionsログに出しません
- `DB_PROVIDER=notion` に戻せばいつでもNotion運用に切替可能（データ移行は手動）

#### プロパー（自社社員）のスキルシート → 案件候補（任意）

自社社員のスキルシートを置いた**Driveフォルダ**と、社員ごとの**管理表「プロパー管理」**を設定すると、
各バッチで「稼働可の社員 × 直近の募集中案件」を突き合わせ、案件スプレッドシートの**「プロパー候補」タブ**に
候補と提案文面（案件の元メールへの全員に返信）を書き出します。

**標準構成（1つのGoogle Workspace・1つのサービスアカウント）**:
1. スキルシート用のDriveフォルダ（共有ドライブ可）を用意し、**サービスアカウントのメールに「閲覧者」**で共有
2. 空のスプレッドシート（管理表）を作成し、**同じサービスアカウントに「編集者」**で共有
3. `.env.local`（GitHub Actions では Secrets）に設定（IDの代わりにURLを貼っても可）:
```
PROPER_SKILLSHEET_FOLDER_ID=<フォルダのID>
PROPER_MASTER_SPREADSHEET_ID=<管理表のID>
```
認証はメインの `GOOGLE_SA_KEY_JSON` をそのまま使います（追加の鍵・DWDは不要）。
管理表は案件スプレッドシート（`SHEETS_DB_SPREADSHEET_ID`）と同じファイルでも構いません（「プロパー管理」タブが追加されます）。

- 対応形式: PDF・Excel（.xlsx/.xls）・Word（.docx）・Googleドキュメント・Googleスプレッドシート（10MBまで。サブフォルダは2階層下まで）。
  .doc 等の未対応形式はサマリメールにファイル名だけ載ります
- 管理表はスキルシート1ファイル＝1行で自動作成されます。**人が入力するのは「必要案件単価」（万円/月）と「稼働状況」（稼働可/アサイン済/対象外）だけ**。
  氏名・提案用表記（イニシャル）・稼働可能日は初回だけ抽出結果で埋まり、以後は人の入力を上書きしません
- スキル・経験年数・居住地・リモート希望は、ファイルが更新されたときだけ抽出し直します（変更のないファイルはLLMを呼びません）。
  1回の抽出は `PROPER_MAX_EXTRACT_PER_RUN`（既定20件）まで。初回に社員が多い場合は数回のバッチで取り込み終わります
- 突合するのは受信から `PROPER_PROJECT_LOOKBACK_DAYS`（既定14日）以内の募集中案件です。必要案件単価が空欄の社員は「要確認」になります
- 「プロパー候補」タブの提案は、マッチと同じく「担当者メール」を入れると次回バッチで下書きになります（案件側のみ）。
  文面は**提案用表記（イニシャル）だけ**を使い、氏名・必要案件単価は書きません（提案用表記が空なら差し込み表記が入ります）
- フォルダから消えたファイルの行は「抽出メモ」が `ファイルが見つかりません` になり、候補探しの対象から外れます（行は消しません）。
  同じ社員の古いスキルシートが残っている場合は、古い行の稼働状況を `対象外` にしてください
- ログには件数だけを出します（氏名・ファイル名・案件名はサマリメールとスプレッドシートのみ）

**別のGoogle Workspaceにフォルダ・管理表がある場合（任意）**: そのテナントで作ったサービスアカウントの鍵を
`PROPER_GOOGLE_SA_KEY_JSON`（または `PROPER_GOOGLE_SA_CLIENT_EMAIL` / `PROPER_GOOGLE_SA_PRIVATE_KEY`）に設定します。
外部アカウント（サービスアカウント）への共有が禁止されている場合は、そのテナントでDWDを設定し
（`drive.readonly` と `spreadsheets` スコープ）、`PROPER_GOOGLE_IMPERSONATE=<閲覧・編集できるユーザー>` を設定します。

---

## 5. メールの準備（プロバイダ切替）

`MAIL_PROVIDER` で収集・下書き・サマリ送信の「口」を切り替えます。会社ドメインの運用に合わせて選択してください。

### 5-A. Xserver（既定・IMAP/SMTP）
会社ドメインを Xserver で運用している場合。共有メーリス `sales@` の認証情報を設定します。

```
MAIL_PROVIDER=xserver
XSERVER_IMAP_HOST=svXXXX.xserver.jp
XSERVER_IMAP_PORT=993
XSERVER_SMTP_HOST=svXXXX.xserver.jp
XSERVER_SMTP_PORT=465
XSERVER_SHARED_USER=sales@yourcompany.co.jp
XSERVER_SHARED_PASS=********
XSERVER_DRAFTS_MAILBOX=Drafts      # サーバにより INBOX.Drafts / 下書き 等
SES_COLLECT_DAYS=7                 # 収集の遡り日数（既定7日。旧名 XSERVER_COLLECT_DAYS も可）
SES_OWN_DOMAINS=yourcompany.co.jp  # 自社ドメイン（ここからのメールは案件・要員として取り込まない）
```

- 収集: `INBOX` を直近 `SES_COLLECT_DAYS` 日で検索し、処理済みメールIDで重複除外（処理済みは本文を取得しない）。
  週末明けの実行や、抽出に失敗したメールの次回以降の再試行が窓から外れないよう広めに取ります。
  1回に抽出するのは新しい順に `SES_MAX_MAILS_PER_RUN`（既定150）件まで（残りは次回）。
- 自己ループ防止: 本バッチ自身の送信元（`XSERVER_SHARED_USER`）・サマリ/修復レポートの件名・`SES_OWN_DOMAINS` からのメールは
  収集しません（営業が共有メーリスをCcに入れた紹介メールやサマリを、案件・要員として取り込み直さないため。件数だけログに出ます）。
  社内の営業が共有メーリスに案件を流す運用なら `SES_COLLECT_OWN_DOMAIN=true`。
- 接続・ログインに失敗した場合は「0件」ではなく**収集失敗としてバッチを異常終了**（終了コード1）にします。
- SMTP を 587（STARTTLS）にする場合も暗号化を必須にしています（STARTTLSを使えないサーバーには送信しません）。
- `npm run doctor` が IMAP ログイン・下書きフォルダの存在・SMTP 認証を実際に確認します（フォルダ名が違えば正しい名前を案内）。
- 下書き: 「全員に返信」MIMEを組み立て、共有の**下書きフォルダに APPEND**。営業は共有下書きを開いて送信。
- `XSERVER_DRAFTS_MAILBOX` はサーバの下書きフォルダ名に合わせてください（不明ならメールソフトで確認）。

### 5-B. Gmail（Google Workspace）
会社ドメインを GWS へ移行した場合。**`MAIL_PROVIDER=gmail` に変えるだけ**で他ロジックは共通です。

```
MAIL_PROVIDER=gmail
SES_TARGET_GMAIL=ses-inbox@yourcompany.co.jp   # SES専用メールボックス（グループではなく実ユーザー）
# ドメイン全体委任(DWD)用のサービスアカウント認証
GOOGLE_SA_KEY_JSON={...}                         # または GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY
```

- **SES専用メールボックス（`SES_TARGET_GMAIL`）としてDWDで収集・サマリ送信**します（経営者の `GOOGLE_TARGET_EMAIL` にはなりすましません）。
  共有メーリス（グループ）を受け取るSES専用ユーザーを用意し、そのアドレスを設定してください。宛先(to:)で絞らないため、BCC・転送で届いたメールも拾います。
- 下書きは**担当営業本人を impersonate** して本人のGmailにスレッド返信として作成します。
- Workspace管理コンソールのDWD登録に必要なスコープは `gmail.readonly`・`gmail.compose`・`gmail.send` の3つだけです
  （呼び出しごとに必要な1つだけを要求します）。
- メール本文のスプレッドシートリンクは**サービスアカウント自身**で読みます（なりすましなし）。
  送り主がサービスアカウントに共有したシート・一般公開のシートだけが読め、読めないリンクは件数だけ記録して無視します。

---

## 6. `.env.local` の設定

`.env.example` を参照し、`.env.local` に必要項目を記載します。**最小構成**は以下です。

```bash
# --- LLM（本番。ZDRキー推奨） ---
ANTHROPIC_API_KEY=sk-ant-...

# --- メール（5章で選んだ側だけ） ---
MAIL_PROVIDER=xserver
XSERVER_IMAP_HOST=...
XSERVER_SHARED_USER=sales@yourcompany.co.jp
XSERVER_SHARED_PASS=...

# --- 通知先 ---
SES_NOTIFY_TO=sales@yourcompany.co.jp

# --- Notion（最低3つ） ---
NOTION_PROJECT_DB_ID=...
NOTION_ENGINEER_DB_ID=...
NOTION_MATCH_DB_ID=...

# --- 事業ルール（既定でOK。変更可） ---
MIN_GROSS_MARGIN_JPY=100000     # 粗利下限（円/月）
```

主なチューニング項目（付録に全件）:

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `MIN_GROSS_MARGIN_JPY` | 100000 | 粗利下限（円/月）。未満は除外 |
| `SKILL_MATCH_THRESHOLD` | 0.6 | スキル一致率の下限（未満は除外） |
| `SKILL_MATCH_STRONG_THRESHOLD` | 0.8 | これ以上＝成立候補、下限〜これ未満＝参考提案 |
| `ENABLE_NEGOTIATION` | true | 単金交渉で粗利を作る提案を出すか |
| `NEGOTIATION_MAX_PROJECT_RAISE_MAN` | 5 | 交渉で案件単金を上げる上限（万円） |
| `NEGOTIATION_MAX_ENGINEER_CUT_MAN` | 5 | 交渉で要員単金を下げる上限（万円） |
| `MAX_CANDIDATES_PER_ITEM` | 5 | 1件あたりLLM判定に回す上限（コスト上限保証）。成立候補→交渉提案→参考提案→要確認の順に残す |
| `MATCH_MIN_LLM_SCORE` | 50 | AI最終判定のスコアがこれ未満の成立候補は参考提案に下げる（0で無効） |

判定の補足:

- 勤務地は「東京」「都内」「横浜」「品川駅」「梅田」「首都圏」のような表記からも都道府県を推定します（地域名は代表の都道府県に寄せる近似）。
  要員の居住地から推定できないときは最寄駅で補います。片方でも推定できない組は除外せず「要確認」にします（フルリモート案件は不問）。
- 案件単金は上限を使い、上限の記載が無い（「60万円〜」等）ときは下限で粗利を計算し、根拠に注意書きを付けます。
- 必須スキルの記載が無い案件は、尚可スキルで判定して「参考提案」止まりにします。どちらも無い案件は、案件名に要員のスキルが
  含まれる組だけを「要確認」にします（誰にでも一致する扱いにはしません）。
- 交渉後の単金は0.5万円刻みで提示します。

---

## 7. 本番の動作確認（少量）

`.env.local` 設定後、まず手動で1回実行します。

```bash
npm run ses            # 通しで1回（収集→抽出→マッチ→通知）
# もしくは段階実行:
npm run ses:collect    # 収集のみ
npm run ses:match      # マッチのみ
```

- サマリメールが `SES_NOTIFY_TO` に届くこと、Notionにページが作られることを確認します。
- 認証が未設定の口は warn を出して**スキップ（縮退）**し、他は継続します。ログの warn を確認してください。

---

## 8. 定期実行（1日2回バッチ）

**推奨: GitHub Actions**（`.github/workflows/ses-batch.yml`。平日 10:00／14:00 JST・サーバー不要）。
手順は `docs/ses-deploy-github-actions.md` を参照してください。本番の直前に `npm run ses:preflight`（接続なし・値を表示しない設定確認）が
自動で動き、Secrets の登録漏れや貼り付け誤りがあればバッチを始めずに失敗します。
導入前のメール量・費用の見込みは `npm run ses:mail-stats`（Actions の「SESメール量の測定」）で測れます。

自前のサーバーで動かす場合の cron 例（毎日 9:00 と 18:00）:

```cron
0 9,18 * * *  cd /path/to/executive-clone-ai && /usr/bin/npm run ses >> /var/log/ses.log 2>&1
```

- 処理済みメールIDを記録して**二重処理を防止**します（`DB_PROVIDER=sheets` の本番はシートの「処理済みメール」タブ、それ以外は `data/` 配下）。
  結果列は `抽出済`（保存まで成功）/ `隔離`（再試行の打ち切り）/ `除外`（自分たちのメール）。保存に失敗した案件・要員の元メールは記録せず、次回再処理します。
- 通常バッチは、今回の新着を **直近 `SES_MATCH_LOOKBACK_DAYS`（既定14日）に保存済みの募集中案件・提案可要員とも突合**します
  （別々の実行回に届いた案件と要員の組を見逃さないため）。LLM判定は「新着を含み、まだマッチタブ/DBに無いペア」だけ
  （新着1件あたり最大 `MAX_CANDIDATES_PER_ITEM` 件）なので、同じペアを毎回判定・通知し直すことはありません。
- `data/` は再作成される作業領域です。サーバ移設時は Notion／スプレッドシートが正となります。
- 異常（収集失敗・抽出の過半数失敗・保存やサマリ送信の失敗・LLM鍵の未設定など）があると**終了コード1**で終わります（スケジューラの失敗通知に使えます）。

### 8-2. 自動検証・自己修復（うまく動かない時の自動リカバリ）

バッチには**予算上限つきの自己修復レイヤー**が組み込まれています（既定ON・コード変更なしの安全な範囲）。

**Phase A: 実行時の自動修復（`SES_HEAL_ENABLED=true` 既定）**
- 抽出に失敗したメールは、**2秒後に再試行 → それでも失敗なら上位モデル（Sonnet）へ昇格**して再抽出
  （出力上限で途中打ち切りになった場合は、同じ依頼を繰り返さず**出力上限を2倍にして**再試行。各試行は事前にコストを見積もり、残り予算を超えるなら行いません）
- 添付PDFは送る前にサイズ・パスワード保護・ページ数を確認し、APIが受け付けない場合は**本文と表計算の添付だけで抽出**します（本文の案件・要員を失わない）
- 認証・レート制限・障害などの基盤起因の失敗が5件続いたら、残りのメールの抽出を打ち切って次回に回します（異常終了扱い）
- 修復に使うLLMコストは**実測トークンから円換算**され、`SES_HEAL_BUDGET_JPY`（既定50円/バッチ）で頭打ち。超えた分は次回バッチへ繰越
- 同じメールが累計 `SES_HEAL_MAX_ATTEMPTS`（既定3回）失敗したら**隔離**（`DB_PROVIDER=sheets` はシートの「_状態」タブ、それ以外は `data/ses-heal/quarantine.json`）し、無限再試行を打ち切り。
  回数に達していなくても、**次回の実行時には収集期間を外れるメールはその時点で隔離**してサマリに載せます（黙って消えないように）
- バッチ内の**過半数が失敗**した場合は基盤障害（APIキー・Anthropic障害等）とみなし、誤隔離を防ぐためカウントを保留
- サマリメール末尾に**診断レポート**（コスト概算・救済件数・異常検知・隔離状況）が付きます

**Phase B: 修正パッチ案の自動生成（opt-in）**
```bash
npm run ses:repair    # 手動実行（いつでも可）
```
隔離メールのエラー情報＋関連ソースコードをClaudeに渡し、**原因分析と unified diff のパッチ案**を
`data/ses-heal/repair-<日付>.md` に生成してメール送付します（予算 `SES_REPAIR_BUDGET_JPY`、既定100円/回）。
`SES_REPAIR_ENABLED=true` にすると、隔離が増えたバッチの末尾に自動生成（1日1回まで）。

> ⚠️ **パッチは自動適用されません。** 必ず人がレビューし、`npm run build`・`npm run ses:demo` で確認してから適用してください。
> PII対策として**メール本文はAPIへ送らず**、件名・エラー文中のメールアドレス・電話番号はマスクされます。

**隔離メールの復帰手順**（原因を直した後）:
1. 隔離リスト（Sheets運用は「_状態」タブの quarantine、それ以外は `data/ses-heal/quarantine.json`）から該当エントリを削除
2. 処理済みの記録（Sheets運用は「処理済みメール」タブの該当行、それ以外は `data/ses-processed-ids.json`）から該当メールIDを削除
   → 次回バッチで再処理されます（収集期間 `SES_COLLECT_DAYS` 内のメールに限る。古い場合は一時的に日数を広げる）

**動作確認**: `npm run ses:heal:check`（外部呼び出しゼロのオフライン自己検証）

---

## 9. 確認UI と 複数人での共有

```bash
npm run ses:web        # http://<host>:8788
```

複数人でLAN共有する場合は、**必ずトークンを設定**してください（トークン無しで `127.0.0.1` 以外に公開しようとすると起動を中止します。
トークン無しの運用では `localhost`/`127.0.0.1` 以外のホスト名での要求と、他サイトからの送信を拒否します）。

```
SES_WEB_HOST=0.0.0.0
SES_WEB_PORT=8788
WEB_ACCESS_TOKEN=<共有トークン>
```

UIでできること:
- マッチ一覧の閲覧（成立候補／交渉提案／参考提案／要確認のバンド表示）
- 下書き内容の閲覧、ステータス更新（評価者名つき）
- 「妥当／ズレ」フィードバック、スキル同義語の登録（学習に反映）
- **「あなたの会社メール（送信元）」を入力 →「自分のアドレスで下書き作成」** で、
  全員に返信の下書きを**本人の会社アドレス**で作成

---

## 10. 日々の運用フロー（営業視点）

1. バッチが1日2回自動巡回 → サマリメールが届く。
2. 確認UIを開き、成立候補・交渉提案をレビュー。
3. 良いものは自分の会社メールを入れて「下書き作成」。
   - **Sheets運用（`DB_PROVIDER=sheets`）**: 確認UIの代わりにスプレッドシート「マッチ」タブの文面を確認し、
     「担当者メール」に自分のアドレスを入れる → 次回バッチ（10:00／14:00）で下書きが作成される（4-7参照）
4. 下書き（To=元メールの Reply-To（無ければ送信者）／Cc=元の宛先のうち自社（メーリス含む）と返信先と同じ会社の宛先／Re:件名）を開き、**内容を確認して送信**。
   - 他社のドメイン・配信用アドレス（bp-all@ 等）・Bccで届いた一斉配信の宛先一同は Cc に引き継ぎません（最大10件）。
     外した件数は文面の先頭（`※`）と確認UIに表示されるので、必要な宛先だけ送信前に追加してください。
     自社かどうかは `SES_OWN_DOMAINS` と共有メールボックスのドメインで判定します。
   - 紹介文面には、相手に見せない情報（相手方の社名・担当者名、もう一方の単金、粗利、商流メモ、判定根拠）を入れません。
     単金は交渉提案のときにお願いする額だけを書き、それ以外は「ご相談」とします。
     AIの生成文面にこれらが混ざった場合は定型文に差し替えます。
   - 送信元プレースホルダ `《送信元：あなたの会社ドメインのアドレスを確認して入力してください》` が本文に残っていると
     未確定サイン。**必ず削除・確定してから送信**してください（誤送信ガード）。
5. 結果を「妥当／ズレ」で評価 → 精度が継続的に向上。

---

## 11. トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| demoは動くが本番で何も起きない | 手元では `ANTHROPIC_API_KEY` 未設定だと自動でdemo化（CIではエラー終了）。`npm run doctor` の「実行モード」を確認 |
| メール収集が0件 | `npm run doctor` で IMAP/Gmail の疎通を確認。`SES_COLLECT_DAYS`、自社ドメイン除外（`SES_OWN_DOMAINS`）の件数ログも確認 |
| 下書きが作られない | `XSERVER_DRAFTS_MAILBOX` がサーバの実フォルダ名と一致しているか確認 |
| 下書き状態が `エラー: …` | 担当者メールの形式（アドレス1件のみ）・`SES_ALLOWED_SENDER_DOMAINS`・IMAP/DWD設定を確認。直せば次回バッチで再試行 |
| Notionに保存されない | DB IDと**プロパティ名の完全一致**、インテグレーションのDB共有を確認 |
| サマリメールが届かない | `SES_NOTIFY_TO` とSMTP設定（`XSERVER_SMTP_*`）を確認 |
| 自社社員突合が空 | `NOTION_OWN_ENGINEER_DB_ID` 設定と、ステータス`稼働可`の社員有無を確認 |
| プロパー候補が0件 | 管理表の稼働状況が `稼働可` か、スキル列が埋まっているか（「抽出メモ」を確認）、直近の案件があるか |
| プロパーのフォルダ・管理表を読めない | フォルダ（閲覧者）と管理表（編集者）をサービスアカウントのメールに共有したか。共有ドライブの場合はメンバー追加でも可 |
| GWSへ移行した | `MAIL_PROVIDER=gmail` に変更し `SES_TARGET_GMAIL`（SES専用メールボックス）＋`GOOGLE_SA_*` を設定（他は不要） |
| GitHub Actions の「設定の事前確認」が赤い | ❌ の行に Secret／Variable の名前と理由が出ます（値は表示しません）。`docs/ses-deploy-github-actions.md` 5章・8章 |

---

## 付録: 環境変数一覧

すべて `.env.example` にコメント付きで記載しています。代表的なもの:

- 実行/モデル: `ANTHROPIC_API_KEY` `DEMO_MODE` `SES_REQUIRE_LIVE` `ANTHROPIC_MODEL_EXTRACT` `ANTHROPIC_MODEL_MATCH` `USE_BATCH_API`
- メール（共通/切替）: `MAIL_PROVIDER` `SES_NOTIFY_TO` `SES_COLLECT_DAYS` `SES_MAX_MAILS_PER_RUN` `SES_OWN_DOMAINS` `SES_COLLECT_OWN_DOMAIN`
- 突合の範囲: `SES_MATCH_LOOKBACK_DAYS` `SES_MATCH_POOL_LIMIT`
- メール（Xserver）: `XSERVER_IMAP_HOST/PORT` `XSERVER_SMTP_HOST/PORT` `XSERVER_SHARED_USER/PASS` `XSERVER_DRAFTS_MAILBOX`
- メール（Gmail）: `SES_TARGET_GMAIL` `GOOGLE_SA_*`
- スプレッドシート保存: `DB_PROVIDER` `SHEETS_DB_SPREADSHEET_ID` `GOOGLE_SA_KEY_JSON`（または `GOOGLE_SA_CLIENT_EMAIL/PRIVATE_KEY`） `SHEETS_DB_IMPERSONATE`
- プロパー候補: `PROPER_SKILLSHEET_FOLDER_ID` `PROPER_MASTER_SPREADSHEET_ID` `PROPER_MAX_EXTRACT_PER_RUN` `PROPER_PROJECT_LOOKBACK_DAYS`（別テナント時のみ `PROPER_GOOGLE_SA_*` `PROPER_GOOGLE_IMPERSONATE`）
- 公開ログ対策: `SES_LOG_REDACT`（未設定時は CI/GitHub Actions 上で自動有効）
- メール量の測定: `SES_STATS_DAYS`（`npm run ses:mail-stats` の遡り日数。既定30）
- 事業ルール: `MIN_GROSS_MARGIN_JPY`（または `MIN_GROSS_MARGIN_MAN`） `SKILL_MATCH_THRESHOLD` `SKILL_MATCH_STRONG_THRESHOLD` `MAX_CANDIDATES_PER_ITEM` `MATCH_MIN_LLM_SCORE` `HOURLY_TO_MONTHLY_HOURS` `MATCH_TIMING_GRACE_DAYS`
- 交渉: `ENABLE_NEGOTIATION` `NEGOTIATION_MAX_PROJECT_RAISE_MAN` `NEGOTIATION_MAX_ENGINEER_CUT_MAN`
- Notion: `NOTION_PROJECT_DB_ID` `NOTION_ENGINEER_DB_ID` `NOTION_MATCH_DB_ID` `NOTION_OWN_ENGINEER_DB_ID` `NOTION_FEEDBACK_DB_ID` `NOTION_SKILL_EQUIV_DB_ID`
- 確認UI: `SES_WEB_HOST` `SES_WEB_PORT` `WEB_ACCESS_TOKEN` `SES_REVIEW_DATA_DIR`
- 自己修復・パッチ案: `SES_HEAL_ENABLED` `SES_HEAL_BUDGET_JPY` `SES_HEAL_MAX_ATTEMPTS` `SES_HEAL_DATA_DIR` `JPY_PER_USD` `SES_REPAIR_ENABLED` `SES_REPAIR_BUDGET_JPY` `ANTHROPIC_MODEL_REPAIR`
