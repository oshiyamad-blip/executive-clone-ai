# SES案件・要員マッチングシステム 導入マニュアル

このドキュメントは、SESマッチング機能を**ゼロから本番稼働させるまで**の手順書です。
まず外部接続なしの `demo` で動作を確認し、その後に実データへ接続する流れを推奨します。

- 設計の詳細: `docs/ses-matching-requirements.md` / `ses-matching-basic-design.md` / `ses-matching-detailed-design.md`
- 追加機能（交渉提案・バンド分け・全員に返信・メーラー切替）: `docs/ses-matching-addendum.md`

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

> demo は `DEMO_MODE=true`（または `ANTHROPIC_API_KEY` 未設定）で有効になり、
> メール・Notion・LLMいずれも呼びません。本番設定を汚しません。

---

## 4. Notion の準備

Notion で内部インテグレーションを作成し、対象データベースに**コネクト（共有）**します。
各DBは以下のプロパティ名で作成してください（**名前は完全一致**が必要です）。

### 4-1. 案件DB（`NOTION_PROJECT_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| 案件名 | タイトル |
| 必須スキル / 尚可スキル | マルチセレクト |
| 単金下限 / 単金上限 | 数値 |
| 勤務地 / 開始時期 / 商流メモ / 営業元会社 / 営業元担当 / 営業元メール / 元メールID / **返信メタ** | テキスト |
| リモート / ステータス | セレクト |
| 受信日 / **開始日** | 日付 |

> **返信メタ**は「全員に返信」のスレッド情報（元メールの宛先・Message-ID）を保持する内部用プロパティです。
> これが無いと `--match-only` 実行時の下書きがスレッド返信になりません。**開始日**は時期マッチ判定に使います。

### 4-2. 要員DB（`NOTION_ENGINEER_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| 表示名 | タイトル |
| スキル | マルチセレクト |
| 経験年数 / 希望単金 | 数値 |
| 居住地 / 営業元 / 元メールID / **返信メタ** | テキスト |
| リモート希望 / ステータス | セレクト |
| 受信日 / 稼働開始可能日 | 日付 |

### 4-3. マッチ結果DB（`NOTION_MATCH_DB_ID`）
| プロパティ | 型 |
| --- | --- |
| マッチ名 | タイトル |
| 粗利額 / 適合スコア | 数値 |
| 判定根拠 / 案件側下書きURL / 要員側下書きURL | テキスト |
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
XSERVER_COLLECT_DAYS=1             # 収集の遡り日数（1日2回バッチ想定）
```

- 収集: `INBOX` を直近 `XSERVER_COLLECT_DAYS` 日で検索。
- 下書き: 「全員に返信」MIMEを組み立て、共有の**下書きフォルダに APPEND**。営業は共有下書きを開いて送信。
- `XSERVER_DRAFTS_MAILBOX` はサーバの下書きフォルダ名に合わせてください（不明ならメールソフトで確認）。

### 5-B. Gmail（Google Workspace）
会社ドメインを GWS へ移行した場合。**`MAIL_PROVIDER=gmail` に変えるだけ**で他ロジックは共通です。

```
MAIL_PROVIDER=gmail
SES_TARGET_GMAIL=sales@yourcompany.co.jp   # 共有メーリス
# ドメイン全体委任(DWD)用のサービスアカウント認証（既存 GOOGLE_SA_* を使用）
GOOGLE_SA_CLIENT_EMAIL=...
GOOGLE_SA_PRIVATE_KEY=...
```

- DWDで共有メーリスを収集し、**担当営業本人を impersonate** して本人のGmailにスレッド返信下書きを作成します。
- Workspace管理コンソールのDWD登録に、既存のreadonly系スコープに加えて
  `gmail.compose`・`gmail.send`・`spreadsheets.readonly` の追加が必要です
  （SES機能側だけがこの追加スコープを要求するため、**既存コレクターは旧スコープ登録のままでも動き続けます**）。

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
| `MAX_CANDIDATES_PER_ITEM` | 5 | 1件あたりLLM判定に回す上限（コスト上限保証） |

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

cron 例（毎日 9:00 と 18:00）:

```cron
0 9,18 * * *  cd /path/to/executive-clone-ai && /usr/bin/npm run ses >> /var/log/ses.log 2>&1
```

- 処理済みメールIDはローカルに記録され、**二重処理を防止**します（`data/` 配下）。
- `data/` は再作成される作業領域です。サーバ移設時は Notion が正となります。

### 8-2. 自動検証・自己修復（うまく動かない時の自動リカバリ）

バッチには**予算上限つきの自己修復レイヤー**が組み込まれています（既定ON・コード変更なしの安全な範囲）。

**Phase A: 実行時の自動修復（`SES_HEAL_ENABLED=true` 既定）**
- 抽出に失敗したメールは、**2秒後に再試行 → それでも失敗なら上位モデル（Sonnet）へ昇格**して再抽出
- 修復に使うLLMコストは**実測トークンから円換算**され、`SES_HEAL_BUDGET_JPY`（既定50円/バッチ）で頭打ち。超えた分は次回バッチへ繰越
- 同じメールが累計 `SES_HEAL_MAX_ATTEMPTS`（既定3回）失敗したら**隔離**（`data/ses-heal/quarantine.json`）し、無限再試行を打ち切り
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
1. `data/ses-heal/quarantine.json` から該当エントリを削除
2. `data/ses-processed-ids.json` から該当メールIDを削除 → 次回バッチで再処理されます

**動作確認**: `npm run ses:heal:check`（外部呼び出しゼロのオフライン自己検証）

---

## 9. 確認UI と 複数人での共有

```bash
npm run ses:web        # http://<host>:8788
```

複数人でLAN共有する場合は、**必ずトークンを設定**してください。

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
4. 下書き（To=元送信者／Cc=元の宛先＝メーリス含む／Re:件名）を開き、**内容を確認して送信**。
   - 送信元プレースホルダ `《送信元：あなたの会社ドメインのアドレスを確認して入力してください》` が本文に残っていると
     未確定サイン。**必ず削除・確定してから送信**してください（誤送信ガード）。
5. 結果を「妥当／ズレ」で評価 → 精度が継続的に向上。

---

## 11. トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| demoは動くが本番で何も起きない | `ANTHROPIC_API_KEY` 未設定だと自動でdemo化。設定を確認 |
| メール収集が0件 | `XSERVER_*`（特にHOST/USER/PASS）とネットワーク、`XSERVER_COLLECT_DAYS` を確認 |
| 下書きが作られない | `XSERVER_DRAFTS_MAILBOX` がサーバの実フォルダ名と一致しているか確認 |
| Notionに保存されない | DB IDと**プロパティ名の完全一致**、インテグレーションのDB共有を確認 |
| サマリメールが届かない | `SES_NOTIFY_TO` とSMTP設定（`XSERVER_SMTP_*`）を確認 |
| 自社社員突合が空 | `NOTION_OWN_ENGINEER_DB_ID` 設定と、ステータス`稼働可`の社員有無を確認 |
| GWSへ移行した | `MAIL_PROVIDER=gmail` に変更し `SES_TARGET_GMAIL`＋`GOOGLE_SA_*` を設定（他は不要） |

---

## 付録: 環境変数一覧

すべて `.env.example` にコメント付きで記載しています。代表的なもの:

- 実行/モデル: `ANTHROPIC_API_KEY` `DEMO_MODE` `ANTHROPIC_MODEL_EXTRACT` `ANTHROPIC_MODEL_MATCH` `USE_BATCH_API`
- メール（共通/切替）: `MAIL_PROVIDER` `SES_NOTIFY_TO`
- メール（Xserver）: `XSERVER_IMAP_HOST/PORT` `XSERVER_SMTP_HOST/PORT` `XSERVER_SHARED_USER/PASS` `XSERVER_DRAFTS_MAILBOX` `XSERVER_COLLECT_DAYS`
- メール（Gmail）: `SES_TARGET_GMAIL` `GOOGLE_SA_*`
- 事業ルール: `MIN_GROSS_MARGIN_JPY` `SKILL_MATCH_THRESHOLD` `SKILL_MATCH_STRONG_THRESHOLD` `MAX_CANDIDATES_PER_ITEM` `HOURLY_TO_MONTHLY_HOURS` `MATCH_TIMING_GRACE_DAYS`
- 交渉: `ENABLE_NEGOTIATION` `NEGOTIATION_MAX_PROJECT_RAISE_MAN` `NEGOTIATION_MAX_ENGINEER_CUT_MAN`
- Notion: `NOTION_PROJECT_DB_ID` `NOTION_ENGINEER_DB_ID` `NOTION_MATCH_DB_ID` `NOTION_OWN_ENGINEER_DB_ID` `NOTION_FEEDBACK_DB_ID` `NOTION_SKILL_EQUIV_DB_ID`
- 確認UI: `SES_WEB_HOST` `SES_WEB_PORT` `WEB_ACCESS_TOKEN` `SES_REVIEW_DATA_DIR`
- 自己修復・パッチ案: `SES_HEAL_ENABLED` `SES_HEAL_BUDGET_JPY` `SES_HEAL_MAX_ATTEMPTS` `SES_HEAL_DATA_DIR` `JPY_PER_USD` `SES_REPAIR_ENABLED` `SES_REPAIR_BUDGET_JPY` `ANTHROPIC_MODEL_REPAIR`
