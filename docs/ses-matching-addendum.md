# SESマッチング 追加機能（第2弾）

作成日: 2026-07-17 ／ 基本設計・詳細設計への追補

要件定義・基本設計・実装（第1弾）に続き、運用フィードバックから以下3機能を追加した。既存パイプラインへの後方互換な追加であり、既存の収集→抽出→マッチ→下書き→通知の流れは変更していない。

---

## 1. Google スプレッドシート読取の改善（全タブ・範囲固定の撤廃）

**背景**: 第1弾はスプシリンクを `A1:Z200` 固定・先頭タブのみで読んでいたため、Z列超・200行超・2枚目以降のタブを取りこぼしていた。

**変更**: `src/ses/parse.ts` の `readSheetAsText` を全面改修。
- `spreadsheets.get`（`fields: 'sheets.properties.title'`）で全タブ名を取得。
- 各タブを `spreadsheets.values.get({ range: タブ名 })` で読む。range にタブ名のみを渡すと、そのタブの**使用済みセル全域**が返る（行・列の上限なし）。
- タブ単位で try/catch し、`【タブ: 名前】` 見出し付きで連結。空タブはスキップ。

これにより広範囲・複数タブのスプシでも取りこぼしなく抽出できる。demoは外部アクセスしないため従来どおりfixtureテキストを使う（このパスは本番のみ）。

---

## 2. 自社社員 → 合いそうな案件を探す機能

**目的**: 外部から届く要員だけでなく、**自社の候補社員を登録して、届いた案件の中から合いそうなものを探す**。

**金額条件は「必要案件単価」の閾値方式**（外部要員の粗利下限とは別ロジック）:
- 社員ごとに「必要案件単価（万円/月）」を登録し、**案件単価（rateMax優先）≥ 必要案件単価** を満たす案件を提示。
- 必要案件単価に希望マージンが織り込まれている前提のため、粗利下限とは独立。単価不足の案件は除外、単価不明は要確認。
- スキル一致率・勤務地隣接・時期整合の判定は外部マッチ（`match.ts`）と同じヘルパーを流用。

**構成**:
| 追加 | 内容 |
|---|---|
| 型 `OwnEngineer` / `OwnMatch`（`src/types/index.ts`） | 自社社員と、その社員×案件のマッチ。`requiredProjectRate`(必要案件単価)を持つ |
| Notion 自社社員DB（`src/database/index.ts`） | `saveOwnEngineer` / `fetchOwnEngineers`。プロパティ: 表示名・スキル・経験年数・**必要案件単価**・居住地・リモート希望・稼働可能日・ステータス（稼働可/アサイン済） |
| `src/ses/ownMatch.ts` | `matchOwnEngineersToProjects()`（純関数）＋ `runOwnMatch()`（社員・案件を読み込み→突合→出力）。社員ごとに上位 `MAX_CANDIDATES_PER_ITEM` 件を提示 |
| demo fixtures（`src/ses/fixtures/ownEngineers.ts`） | 単価充足で成立するケースと、単価不足で除外されるケースを網羅 |
| npm scripts | `ses:own-match`（本番=Notion自社社員DB＋案件DB）/ `ses:own-match:demo`（fixtureで外部呼び出しなし） |
| env | `NOTION_OWN_ENGINEER_DB_ID` |

**データソース**: 本番=Notion自社社員DB＋案件DB（募集中）、demo=fixture社員＋（直前 `ses:demo` の案件成果 or fixture案件を抽出）。

---

## 3. マッチ確認UI（レビューダッシュボード）

**目的**: マッチと紹介メール下書きを人が確認し、ステータスを更新する軽量Web UI。

**方針**: 既存 `src/web/server.ts` と同じ「ビルド不要のインラインHTML＋軽量httpサーバー」流儀。ローカルバインド（127.0.0.1）＋任意の `WEB_ACCESS_TOKEN` Bearer認証。

**構成**:
| 追加 | 内容 |
|---|---|
| `src/ses/review.ts` | レビュー用データ層。バッチ(`notify.ts`)と自社社員探し(`ownMatch.ts`)が成果を `SES_REVIEW_DATA_DIR`(既定 `data/ses-review/`) へ書き出し、UIが読む。demo/本番共通のためUIはNotion接続なしでも動く。ステータス更新はローカル反映＋（`notionPageId`があれば）Notionへ best-effort 同期 |
| 型 `ReviewMatch`（`src/types/index.ts`） | UIの表示用にマッチを平坦化（下書きURL/本文を保持）。demoは下書き本文をインライン、本番はGmail下書きURLへのリンク |
| `updateMatchStatus`（`src/database/index.ts`） | マッチDBのステータスをNotionで更新 |
| `src/ses/web.ts` | ダッシュボード。外部マッチ（成立/要確認・粗利・スコア・根拠・下書き閲覧・ステータス更新ボタン）と、自社社員→案件の候補一覧を表示 |
| npm scripts | `ses:web` / `ses:web:demo`（既定ポート `SES_WEB_PORT=8788`） |

**UIでできること**（ご要望どおり「一覧＋下書き閲覧＋ステータス更新」）:
- 成立候補／要確認のマッチ一覧を粗利・スコア・根拠つきで表示
- 各マッチの紹介メール下書き2通（案件側・要員側）を展開して確認（demoは本文インライン、本番はGmail下書きへのリンク）
- ステータスを「未確認／紹介済／成約／見送り」に更新（**送信は行わず下書き止まり**の原則は維持）
- 自社社員→案件の候補も同画面で確認

---

## 4. 交渉提案（同単金でも粗利を作る）

**目的**: 「案件単金 − 要員単金」が粗利下限に**届かないペアを捨てず**、両者の単金交渉で成立させる提案を出す。
例: 同単金（粗利0）のペアを **案件+5万・要員−5万** で交渉し粗利10万円/月を確保する。

**ロジック**（`src/ses/match.ts`）:
- 粗利が下限未満のペアについて、不足分を「案件単金の値上げ」と「要員単金の値下げ」で埋められるか判定。
- 不足分をできるだけ**両者で折半**し、各交渉上限（既定 各5万円）で頭打ち。切り上げで下限を確実に満たす。
- 交渉幅（値上げ上限＋値下げ上限、既定10万円）を**超える場合のみ除外**。それ以内なら「交渉提案」枠として拾う。
- マッチは3区分になる: **成立候補**（そのまま下限充足）／**交渉提案**（交渉すれば成立）／**要確認**（単金・勤務地が不明）。

**反映先**:
| 箇所 | 内容 |
|---|---|
| 型 `NegotiationProposal`（`src/types/index.ts`） | 案件の値上げ額・要員の値下げ額・交渉後単金・交渉後粗利。`MatchResult`/`ReviewMatch` に `negotiation?` を追加 |
| サマリ（`notify.ts`） | 【交渉提案】セクションを追加（「案件+4万／要員−4万で粗利10万円」形式） |
| 紹介メール下書き（`draft.ts`） | 交渉提案がある場合、**案件側宛には「単金を上げるご相談」**、**要員側宛には「単金を下げるご相談」**を本文に自動で添える（本番のSonnet生成にも交渉文脈を渡す） |
| 確認UI（`web.ts`） | 「交渉提案」バッジと交渉案（案件+X万→◯万／要員−Y万→◯万 ⇒ 粗利◯万）を表示 |
| env | `ENABLE_NEGOTIATION`（既定true）／`NEGOTIATION_MAX_PROJECT_RAISE_MAN`（既定5）／`NEGOTIATION_MAX_ENGINEER_CUT_MAN`（既定5） |

交渉幅は `.env` で調整可能（例: 案件側は上げ交渉しにくいので値上げ上限を0にし、要員側の値下げのみで埋める、といった運用も可能）。

## 5. スキルマッチのバンド分け＋人間フィードバックによる精度向上（複数人対応）

**目的**: 完璧なスキル一致でなくても「許容範囲」を提案し、人間のフィードバックで精度を継続的に上げる。複数人で使う前提。

### 5-1. マッチのバンド分け（提案数を増やしつつ質を保つ）
スキル一致率で3段階に区分（`SKILL_MATCH_THRESHOLD`=許容下限0.6 / `SKILL_MATCH_STRONG_THRESHOLD`=強マッチ下限0.8）:
- **成立候補**（強マッチ ≥0.8・粗利OK）… 自動で下書きまで
- **参考提案**（許容範囲 0.6〜0.8）… 別枠で提示。**自動下書きはせず人の確認を促す**
- **交渉提案** … 単金交渉で成立見込み（§4）
- **要確認** … 単金・勤務地が不明

`MatchResult` に `band`（strong/tentative）と `category`（confirmed/negotiable/tentative/review）を追加。しきい値は `.env` で調整でき、下げれば提案数が増える。

### 5-2. スキル同義・類似辞書を育てる（`skillEquiv.ts`）
静的な表記ゆれ辞書（`skillDict.ts`）とは別に、「PHP≈Laravel」「React≈Next.js」のような**相互に満たすスキル**を蓄積。`skillMatchRate` が完全一致に加えてこの辞書を参照するため、許容範囲が実務に合っていく。確認UIから追加でき、**次回マッチから即反映**（共有の正: prod=Notion同義DB / demo=ローカルJSON）。

### 5-3. 人間フィードバック（`feedback.ts`）を3経路に反映
確認UIで各マッチに「妥当／ズレ＋メモ＋評価者名」を付与。蓄積した評価を:
1. **LLM最終判定にfew-shot** … 直近の評価例をSonnetのシステムプロンプトに添え、御社の許容感覚を学習（本番LLM経路）
2. **スキル同義辞書の成長** … 「PHPとLaravelは同じ」等の気づきを同義登録に反映
3. **バンド別成約率の可視化**（`metrics.ts`）… バンドごとの成約率・妥当率を確認UIに表示し、しきい値の締め/緩めの判断材料に

### 5-4. 複数人運用
- 確認UIに**名前入力**を追加。ステータス変更・評価・同義追加に評価者名を記録。
- **共有の正はNotion**（マッチ／評価ログ／同義辞書）。ローカルJSONはdemo・単体作業用に降格。
- 待受ホスト `SES_WEB_HOST`（既定ローカル）とアクセストークン `WEB_ACCESS_TOKEN` を設定してLAN共有。
- env追加: `SKILL_MATCH_STRONG_THRESHOLD` / `NOTION_FEEDBACK_DB_ID` / `NOTION_SKILL_EQUIV_DB_ID` / `SES_WEB_HOST` / `WEB_ACCESS_TOKEN`

## 6. 共有メーリス収集 ＋「全員に返信」＋ 営業個人アドレス送信（日本の商習慣対応）

**背景**: 案件・要員メールは `sales@` の**共有メールボックス（メーリス）**に届く。返信は日本の商習慣に沿って**元メールへ「全員に返信」**し、送信元は**担当営業個人の会社ドメインのアドレス**にしたい。

### 6-1. 収集時に返信メタ情報を取得
`email.ts` で元メールの `Message-ID` / `Cc` / `References` / 件名を取得（`SesRawMail` に `cc`/`messageIdHeader`/`references` 追加）。抽出後、案件/要員に `ReplyTarget`（元From/To/Cc/件名/Message-ID）を付与（`extract.ts`。案件側・要員側それぞれの元メールに紐づく）。

### 6-2. 下書きを「全員に返信」で組み立て（`draft.ts`）
- **To** = 元メールの送信者
- **Cc** = 元の宛先一同（**メーリス `sales@` を含む**。重複のみ除去）— 質問への回答どおり「元の宛先そのまま全員」
- **件名** = `Re:` 付与、**In-Reply-To / References** でスレッド継続
- **From** = 担当営業個人の会社アドレス。確定するまで `《送信元：あなたの会社アドレスを確認して入力》` の**プレースホルダ**（未確定のまま送らないガードも兼ねる）
- 本文は従来どおり（本番=Sonnet生成、demo=テンプレート）

### 6-3. 送信元＝営業個人アドレスで下書き作成
- `googleAuth.getGoogleAuthAs(email)` で**担当営業本人を impersonate**（ドメイン全体委任）。
- 確認UIに**「あなたの会社メール（送信元）」入力**と、各マッチの**「自分のアドレスで下書き作成」**ボタンを追加。押すと本番=**本人のGmailにスレッド返信の下書きを作成**（Fromが本人アドレス）、demo=Fromを入れてローカル保存。空欄・不正メールは拒否。
- バッチは「全員に返信の内容（宛先・件名・本文・スレッド情報）」を用意するところまで。**実際のGmail下書き作成は本人が確認UIで行う**（送信元が個人アドレスのため）。送信自体は本人がGmailで最終確認して実施（下書き止まりは維持）。
- env: `SES_TARGET_GMAIL` は共有メーリス（sales@）を指定。

## 7. メール送受信プロバイダの切替（Xserver ⇄ Google Workspace）

**背景**: 会社ドメインは現状 **Xserver 単独**運用だが Google Workspace(GWS) も併用しており、将来 GWS へ移行する可能性がある。収集・下書き・サマリ送信の「口」を差し替え可能にし、いまは Xserver で動かしつつ、移行後は設定変更だけで Gmail API に切り替えられるようにした。

### 7-1. `MAIL_PROVIDER` による抽象化（`src/ses/mail/`）
既存の `LLM_PROVIDER`（anthropic|gemini）と同じ流儀で、`MailTransport` インタフェース（`collect` / `createReplyDraft` / `sendPlainMail`）を定義し、`MAIL_PROVIDER` で実装を切り替える。**マッチング・確認UI・「全員に返信」の組み立ては共通**で、外部との入出力口だけが差し替わる。

| ファイル | 役割 |
| --- | --- |
| `mail/index.ts` | `MailTransport` I/F と `transport()` セレクタ。`collectMail()` / `createReplyDraftViaMail()` / `sendPlainMailViaMail()` を公開 |
| `mail/xserver.ts` | **既定**。IMAP(`imapflow`) で `sales@` を収集、`mailparser` で本文・添付・返信メタを解析、下書きは `nodemailer` でMIME組立→IMAP `APPEND`（下書きフォルダ）、サマリは SMTP 送信 |
| `mail/gmail.ts` | GWS 運用時。DWD で共有メーリス収集・本人 impersonate 下書き作成・サマリ送信（従来のGmail経路を移設） |

- `collect.ts` / `draft.ts`(`materializeReplyDraft`) / `notify.ts` は上記の共通関数を呼ぶだけになり、プロバイダ非依存。
- 設定不足時は各プロバイダが warn して**縮退**（他機能は継続）。demo は `isDemo()` で全経路を短絡するため**プロバイダに一切依存せずオフライン**。

### 7-2. Xserver（既定）の要点
- **収集**: IMAP接続で `INBOX` を `SINCE`(既定1日) 検索 → `source` 取得 → `simpleParser` で `SesRawMail` 化（`id=sesmail_x<uid>`。Cc/Message-ID/References も取得し「全員に返信」に接続）。
- **下書き**: `nodemailer` の `streamTransport`(buffer) で全員に返信のMIMEを組み立て、共有の**下書きフォルダに `APPEND`**（`\Draft` フラグ）。担当営業は共有下書きを開いて確認・送信（送信は手動＝下書き止まりを維持）。
- **サマリ**: SMTP(465/SSL) で `SES_NOTIFY_TO` へ送信。
- env: `XSERVER_IMAP_HOST/PORT`・`XSERVER_SMTP_HOST/PORT`・`XSERVER_SHARED_USER/PASS`・`XSERVER_DRAFTS_MAILBOX`(既定`Drafts`)・`XSERVER_COLLECT_DAYS`(既定1)。

### 7-3. GWS へ移行する場合
`MAIL_PROVIDER=gmail` に変更し、DWD 用の Google 認証（`GOOGLE_SA_*`）と `SES_TARGET_GMAIL`（共有メーリス）を設定するだけ。マッチング・UI・下書き本文生成は変更不要。

## 8. 全体レビュー指摘の修正（信頼性・精度・セキュリティ）

多観点コードレビュー（8観点×検証）で確認された指摘を修正した。

**データ消失・信頼性**
- 抽出に失敗したメールを処理済みにしない（次回バッチで再処理。API障害時の案件・要員消失を防止）
- レビューJSONをマージ書き込みに変更（バッチ再実行で人のステータス・評価者・確定済み下書きが消えない。IDとタイトルの両方で既存分を突合）
- フィードバックのNotion保存失敗時はローカル退避＋UI通知（黙殺しない。読出時にマージされ学習に反映継続）
- NotionマッチDBをタイトルでupsert（再実行でページが増殖しない。人が進めたステータスは上書きしない）
- IMAPのメールIDに UIDVALIDITY を付与（メールボックス再構築後の誤スキップ防止）

**マッチング精度**
- Notion読出し時にもスキル正規化を適用（自社社員DB等に人が「JS」「k8s」と入力しても案件のJavaScript/Kubernetesとマッチ）
- few-shot が「最新の評価」を使うよう修正（従来は取得50件中の最古6件を学習していた）
- バンド別メトリクスの評価結合をタイトルでもフォールバック（経路間でマッチID体系が異なっても成約率・妥当率に反映）
- 自社社員→案件にもバンド分けを適用（`isTimingWithinGrace` を match.ts から共有。0.6〜0.8帯は[参考提案]表示）
- octet-stream で届く .xlsx/.pdf も拡張子で判定して解析・抽出（日本のメーラー対策）
- 返信メタ（ReplyTarget）と開始日をNotionへ永続化し `--match-only` でも全員に返信・時期判定が機能（案件DB/要員DBに「返信メタ」プロパティ、案件DBに「開始日」を追加）

**セキュリティ・運用**
- 確認UIのXSS修正（`esc()` が引用符をエスケープせず属性値注入が可能だった）
- `.env.example` の `WEB_ACCESS_TOKEN` 二重宣言を削除（dotenvの後勝ちで認証が無効化される問題）
- Google認証のスコープを BASE / SES に分離（既存コレクターはreadonlyのまま。旧DWD登録の環境を壊さない）
- Gmail/Xserver のMIME組み立てを `mail/mime.ts` に共通化（日本語表示名のRFC2047エンコードを両経路で統一）
- 全員に返信のCcをメールアドレス単位で重複排除し、Toと同一アドレスを除外。引用符内カンマの宛先分割も修正
- 交渉提案の値上げ/値下げ幅が上限（小数設定時）を超えないよう最終クランプ
- Xserver収集は処理済みUIDを本文取得前に除外し、添付はGmail経路と同じ許可リスト（xlsx/xls/pdf）で絞る
- UIのエラー文言を日本語に統一。http(s)以外の下書きURLはリンクにせずラベル表示

## 9. 予算制約付き自己修復レイヤー（検証・修正の自動化）

「うまく動かなかった時に、一定のAPI予算内で検証・修正を自動化したい」という要望に対応。2段階で導入した。

### 9-1. Phase A: アプリ内自己修復（`src/ses/heal/`・既定ON）

| モジュール | 役割 |
| --- | --- |
| `llm/anthropic.ts` + `llm/pricing.ts` | 全LLM呼び出しの実測トークンを記録し、モデル別単価（$/MTok）×`JPY_PER_USD` で**円換算** |
| `heal/budget.ts` | 修復に使った分だけを前後差分で計上する円メーター（`SES_HEAL_BUDGET_JPY` 既定50円/バッチ） |
| `heal/retry.ts` | 失敗したLLM処理を **2秒後再試行 → 5秒後に上位モデル(Sonnet)昇格**。恒久系エラー(400/401/403)は再試行しない |
| `heal/quarantine.ts` | 同一メール累計 `SES_HEAL_MAX_ATTEMPTS`(既定3)回失敗で**隔離**（処理済み化して無限再試行を打ち切り、メタ情報は quarantine.json へ）。成功で履歴消去 |
| `heal/events.ts` | 統計・イベント収集、ルールベース異常検知（収集>0で抽出0、隔離あり等）、**診断レポート**生成（サマリメール末尾に添付） |

- **誤隔離ガード**: バッチ内の失敗が過半数（かつ3件以上）なら基盤障害とみなし、隔離カウントを保留
- **demoは完全no-op**（オフライン維持）。`npm run ses:heal:check` でオフライン自己検証（円換算・分類・隔離・マスクの15項目）

### 9-2. Phase B: 修正パッチ案の自動生成（`npm run ses:repair`・自動起動はopt-in）

- 隔離メールのエラー情報＋直近バッチの診断＋**許可リストのソースコードのみ**をClaudeに渡し、
  構造化出力で「原因分析／再現条件／unified diffパッチ案／適用手順／リスク／確信度」を生成
- 出力は `data/ses-heal/repair-<日付>.md`＋通知メール。**自動適用は絶対にしない**（人がレビューして適用）
- 予算 `SES_REPAIR_BUDGET_JPY`（既定100円/回）。`SES_REPAIR_ENABLED=true` で隔離が増えたバッチ末尾に自動生成（1日1回）
- **PII対策**: メール本文は送らない。件名・エラーはメールアドレス・電話番号をマスク（`maskPii`）した上で500字に切詰め
- doctor（`npm run doctor`）にSESセクションを追加: プロバイダ設定・Notion DB・自己修復設定・隔離件数を診断

## 動作確認（demo・外部呼び出しなし）

- `npm run build` … 通過（strict/noUnused/fallthrough クリーン）
- `npm run ses:demo` … 成立候補1件・**交渉提案1件**（金融系Java案件×M.T.: 案件60万/要員58万 → 案件+4万・要員−4万で粗利10万円）・要確認1件を検出。交渉下書きには双方への単金相談を自動で反映
- `npm run ses:own-match:demo` … 自社社員3名 × 案件4件を突合。A.K.(必要65万)→75万案件・B.S.(必要70万)→80万案件が単価充足で成立、C.T.(必要65万・Java)は60万案件が単価不足のため候補なし（閾値方式の実証）
- `npm run ses:web:demo` … `http://127.0.0.1:8788` でダッシュボード配信、`/api/data` がマッチ＋自社候補＋バンド別メトリクスを返し、`/api/status`（評価者名つき）・`/api/feedback`・`/api/skill-equivalence` が動作
- **バンド分け**: 成立候補1／交渉提案1／参考提案1（SaaS案件×R.T. スキル67%）／要確認1 を検出
- **フィードバックループ**: 確認UIから `React≈Next.js` を同義登録 → 再実行で参考提案が**成立候補へ昇格**（スキル100%）。`妥当`評価が strong バンドの妥当率100%としてメトリクスに反映。同義辞書・評価は共有ファイル（本番Notion）に評価者名つきで蓄積
- **全員に返信**: 生成下書きが `To=元送信者 / Cc=元の宛先（メーリス sales@ 含む）/ Re:件名 / In-Reply-To`（スレッド返信）になり、`From` は確定まで placeholder。`/api/make-draft` に送信元メールを渡すと From が本人アドレスに確定（空欄は拒否）。本番は本人のGmailにスレッド返信下書きを作成

## 申し送り

- スプシ全タブ読取・自社社員DB(Notion)・ステータスのNotion同期は**本番経路**（実Google/Notion認証が必要）で、この環境では未疎通。本番投入時に疎通確認が必要。
- 自社社員→案件の紹介メール下書き自動生成は本追加では対象外（案件候補の提示まで）。必要なら次段で `draft.ts` を流用して追加可能。
- 確認UIのレビュー領域(`data/ses-review/`)は系のstore(Notion)とは別の作業領域。本番ではNotionが正、UIはレビュー用キャッシュとして機能し、ステータス更新をNotionへ同期する。
