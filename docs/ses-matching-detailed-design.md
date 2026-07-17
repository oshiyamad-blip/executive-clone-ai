# SES案件・要員マッチングシステム 詳細設計書

作成日: 2026-07-17 ／ ステータス: 実装検証完了 ／ 対象読者: 運用・保守担当（Sonnet）

本書は [`docs/ses-matching-basic-design.md`](./ses-matching-basic-design.md)（基本設計・How の骨格）の
下位文書として、`src/ses/` 配下および拡張ファイルの**実装に即した**内部ロジック・関数仕様・エラー処理方針・
demo/本番分岐・テスト観点・既知の制約をまとめる。基本設計と重複する章立て（型定義・Notion DB設計等）は
再掲せず差分のみ記す。実装で基本設計から変更した点は本書で理由を明記する。

**検証結果サマリ**（本書作成時点で実施済み）:

| 項目 | 結果 |
|---|---|
| `npm run build`（tsc, strict/noUnusedLocals/noUnusedParameters） | 成功（エラー0件） |
| `npm run ses:demo`（ANTHROPIC_API_KEY未設定環境） | 外部呼び出しなしで完走。`data/ses-demo/{projects,engineers,matches,drafts}.json` 生成 |
| `MIN_GROSS_MARGIN_JPY=50000` → `npm run ses:demo` | マッチ候補 計2件（成立1・要確認1） |
| `MIN_GROSS_MARGIN_JPY=200000` → `npm run ses:demo` | マッチ候補 計1件（成立0・要確認1） |
| `npm run ses:collect` / `npm run ses:match` | 単体実行も正常動作（demoフォールバック込み） |

---

## 1. 実装検証で発見・修正した問題

### 1.1 `package.json` に `ses*` スクリプトが未追加（修正済み）

基本設計 §10 で定義された npm scripts（`ses` / `ses:demo` / `ses:collect` / `ses:match`）が
`package.json` に反映されていなかった（前セッションのWIPコミット時点で漏れ）。本タスクで追記した。

```jsonc
"ses": "tsx src/ses/index.ts",
"ses:demo": "DEMO_MODE=true tsx src/ses/index.ts",
"ses:collect": "tsx src/ses/index.ts --collect-only",
"ses:match": "tsx src/ses/index.ts --match-only"
```

### 1.2 抽出段（Haiku 4.5）に `thinking: {type: 'adaptive'}` が無条件付与されていた（修正済み）

`src/llm/anthropic.ts` の `anthropicText` / `anthropicJson` / `anthropicJsonWithDocuments` は、
モデルに関わらず一律 `thinking: { type: 'adaptive' }` を付与していた。CLAUDE.md の全社方針
（「adaptive thinking を使う」）はグローバル既定モデル（`claude-opus-4-8`）を前提にしたもので、
Claude Opus/Sonnet の現行世代でのみ有効な設定である。SES抽出段（`extractModel()` 既定値
`claude-haiku-4-5`）はこの設定を受け付けない旧世代の思考パラメータ体系のモデルであり、
本番経路で `extractItems()` → `extractFromMail()` → `generateJson({ model: extractModel() })` が
呼ばれた際に **400 エラーになるリスク**があった。

修正: `src/llm/anthropic.ts` に `supportsAdaptiveThinking(model)` / `thinkingParam(model)` を追加し、
モデル名に `haiku` を含む場合は `thinking` パラメータ自体を省略する（Haiku系は思考なしで実行）よう分岐した。
Opus/Sonnet系（`matchModel()` 既定 `claude-sonnet-5`、グローバル既定 `claude-opus-4-8`）は従来どおり
`adaptive` を付与する。分類+抽出は構造化出力（JSON Schema）で十分な精度が出る定型タスクのため、
thinkingを省略しても機能要件（F3）に影響はない。

```ts
// src/llm/anthropic.ts（要旨）
function supportsAdaptiveThinking(model: string): boolean {
  return !model.includes('haiku');
}
function thinkingParam(model: string): { type: 'adaptive' } | undefined {
  return supportsAdaptiveThinking(model) ? { type: 'adaptive' } : undefined;
}
// 呼び出し側: ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {})
```

この分岐は demo 経路には影響しない（demoは `extractItemsDemo` でLLMを一切呼ばないため）。
本番経路のみ影響する修正であり、`npm run ses:demo` の完走とは独立に検証が必要な項目である
（§5 テスト観点を参照）。

### 1.3 `.env.example` / `scripts/setup.mjs` にSES設定項目が未反映（修正済み）

基本設計 §9 で「`scripts/setup.mjs` が生成する `.env.local` テンプレートにも追記する」とされていたが、
反映されていなかった。`scripts/setup.mjs` は `.env.example` を `.env.local` にコピーするだけの実装のため、
`.env.example` の末尾に `MIN_GROSS_MARGIN_JPY` 等15項目を追記した（キー一覧は基本設計 §9 と同一）。

---

## 2. モジュール別 内部ロジックと関数仕様

基本設計 §4 のI/Fに対し、実装では2箇所でシグネチャを拡張している（後方互換の範囲内・呼び出し元は
`src/ses/index.ts` のみのため影響範囲は閉じている）。まずこの差分を明記し、以降は実装済みシグネチャで説明する。

### 2.1 基本設計からのシグネチャ差分

| 関数 | 基本設計 | 実装 | 理由 |
|---|---|---|---|
| `createDrafts` | `(matches: MatchResult[]) => Promise<MatchResult[]>` | `(matches, projects: Project[], engineers: Engineer[]) => Promise<MatchResult[]>` | 下書き本文に案件・要員の詳細（スキル・単金・宛先メール等）を反映する必要があり、`MatchResult` 単体（ID参照のみ）では情報が不足するため。`projectId`/`engineerId` から `Project`/`Engineer` を引く `Map` をモジュール内で構築する設計とした |
| `persistAndNotify` | `(matches: MatchResult[]) => Promise<void>` | `(matches, projects: Project[], engineers: Engineer[]) => Promise<void>` | Notionマッチ結果DBの `relation` プロパティ（案件・要員へのリンク）を張るために、案件・要員側の `notionPageId` が必要なため |

いずれも `src/ses/index.ts`（オーケストレータ）内で完結する呼び出しであり、外部モジュールからの利用は無いため
後方互換上の問題はない。

### 2.2 `src/ses/config.ts` — 設定の一元管理

全関数が `process.env.X ?? default` の同期関数（副作用なし・例外を投げない）。実装は基本設計どおりで差分なし。
`isDemo()` が全モジュールの唯一の分岐点であることを保証するため、**他のどのファイルも `process.env` を
直接読まない**（`config.ts` 経由のみ）— grep で確認済み（`src/ses/*.ts` 内で `process.env` を直接参照する
のは `config.ts` のみ）。

`isDemo()` の判定式: `process.env.DEMO_MODE === 'true' || !process.env.ANTHROPIC_API_KEY`。
この後者の条件（キー未設定で自動demo）により、`npm run ses` や `npm run ses:collect`（`DEMO_MODE=true`を
明示しないスクリプト）であっても、`ANTHROPIC_API_KEY` 未設定環境では自動的にdemo経路にフォールバックする
（§5.1-6で実測確認済み）。これは「本番スクリプトを誤って鍵なし環境で実行しても外部に何も送信されない」
という安全側の縮退動作であり、意図的な設計。

### 2.3 `src/ses/collect.ts` — 収集

```ts
export async function collectSesMail(): Promise<SesRawMail[]>
```

- **demo**: `loadFixtureMails()`（`fixtures/mails.ts`、7通固定）をそのまま返す。処理済みID管理は行わない
  （「毎回fixture全件で決定的に完走」という設計意図どおり、`isDemo()` 分岐が `loadProcessedMailIds`/
  `markMailProcessed` の呼び出し自体をスキップする）。
- **本番**: `collectFromGmail()` が `src/collectors/email.ts` の `collectSesRawMail(query)` を呼ぶ。
  クエリは `newer_than:1d -in:drafts -in:spam -in:trash` に `SES_TARGET_GMAIL` 設定があれば
  ` to:<address>` を付加。取得後 `loadProcessedMailIds()` で処理済みIDを除外し、未処理分のみ返す。
- **エラー処理**: `collectFromGmail` 内部（`collectSesRawMail`）はGmail API呼び出し全体を try/catch し、
  失敗時は空配列＋`console.error`。呼び出し元 `src/ses/index.ts` の `collectAndStore()` でもさらに
  try/catch しており二重に保護されている（後述 §3）。

### 2.4 `src/ses/parse.ts` — 添付・リンク展開

```ts
export async function parseAttachments(mails: SesRawMail[]): Promise<SesRawMail[]>
```

- **demo**: `isDemo()` なら即座に `mails` をそのまま返す（fixtureは `attachments[].text` 済み）。
- **本番**: メール単位で try/catch。xlsx変換（`xlsxToText`）とスプレッドシートリンク展開
  （`parseSheetLinks`）を行い、**いずれかが失敗しても該当メールを丸ごと落とさず、本文のみで後続に渡す**
  （`parsed.push(mail)` フォールバック）。PDF添付は `isExcelMime` 判定に該当しないため `text` を
  埋めずそのまま温存し、`extract.ts` 側で `document` ブロックとして扱われる。
- **Google認証未設定時**: `getGoogleAuth()` が `null` を返すため、スプレッドシートリンクがあっても
  `console.warn` して空配列（該当メールにスプシ由来の添付は追加されない）。xlsx変換自体は
  Google認証と無関係（`xlsx` パッケージのみで完結）なため独立して動作する。

### 2.5 `src/ses/extract.ts` — 分類+抽出

```ts
export async function extractItems(mails: SesRawMail[]): Promise<ExtractedItem[]>
```

- **demo**: `EXPECTED_EXTRACTIONS[mail.id]`（固定マッピング）を返す。未定義IDは `[{ kind: 'other' }]`
  にフォールバックするため、fixture外のメールIDが混入しても例外にならない。
- **本番**: メール単位で `extractFromMail(mail)` を呼び、1メールの失敗は他メールに波及しない
  （try/catch を `extractItems` のループ内に配置）。
  - PDF添付（`mimeType === 'application/pdf' && data`）があれば `anthropicJsonWithDocuments`
    （`document` ブロック + 構造化出力）、無ければ通常の `generateJson`（`LLM_PROVIDER` 抽象化層経由。
    Geminiプロバイダ利用時はこちらの経路のみ通る — PDF documentブロックはAnthropic固有機能のため、
    Gemini運用時はPDF添付があっても通常の抽出プロンプトに本文テキストのみで処理される点に注意。
    ただしPDFの `text` フィールドは埋まらないため、実質的にPDFの内容はGemini運用時は抽出対象から
    漏れる。設計上Anthropicプロバイダを前提とする理由の一つ）。
  - 抽出結果0件（`projects`も`engineers`も空配列）の場合は `[{ kind: 'other' }]` に変換して返す
    （「案件でも要員でもないメールはother」という基本設計の意図をコード側でも保証）。
- **決定的ID生成**: `hashId('proj'|'eng', [mail.id, title|displayName, agentEmail])` で
  `sha1` の先頭12文字を使う。同一メールの再処理（本番でも processed-ids 漏れ等で再度流れた場合）で
  同一IDが生成されるため、Notion側の重複登録は `saveProject`/`saveEngineer` 呼び出し回数としては
  重複するが、決定的ID自体は再現される（ただしNotion側に一意制約は無いため、page自体は複数生成されうる —
  §6 既知の制約を参照）。
- **単金・都道府県正規化はこの層で完結**: `normalizeRate`（`pricing.ts`）と `normalizePrefecture`
  （`prefecture.ts`）を `buildProject`/`buildEngineer` 内で適用してから `Project`/`Engineer` を返す。
  以降の `match.ts` は正規化済みの値のみを扱う。

### 2.6 `src/ses/match.ts` — マッチング

```ts
export function primarySelect(projects: Project[], engineers: Engineer[]): MatchPair[]  // 純関数
export async function matchAll(projects: Project[], engineers: Engineer[]): Promise<MatchResult[]>
```

`primarySelect` は外部依存ゼロの同期純関数（LLM・ファイルI/O・Notion呼び出しなし）。demo/本番で
**完全に同一のコードパス**を通る（`isDemo()` 分岐を持たない）。判定順序は `evaluatePair` 内で:

1. スキル一致率（`skillMatchRate(required, have) < skillMatchThreshold()` で除外）
2. 勤務地（`remote==='full'` または `isAdjacentOrSame(prefecture)`。両方 `null` なら通過＋`needsReview`）
3. 時期（`startDate`/`availableFrom` のいずれかが `null` なら猶予判定をスキップして通過。両方既知なら
   `matchTimingGraceDays()` 日以内かで判定し、不整合なら除外）
4. 粗利（`rateMax`/`desiredRate` のいずれかが `null` なら判定不能として通過＋`needsReview`＋
   `grossMarginJpy=0`。両方既知なら `(rateMax - desiredRate) × 10000 < minGrossMarginJpy()` で除外）

案件ごとに通過ペアを「粗利額 降順 → スキル一致率 降順」でソートし `maxCandidatesPerItem()` 件に切り詰める
（`Array.prototype.slice`）。これによりLLM最終判定に回るペア数の上限がバッチ全体で
`案件数 × maxCandidatesPerItem()` に構造的に制限される。

**勤務地判定の一次選抜規約（基本設計に無い実装詳細)**: `bothPrefectureUnknown` は「両方が `null`」の
場合のみ真になる（`&&`）。**片方だけ `null`**（例: 案件側は都道府県が特定できたが要員側の居住地表記から
判定できなかった）の場合は `isAdjacentOrSame(a, null)` が常に `false` を返す実装（`prefecture.ts`）のため、
`needsReview` にはならず**候補から除外**される。粗利・時期は「どちらか不明なら緩める」という設計だが、
勤務地のみ「両方不明」を要求しており非対称になっている。基本設計文面（§7.1-4）も「両方 null」とだけ
書かれているため実装は文面には忠実だが、他2条件との対称性という観点では意図的な仕様差である。
運用上の影響は小さい（居住地・勤務地はメール本文に明記されるケースが大半でnull化しにくい項目のため）
が、抽出精度チューニング時に想定外の除外が増えた場合はここを疑うこと。

**最終判定**: `pair.needsReview || isDemo()` の場合は必ず `buildHeuristicResult`（LLM不使用）。
それ以外は `judgeWithLlm`（Sonnet 5、`matchModel()`）を試み、例外時は `buildHeuristicResult` に
フォールバックする（1ペアの判定失敗がバッチ全体を止めない）。ヒューリスティックのスコア式:
`round(skillMatchRate×70 + (locationOk?20:0) + (timingOk?10:0))`（0〜100の範囲は数式上自明に収まる）。

### 2.7 `src/ses/draft.ts` — 紹介メール下書き生成

```ts
export async function createDrafts(
  matches: MatchResult[], projects: Project[], engineers: Engineer[],
): Promise<MatchResult[]>
```

- `needsReview===true` のマッチは下書き対象外（`results.push(match)` のみでスキップ）— 単金・勤務地等の
  情報が不足しており、人が内容を補ってから紹介すべきという業務判断をコードで強制している。
- `projectMap`/`engineerMap`（`Map<id, T>`）で `match.projectId`/`match.engineerId` から実体を解決。
  見つからない場合（理論上は起きないはずだが、demo成果物の手動編集や将来のデータ不整合に備えた防御的
  分岐）は `console.warn` して下書きなしでスキップする。
- **demo**: `createDemoDraftPair` がテンプレート文字列を組み立て、`data/ses-demo/drafts/demo_draft_<n>.txt`
  にプレーンテキストで保存（`To:`/`Subject:`ヘッダ+本文）。`demoDraftCounter` はモジュールスコープの
  可変状態で連番を振る（プロセス内で単調増加。バッチ内で複数回 `createDrafts` を呼ぶ設計ではないため
  問題にならない）。加えて全下書きの索引を `writeDemoArtifact('drafts', demoRecords)` で
  `drafts.json` にまとめて出力する。
- **本番**: `getGoogleAuth()` が `null`（Google認証未設定）ならテンプレート生成すらせず空の `DraftRef`
  （`draftId: ''`）を返し `console.warn`。認証があれば `generateText`（`matchModel()`＝Sonnet 5）で
  案件側・要員側それぞれの本文を**並列生成**（`Promise.all`）し、`gmail.users.drafts.create` で下書きのみ
  作成する（**送信APIは呼ばない** — 要件F5「自動送信はしない」をコード構造で保証）。
- **単金開示の抑制**: `DRAFT_SYSTEM` プロンプトで「単金の開示は商習慣上センシティブなため断定しない
  表現にする」と明示的に指示し、demoテンプレートも「★送付前に単金開示の要否をご確認ください」という
  注記付きで希望単金を表示する（案件側テンプレートのみ。要員側は案件単金レンジを表示するがこちらは
  募集要項として通常公開される情報のため注記なし）。

### 2.8 `src/ses/notify.ts` — 保存+通知

```ts
export async function persistAndNotify(
  matches: MatchResult[], projects: Project[], engineers: Engineer[],
): Promise<void>
```

- `projectPageIds`/`engineerPageIds`（`Map<id, notionPageId|undefined>`）を構築し `saveMatch` の
  `relation` 引数に渡す。`persistMatches` はマッチ単位で try/catch し、1件の保存失敗が他のマッチ保存を
  止めない。
- **0件でも通知する**（要件F6）: `buildSummary([])` は「今回のバッチで粗利条件を満たすペアは
  検出されませんでした。」という文言を出す分岐を持ち、`matches.length===0` でも `notifySummary` は
  必ず呼ばれる（`persistAndNotify` 自体に早期returnが無いため）。
- **demo**: `writeDemoArtifact('matches', matches)` の後、`console.log` でサマリ全文を出力して終了
  （`isDemo()` で即 `return`、Gmail送信は試みない）。
- **本番**: コンソール出力に加え、`SES_NOTIFY_TO` が空なら送信スキップ（警告ログ）、
  Google認証未設定なら同様にスキップ。いずれも揃っていれば `gmail.users.messages.send` で
  サマリメールを送信（下書きではなく送信 — 要件F6は「バッチ実行後にサマリを通知」であり
  紹介メール本体とは異なる自動送信要件のため矛盾しない）。

### 2.9 補助モジュール（`skillDict.ts` / `prefecture.ts` / `pricing.ts` / `store.ts`）

いずれも外部I/O非依存の純粋ロジック（`store.ts` のファイルI/O部分を除く）。基本設計どおりの実装で
差分なし。`store.ts` の名寄せ（`dedupeProjects`/`dedupeEngineers`）は文字bigramのJaccard類似度
（閾値0.8）で、`src/dedup/index.ts`（既存機能）の手法を`Project`/`Engineer`向けに軽量再実装したもの
（既存 `dedup` モジュールの型が `RawLog` に特化しているため共有していない。将来的にジェネリック化して
統合する余地はあるが、現状は独立実装で問題ない）。

### 2.10 `src/ses/index.ts` — オーケストレータ

```ts
export interface SesBatchOptions { collectOnly?: boolean; matchOnly?: boolean }
export async function runSesBatch(opts?: SesBatchOptions): Promise<void>
```

処理順序: `collectAndStore()`（①〜④） → `matchDraftAndNotify()`（⑤〜⑦）。`--collect-only` は前者のみ、
`--match-only` は `loadExisting()`（本番=Notion `fetchOpenProjects`/`fetchAvailableEngineers`、
demo=直前の `data/ses-demo/{projects,engineers}.json`）で案件・要員を読み込んでから後者のみ実行する。

**`--match-only` のdemoフォールバック**: 直前のdemo成果物が無い場合（`readDemoArtifact` が空配列を返す
場合）、`loadExisting` は自動的に `collectAndStore()` を呼んでデータを作ってから続行する
（`console.warn` で「先に収集・保存から実行します」と明示）。これにより `npm run ses:match` を
単独で最初に叩いても失敗しない（§5で実測確認）。

**Date復元**: demoの `--match-only` はJSONから読み戻すため `receivedAt` が文字列になっている点を
`new Date(p.receivedAt)` で明示的に復元している（他の日付文字列フィールド `startDate`/`availableFrom`
はISO文字列のまま保持する設計＝もともと `string | null` 型のため復元不要）。

**各段のエラー処理方針（全段共通）**: `collectAndStore`/`matchDraftAndNotify` 内の各ステップは
個別に try/catch され、失敗しても変数を空/直前の値のまま後続に渡す。これにより「添付展開が1件失敗した
せいで案件抽出が0件になり、結果としてサマリメールすら届かない」という**カスケード的な機能停止を防ぐ**
設計になっている（CLAUDE.md「外部APIは try/catch」方針の徹底）。

---

## 3. エラー処理方針（全体まとめ）

| 層 | 方針 | 実装箇所 |
|---|---|---|
| 外部API呼び出し（Gmail/Sheets/Anthropic/Notion） | try/catch で吸収し `console.error`/`console.warn` + 空配列やフォールバック値を返す | 各モジュールの本番分岐 |
| バッチのステップ間 | 各ステップを `index.ts` 側でも try/catch し、前段が全滅しても後段を実行（可能な範囲で） | `collectAndStore`/`matchDraftAndNotify` |
| 1件の失敗 vs 全体停止 | メール単位・ペア単位・マッチ単位でループ内 try/catch し、1件の失敗が全体を止めない | `extractItems`/`matchAll`/`createDrafts`/`persistMatches` |
| LLM判定の失敗 | ヒューリスティック（決定的スコア式）にフォールバックし、マッチ自体は落とさない | `matchAll` の `judgeWithLlm` catch節 |
| 環境変数未設定 | 例外を投げず空文字列・既定値・`console.warn` で縮退動作 | `config.ts` 全関数、`saveProject`/`saveEngineer`/`saveMatch` の DB ID 未設定チェック |
| トップレベル | `runSesBatch(...).catch(console.error)` で最終防波堤 | `index.ts` 末尾 |

この多層防御により、「Gmail収集は成功したがGoogle Sheets APIだけ落ちている」「Notion保存は失敗するが
下書き生成とサマリ通知はできる」といった部分故障時も、可能な範囲で最後まで到達しサマリを出す設計になっている。

---

## 4. demo/本番分岐の一覧（実装確認込み）

| 段 | 分岐点 | demo実装 | 外部呼び出し |
|---|---|---|---|
| collect | `collect.ts` 冒頭 `if (isDemo())` | `loadFixtureMails()` | なし |
| parse | `parse.ts` 冒頭 `if (isDemo())` | 入力をそのまま返す | なし |
| extract | `extract.ts` 冒頭 `if (isDemo())` | `EXPECTED_EXTRACTIONS` 固定マッピング | なし |
| store | `index.ts` の `storeProjects`/`storeEngineers` 内 `if (isDemo())` | `writeDemoArtifact` | なし |
| match一次選抜 | 分岐なし（純関数） | `primarySelect` をdemo/本番共通実行 | なし |
| match最終判定 | `matchAll` 内 `pair.needsReview \|\| isDemo()` | ヒューリスティックスコア | なし |
| draft | `draft.ts` 内 `isDemo() ? ... : ...` | テンプレート文 + ローカルファイル | なし |
| notify（保存） | `persistMatches` 内 `if (isDemo())` | `writeDemoArtifact('matches', ...)` | なし |
| notify（通知） | `notifySummary` 内 `if (isDemo()) return` | `console.log` のみ | なし |

**確認方法**: `src/ses/` 配下で `Anthropic`/`googleapis`/`@notionhq/client` の実呼び出し
（`.create(`/`.get(`/`.send(`等）がdemo分岐より前に評価されないことをコードリーディングで確認し、
実測（`npm run ses:demo` 実行）でも例外・ハングなく完走することを確認した（§5）。

---

## 5. テスト観点

### 5.1 実施済み（本タスクで実行・確認）

1. `npm run build` — tsc（strict, noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch）通過
2. `npm run ses:demo` — 完走・`data/ses-demo/{projects,engineers,matches,drafts}.json` 生成・
   コンソールに日本語サマリ表示（成立候補1件・要確認1件・計2件）を確認
3. `MIN_GROSS_MARGIN_JPY=50000` / `=200000` の比較 — マッチ件数が2件→1件に変化することを確認
   （fixtureの P1×E1 ペアの粗利15万円/月が閾値50000円と200000円の間にあるため、この境界で
   確定/除外が切り替わる設計になっている。詳細は§5.3）
4. `npm run ses:collect`（`--collect-only`） — 案件4件・要員3件で収集・保存のみ終了することを確認
5. `npm run ses:match`（`--match-only`） — 直前の `ses:collect` 成果物を読み込んで①〜④を再実行せず
   ⑤〜⑦のみ実行されることを確認
6. `ANTHROPIC_API_KEY` 未設定環境で `DEMO_MODE` を明示しない `npm run ses:collect` を実行しても
   自動的にdemo経路になることを確認（`isDemo()` の後段条件）

### 5.2 fixture設計の網羅性（`src/ses/fixtures/`）

| ケース | メールID | 検証する分岐 |
|---|---|---|
| 成立（粗利十分・スキル一致・勤務地同一・時期一致） | `sesmail_demo_p1` × `sesmail_demo_e1` | 一次選抜通過→ヒューリスティック確定（demo） |
| 除外（粗利不足: 2万円/月 < 10万円/月） | `sesmail_demo_p2` × `sesmail_demo_e2` | `evaluatePair` の粗利条件で`null`返却 |
| 要確認（要員側単金「スキル見合い」でnull、勤務地は隣接） | `sesmail_demo_p1` × `sesmail_demo_e3` | `rateUnknown`→`needsReview=true` |
| 1通複数案件抽出 | `sesmail_demo_multi` | `extractFromMail` の配列展開（案件2件） |
| xlsx添付 | `sesmail_demo_p1` の `attachments[0].text` | parseの添付テキスト同梱 |
| スプレッドシートリンク | `sesmail_demo_multi` の `sheetLinks` | 本文中リンクの型(demoは展開スキップ) |
| その他メール（破棄） | `sesmail_demo_other` | `EXPECTED_EXTRACTIONS` 未定義→`other`扱い |

上記表の「除外」ケース（P2×E2）は `MIN_GROSS_MARGIN_JPY` を50000/200000のいずれに変更しても
常に除外され続ける（差額2万円は両閾値を下回る）。**マッチ件数が変化する境界を作っているのは
P1×E1ペア（差額15万円）のみ**であり、50000円設定では成立・200000円設定では除外となる。
テスト観点としてこの境界値の意味を記録しておく（fixtureを変更する際は境界特性を壊さないよう注意）。

### 5.3 未実施（実APIキーが無いため本タスクでは検証不可。本番投入前に必須）

- `ANTHROPIC_API_KEY` を設定した環境での `extractModel()`（Haiku 4.5）による実メール抽出精度検証
  （要件定義の「Test段階」に該当）。特に §1.2 で修正した thinking 分岐が実際に有効か
  （Haiku 4.5 に対して `thinking` パラメータなしで正常応答が返るか）を1コールで確認すること。
- `matchModel()`（Sonnet 5）による最終判定・下書き生成の実LLM呼び出し。
- Gmail下書き作成（`gmail.compose`スコープ）・サマリ送信（`gmail.send`スコープ）のDWDスコープ登録確認。
- Notion `saveProject`/`saveEngineer`/`saveMatch` の実DB書き込みとプロパティ型の整合性確認
  （`multi_select`の値がNotion側で自動作成されるか、`select`の未登録値でエラーにならないか等）。
- PDF添付（`document`ブロック）の実際の抽出精度と課金（ページ数比例）の実測。

---

## 6. 既知の制約

1. **Notion往復で一部フィールドが失われる**: `fetchOpenProjects`/`fetchAvailableEngineers`
   （`src/database/index.ts` の `projectFromPage`/`engineerFromPage`）は、Notionにプロパティとして
   保存していない項目（`duration`・`startDate`・`nearestStation`・`availableDate`・`age`）を
   空文字列/`null`で復元する。これは基本設計 §6 のNotion DBスキーマがこれらの列を持たないことに
   起因する仕様であり、実装のバグではない。影響は限定的（`startDate`が`null`化すると時期判定は
   「不明→緩めに通過」扱いになるだけで、除外方向には振れない）が、`--match-only` を本番で使う運用
   （Notionから読み直してマッチングし直す）では、初回抽出時より時期判定の精度が落ちる点に留意する。
2. **勤務地の一次選抜が粗利・時期と非対称**（§2.6既述）。「両方null」のみ`needsReview`扱いで、
   片方だけnullは除外される。
3. **`useBatchApi()` は未使用の予約設定**（Phase 3）。現状 `matchAll`/`extractItems`/`draft.ts` は
   すべて同期呼び出し（Message Batches API不使用）。メール量が増えた場合はここが最初のボトルネック
   （Anthropic APIのレート制限）になりうる。
4. **Gemini プロバイダ利用時はPDF添付が抽出対象から漏れる**（§2.5既述）。`LLM_PROVIDER=gemini` で
   SESを運用する場合、PDF形式のスキルシートは無視される（xlsx・スプシは問題なく動作する）。
   設計上Anthropicプロバイダでの運用を前提としており、基本設計 §5.3 の記載と整合する。
5. **`saveProject`/`saveEngineer` の決定的IDはNotion側の一意制約にはならない**（§2.5既述）。
   同一 `proj_<hash>` を持つ案件が処理済みIDの記録漏れ等で再度抽出されると、Notion上には別ページとして
   重複登録されうる。処理済みメールID管理（`markMailProcessed`）が主たる重複防止機構であり、
   決定的IDは名寄せ（bigram類似度）の入力キーとしての役割が主。
6. **demoの `demoDraftCounter` はプロセス内グローバル状態**。同一プロセスで `runSesBatch` を複数回
   呼ぶような利用（現状の `index.ts` のCLIエントリポイントでは発生しない）をした場合、下書き連番が
   プロセス起動からの累積になる。CLIバッチとして毎回新規プロセスで起動する運用である限り問題ない。
7. **単金「非開示」の抑制はプロンプト指示ベース**（§2.7既述）。LLM生成文面が指示に従わない可能性は
   構造的にはゼロにできない（本番運用時は生成文面のサンプリング確認を推奨。要件定義§10運用注意にも
   「紹介メールは下書き止まりで人間の最終確認を経る」とあり、この一次防御と合わせて二重に安全側)。

---

## 7. 変更ファイル一覧（本タスクでの追加修正分）

| ファイル | 変更内容 |
|---|---|
| `package.json` | `ses`/`ses:demo`/`ses:collect`/`ses:match` スクリプトを追加 |
| `src/llm/anthropic.ts` | `supportsAdaptiveThinking`/`thinkingParam` を追加し、Haiku系モデルには `thinking` パラメータを付与しないよう分岐（`anthropicText`/`anthropicJson`/`anthropicJsonWithDocuments`） |
| `.env.example` | SES関連設定15項目（`MIN_GROSS_MARGIN_JPY`ほか）を追記 |
| `docs/ses-matching-detailed-design.md` | 本書を新規作成 |

`src/ses/` 配下の実装（`config.ts`〜`fixtures/`）および `src/types/index.ts`・`src/llm/index.ts`・
`src/llm/gemini.ts`・`src/database/index.ts`・`src/collectors/{email,googleAuth}.ts` は、検証の結果
基本設計との整合性・strict TSビルド・オフラインdemo完走のいずれも問題なく、変更を加えていない。
