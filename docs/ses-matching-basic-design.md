# SES案件・要員マッチングシステム 基本設計書

作成日: 2026-07-17 ／ ステータス: 実装着手前レビュー用 ／ 対象読者: 実装担当（Sonnet）

本書は要件定義・設計書 [`docs/ses-matching-requirements.md`](./ses-matching-requirements.md) を上位文書とし、
その機能要件（F1〜F9）を実装可能な粒度まで具体化した**基本設計書**である。
実装コードは含まない（設計のみ）。章立ては既存の [`docs/requirements.md`](./requirements.md) と
[`docs/ses-matching-requirements.md`](./ses-matching-requirements.md) の流儀（背景 → 全体像 → 機能要件を表形式 → 非機能 → 技術 → 運用）を踏襲する。

---

## 1. 位置づけと設計方針

### 1.1 要件定義との関係

| 文書 | 役割 | 本書との関係 |
|---|---|---|
| `docs/ses-matching-requirements.md` | 要件定義・設計書（What / Why） | 上位文書。機能要件 F1〜F9・Notion DB設計・モデル選定・コスト試算の根拠。本書はこれと**整合必須** |
| **`docs/ses-matching-basic-design.md`（本書）** | 基本設計（How の骨格） | モジュール構成・型定義・関数I/F・アルゴリズム・demo設計・設定一覧を確定する |
| 後続の詳細実装（Sonnet） | 実装（How の詳細） | 本書のモジュールI/Fと型に従って `src/ses/` を実装する |

要件定義で「未確定 → A案推奨」とした項目（メール取得方式 = Xserver→Gmail転送 + Gmail API）は、本書では**確定事項**として設計する。

### 1.2 設計方針（既存資産の最大再利用）

要件定義 §6.3「再利用マップ」を実装レベルに落とす。**新規実装は `src/ses/` 配下に集約し、既存モジュールへは後方互換な拡張のみ**を加える。

| 原則 | 具体化 |
|---|---|
| 既存の「機能ディレクトリ + `index.ts` + npm script」流儀を踏襲 | パイプラインは `src/ses/` にモジュール分割、`src/ses/index.ts` をバッチのオーケストレータにする |
| 既存モジュールは壊さない | `src/llm`・`src/database`・`src/collectors/googleAuth.ts` は**シグネチャ後方互換で拡張**（引数追加・スコープ追加のみ）。既存機能の呼び出し側は無変更で動く |
| 縮退動作（CLAUDE.md） | 環境変数未設定・API障害時は該当ステップをスキップして継続（`?? ''` / 早期 return / `Promise.allSettled`） |
| demo と本番の分離（最重要） | `ANTHROPIC_API_KEY` も外部APIも無い環境で `npm run ses:demo` が**一切の外部呼び出しなしで完走**する。本番経路とは実行時ガードで分離（§8） |
| 設定の一元化 | SESは設定項目が多いため、`.env` の読み出しは `src/ses/config.ts` に集約（`Number(process.env.X ?? default)` 形式） |
| 言語 | UI/ログ/ドキュメント文言は日本語、コード・変数名は英語（CLAUDE.md準拠） |

---

## 2. システム全体像とモジュール構成

### 2.1 パイプライン

要件定義 §3 の7ステップを `src/ses/` に割り付ける。データは各段の戻り値として次段に渡す（バッチ内はメモリ受け渡し、プロセスをまたぐ生ログのみローカルJSON永続化）。

```
collect ─▶ parse ─▶ extract ─▶ store ─▶ match ─▶ draft ─▶ notify
 (①)      (②)       (③)        (④)      (⑤)      (⑥)      (⑦)
 Gmail    添付展開    Haiku抽出   Notion   一次選抜   Sonnet   Notion更新
 取得     xlsx/PDF/  分類+構造化  保存+    (無料)+   下書き    +サマリ
 添付DL   Sheets                名寄せ    Sonnet判定 生成      メール
```

各段は「本番経路」と「demo経路」の2実装を持ち、`src/ses/config.ts` の `isDemo()` で分岐する（§8）。

### 2.2 追加・拡張するファイル一覧

**新規追加（`src/ses/` 配下）**

| パス | 責務 |
|---|---|
| `src/ses/index.ts` | **バッチのオーケストレータ（エントリポイント）**。`import '../env.js'` を先頭に置き、collect→parse→extract→store→match→draft→notify を順に呼ぶ。各段は try/catch または `Promise.allSettled` でエラーを吸収し、途中段が落ちても後続を継続。`--collect-only` / `--match-only` の引数分岐で部分実行も可能にする。実行末尾で `main().catch(console.error)` |
| `src/ses/config.ts` | **設定の一元読み出し**（§9）。`isDemo()`・`minGrossMarginJpy()`・`maxCandidatesPerItem()` 等をすべてここで定義。全モジュールはここ経由で設定を参照し、`process.env` を直接読まない |
| `src/ses/collect.ts` | SES専用の収集ラッパー。本番は `collectSesMail()`（拡張した `src/collectors/email.ts` を SESクエリ・添付付きで呼ぶ）、demoは `loadFixtureMail()`（`src/ses/fixtures/` を読む）。戻り値は添付を同梱した `SesRawMail[]` |
| `src/ses/parse.ts` | 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、PDFは base64 のまま次段へ受け渡す。demoは fixture テキストをそのまま返す |
| `src/ses/extract.ts` | 分類+抽出（1メール1コール）。本番は Haiku 4.5 + 構造化出力、demoは fixture対応の**決定的スタブ**（LLM不使用）。戻り値は `ExtractedItem[]`（`Project` / `Engineer` の配列） |
| `src/ses/match.ts` | マッチング。一次選抜（純コード・無料、§7）→ 通過ペアのみ最終判定。本番は Sonnet 5、demoはテンプレート判定（LLM不使用）。戻り値は `MatchResult[]` |
| `src/ses/draft.ts` | 紹介メール2通生成。本番は Sonnet 5 でメール本文生成 → Gmail 下書き作成、demoはテンプレート文面 + ローカルJSON保存。戻り値は下書きIDを含む `DraftResult[]` |
| `src/ses/notify.ts` | マッチ結果DB更新 + サマリメール。本番は Notion 保存 + Gmail サマリ送信、demoはローカルJSON（`data/ses-demo/`）+ コンソール出力 |
| `src/ses/skillDict.ts` | スキル正規化辞書（表記ゆれ吸収）と正規化関数。extract/match の双方が参照 |
| `src/ses/prefecture.ts` | 都道府県隣接テーブルと隣接判定関数。match の勤務地判定が参照 |
| `src/ses/pricing.ts` | 単金正規化（万円/月・円/時→月額換算）。extract/match の双方が参照 |
| `src/ses/store.ts` | SES用ローカルストア。処理済みメールID管理（`src/store/rawLogStore.ts` と同型）+ demoの成果物（案件/要員/マッチ/下書き/サマリ）を `data/ses-demo/` に書き出す |
| `src/ses/fixtures/` | demo用の固定データ（fixtureメール本文・添付テキスト・スプシ内容）。`.ts` で型付きエクスポート（`src/demo/sampleData.ts` の流儀） |

**既存ファイルの拡張（後方互換）**

| パス | 拡張内容 |
|---|---|
| `src/types/index.ts` | `Project` / `Engineer` / `MatchResult` 型と補助型（§3）を追記。既存型は無変更 |
| `src/llm/index.ts` | `GenOptions` に `model?: string` を追加し、`generateJson`/`generateText` から下位へ伝播（§5）。既定は従来どおり env のグローバルモデル |
| `src/llm/anthropic.ts` | `anthropicJson`/`anthropicText` に `model?: string` 引数を追加。未指定時は従来の `MODEL` グローバル。PDF document ブロック対応のオーバーロード（§4.4）を追加 |
| `src/llm/gemini.ts` | `geminiJson`/`geminiText` に `model?: string` 引数を追加（Anthropicと対称。未指定時は従来の `MODEL`） |
| `src/database/index.ts` | `saveProject` / `saveEngineer` / `saveMatch` / `fetchOpenProjects` / `fetchAvailableEngineers` を `saveSignal` と同型で追加（§6）。既存関数は無変更 |
| `src/collectors/email.ts` | 添付ダウンロード対応（`messages.attachments.get`）と任意クエリ引数を追加。既存 `collectFromEmail()` は引数なしで従来動作を維持し、SES用はオーバーロード/別関数で提供 |
| `src/collectors/googleAuth.ts` | `SCOPES` に `gmail.compose`（下書き作成）と `spreadsheets.readonly`（Sheets読取）を追加 |
| `package.json` | npm scripts に `ses` / `ses:demo` 等を追加（§10） |

### 2.3 エントリポイント `src/ses/index.ts` の役割

- 既存バッチ（`src/collectors/index.ts`・`src/extractors/index.ts`）と同じく、**先頭で `import '../env.js'`** して `.env.local`→`.env` を読む。
- パイプライン全体を統括する `runSesBatch(opts)` を定義し、末尾で `runSesBatch(parseArgs()).catch(console.error)` を呼ぶ。
- 各段を **try/catch で囲み**、失敗しても後続段へ渡せるデータがあれば継続（例: draft が落ちても notify でサマリは出す）。
- 起動ログに `isDemo()` の値・粗利下限・候補上限を出力し、どのモードで動いているかを日本語で明示する。

---

## 3. 型定義（基本設計レベル）

`src/types/index.ts` に以下を追記する。単金はすべて **`number`（万円/月に正規化）** で保持する（要件定義 §4.1 の「万円/月」表記に合わせる。時給・円表記は取り込み時に §7.2 で換算）。不明値は `null`。

### 3.1 案件（Project）

```ts
// SES案件（要件定義 §4.1 の抽出スキーマに一致）
export interface Project {
  id: string;                       // 'proj_<hash>' 決定的ID（名寄せキーにも使う）
  title: string;                    // 案件名
  requiredSkills: string[];         // 必須スキル（正規化済み）
  preferredSkills: string[];        // 尚可スキル（正規化済み）
  rateMin: number | null;           // 単金下限（万円/月）。「スキル見合い」等は null
  rateMax: number | null;           // 単金上限（万円/月）
  location: string;                 // 勤務地（都道府県+市区）
  prefecture: string | null;        // 正規化した都道府県名（隣接判定用。抽出できなければ null）
  remote: RemoteOption;             // リモート可否
  startPeriod: string;              // 開始時期（原文文字列）
  startDate: string | null;         // 正規化した開始日 ISO（突合用。不明は null）
  duration: string;                 // 期間（原文文字列）
  businessFlow: string;             // 商流制限・外国籍可否・面談回数などの原文メモ
  agentCompany: string;             // 営業元 会社名
  agentContact: string;             // 営業元 担当者名
  agentEmail: string;               // 営業元 メールアドレス（紹介メール宛先に使用）
  sourceMailId: string;             // 抽出元メールID（原文参照リンク用）
  receivedAt: Date;                 // 受信日時
  status: ProjectStatus;            // 募集中 / 終了
  notionPageId?: string;
}

export type RemoteOption = 'full' | 'partial' | 'none' | 'unknown';  // フル/一部/不可/不明
export type ProjectStatus = 'open' | 'closed';                      // 募集中 / 終了
```

### 3.2 要員（Engineer）

```ts
// SES要員（エンジニア）。要件定義 §4.2 の抽出スキーマに一致。氏名等はPII（§5非機能）
export interface Engineer {
  id: string;                       // 'eng_<hash>' 決定的ID
  displayName: string;              // 表示名（イニシャル推奨）
  age: number | null;               // 年齢（PII）
  skills: string[];                 // スキル（正規化済み）
  experienceYears: number | null;   // 経験年数
  desiredRate: number | null;       // 希望単金（万円/月）。不明は null
  residence: string;                // 居住地（原文）
  prefecture: string | null;        // 正規化した都道府県名（隣接判定用）
  nearestStation: string;           // 最寄り駅
  availableDate: string;            // 稼働開始可能日（原文文字列）
  availableFrom: string | null;     // 正規化した稼働可能日 ISO（不明は null）
  utilization: string;              // 稼働率（原文。例「週5」「週3〜」）
  remoteWish: RemoteOption;         // リモート希望
  agentCompany: string;             // 営業元 会社名
  agentContact: string;             // 営業元 担当者名
  agentEmail: string;               // 営業元 メールアドレス
  sourceMailId: string;
  receivedAt: Date;
  status: EngineerStatus;           // 提案可 / 決定済
  notionPageId?: string;
}

export type EngineerStatus = 'available' | 'assigned';  // 提案可 / 決定済
```

### 3.3 マッチ結果（MatchResult / MatchPair）

```ts
// 一次選抜を通過した候補ペア（LLM最終判定への入力）
export interface MatchPair {
  project: Project;
  engineer: Engineer;
  grossMarginJpy: number;           // 粗利額（円/月）= (案件単金上限 − 要員希望単金) × 10000
  skillMatchRate: number;           // 必須スキル一致率 0〜1
  locationOk: boolean;              // 勤務地条件を満たすか
  timingOk: boolean;                // 時期条件を満たすか
  needsReview: boolean;             // 単金不明などで「要確認」枠か
}

// 最終判定・保存対象のマッチ結果（要件定義 §6.4 マッチ結果DBに対応）
export interface MatchResult {
  id: string;                       // 'match_<projId>_<engId>' 決定的ID（再実行冪等）
  projectId: string;
  engineerId: string;
  title: string;                    // 「案件名 × 要員表示名」
  grossMarginJpy: number;           // 粗利額（円/月）
  score: number;                    // 適合スコア 0〜100（最終判定。demoはヒューリスティック）
  reason: string;                   // 判定根拠文
  needsReview: boolean;             // 単金不明などの要確認フラグ
  draftToProject?: DraftRef;        // 案件側営業宛 下書き
  draftToEngineer?: DraftRef;       // 要員側営業宛 下書き
  status: MatchStatus;              // 未確認 / 紹介済 / 成約 / 見送り
  detectedAt: Date;
  notionPageId?: string;
}

export interface DraftRef {
  draftId: string;                  // Gmail下書きID（demoはローカルID）
  url: string;                      // 下書きURL（demoはローカルファイルパス）
  to: string;                       // 宛先メールアドレス
  subject: string;
}

export type MatchStatus = 'unconfirmed' | 'introduced' | 'closed_won' | 'dropped';
// 未確認 / 紹介済 / 成約 / 見送り
```

### 3.4 収集・抽出の中間型

```ts
// 添付を同梱した収集メール（parse への入力）。既存 RawLog を包含する
export interface SesRawMail {
  id: string;                       // 'sesmail_<gmailId>'
  from: string;
  to: string;
  subject: string;
  body: string;                     // text/plain 本文
  receivedAt: Date;
  attachments: SesAttachment[];     // 添付（xlsx/pdf）
  sheetLinks: string[];             // 本文中の Google スプレッドシートURL
}

export interface SesAttachment {
  filename: string;
  mimeType: string;                 // 'application/pdf' | xlsx系 MIME
  data: string;                     // base64（PDFはそのままdocumentブロックへ）
  text?: string;                    // parseでテキスト化した結果（xlsx/Sheets）
}

// extract の出力（1メールから0件以上）。種別で判別可能なユニオン
export type ExtractedItem =
  | { kind: 'project'; project: Project }
  | { kind: 'engineer'; engineer: Engineer }
  | { kind: 'other' };              // 案件でも要員でもない（破棄）
```

> 補足: `DataSource` union（既存）はメール収集に `'email'` を再利用するため拡張不要。SES専用の中間表現は上記 `SesRawMail` を用いる。

---

## 4. モジュールI/F（公開関数シグネチャ）

各モジュールの公開関数を列挙する。実装担当はこの署名に従う。すべて ESM・`.js` 拡張子付き相対 import。

### 4.1 `src/ses/config.ts`

```ts
export function isDemo(): boolean;                 // DEMO_MODE==='true' || !process.env.ANTHROPIC_API_KEY
export function minGrossMarginJpy(): number;       // 既定 100000
export function maxCandidatesPerItem(): number;    // 既定 5
export function skillMatchThreshold(): number;     // 既定 0.6
export function hourlyToMonthlyHours(): number;    // 既定 160
export function sesTargetGmail(): string;          // 既定 ''
export function sesNotifyTo(): string;             // 既定 ''
export function extractModel(): string;            // ANTHROPIC_MODEL_EXTRACT ?? 'claude-haiku-4-5'
export function matchModel(): string;              // ANTHROPIC_MODEL_MATCH ?? 'claude-sonnet-5'
export function notionProjectDbId(): string;
export function notionEngineerDbId(): string;
export function notionMatchDbId(): string;
export function useBatchApi(): boolean;            // 既定 false（Phase3で参照）
export function demoDataDir(): string;             // 'data/ses-demo'
```

### 4.2 `src/ses/collect.ts`

```ts
// 本番: 拡張 email.ts を SESクエリ+添付付きで呼ぶ / demo: fixtureメール読込。
// 二重処理防止（処理済みID）を内部で適用し、未処理メールのみ返す。
export async function collectSesMail(): Promise<SesRawMail[]>;
```

### 4.3 `src/ses/parse.ts`

```ts
// 各メールの添付xlsx/スプシリンクをテキスト化し attachments[].text を埋めて返す。
// PDFは data(base64) のまま温存。demoは fixture テキストをそのまま返す。
export async function parseAttachments(mails: SesRawMail[]): Promise<SesRawMail[]>;
```

### 4.4 `src/ses/extract.ts`

```ts
// 1メール=1コールで分類+抽出。本番=Haiku+構造化出力 / demo=決定的スタブ。
export async function extractItems(mails: SesRawMail[]): Promise<ExtractedItem[]>;

// 内部: 1メール分。PDF添付があれば document ブロックで渡す（本番のみ）
// export async function extractFromMail(mail: SesRawMail): Promise<ExtractedItem[]>;
```

PDF を扱うため `src/llm/anthropic.ts` に **document ブロック対応の入力**を追加する。抽出用の低レベル関数を新設し、`extract.ts` からはこれを呼ぶ:

```ts
// src/llm/anthropic.ts に追加（本番のPDF読解用）
export async function anthropicJsonWithDocuments(
  system: string,
  user: string,
  schema: object,
  documents: Array<{ mediaType: 'application/pdf'; dataBase64: string }>,
  maxTokens: number,
  model?: string,
): Promise<unknown>;
```

### 4.5 `src/ses/match.ts`

```ts
// 一次選抜（純コード）→ 候補ペアのみ最終判定（本番=Sonnet / demo=テンプレート）。
export async function matchAll(
  projects: Project[],
  engineers: Engineer[],
): Promise<MatchResult[]>;

// 一次選抜のみ（LLM不使用・テスト可能な純関数）
export function primarySelect(
  projects: Project[],
  engineers: Engineer[],
): MatchPair[];
```

### 4.6 `src/ses/draft.ts`

```ts
// 成立マッチごとに紹介メール2通を生成し下書き保存。MatchResult に draftRef を付与して返す。
export async function createDrafts(matches: MatchResult[]): Promise<MatchResult[]>;
```

### 4.7 `src/ses/notify.ts`

```ts
// マッチ結果を保存し（本番=Notion / demo=ローカルJSON）、サマリを通知（本番=Gmail送信 / demo=コンソール）。
// 0件でも実行結果を通知する（要件 F6）。
export async function persistAndNotify(matches: MatchResult[]): Promise<void>;
```

### 4.8 補助モジュール

```ts
// src/ses/skillDict.ts
export function normalizeSkill(raw: string): string;          // 'JAVA'→'Java' 等
export function normalizeSkills(raw: string[]): string[];

// src/ses/prefecture.ts
export function normalizePrefecture(location: string): string | null; // 住所文字列→都道府県名
export function isAdjacentOrSame(a: string, b: string): boolean;       // 隣接 or 同一

// src/ses/pricing.ts
export type RateUnit = 'manYenPerMonth' | 'yenPerHour' | 'yenPerMonth';
// 各種表記を「万円/月」の number に正規化。'スキル見合い' 等は null。
export function normalizeRate(value: number, unit: RateUnit): number;
export function skillMatchRate(required: string[], have: string[]): number; // 0〜1

// src/ses/store.ts
export function loadProcessedMailIds(): Set<string>;
export function markMailProcessed(ids: string[]): void;
export function writeDemoArtifact(name: string, data: unknown): void; // data/ses-demo/<name>.json
```

### 4.9 `src/ses/index.ts`

```ts
export interface SesBatchOptions {
  collectOnly?: boolean;   // ①〜④まで（保存で止める）
  matchOnly?: boolean;     // ⑤〜⑦のみ（既存DBから読んで突合）
}
export async function runSesBatch(opts?: SesBatchOptions): Promise<void>;
```

---

## 5. 段階別モデル選定の統合設計

### 5.1 段階別モデルの割り当て（要件定義 §7.1）

| 段階 | モデル | 呼び出し | 設定キー |
|---|---|---|---|
| ③ extract（分類+抽出） | **Claude Haiku 4.5** | 全メール1コール（最多） | `ANTHROPIC_MODEL_EXTRACT` |
| ⑤ match 一次選抜 | **LLM不使用** | 純コード（無料） | — |
| ⑤ match 最終判定 | **Claude Sonnet 5** | 候補ペアのみ | `ANTHROPIC_MODEL_MATCH` |
| ⑥ draft メール生成 | **Claude Sonnet 5** | 成立マッチ×2通 | `ANTHROPIC_MODEL_MATCH` |

### 5.2 既存 llm 層への通し方（単一グローバル → 段階別）

現状 `src/llm/anthropic.ts` は `MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'` の**単一グローバル**で、`generateJson`/`generateText` にモデル指定の口が無い。段階別モデルを流すため、以下の**後方互換な拡張**を行う。

1. `src/llm/index.ts` の `GenOptions` に `model?: string` を追加する。

```ts
export interface GenOptions {
  maxTokens?: number;
  model?: string;   // ← 追加。未指定なら各プロバイダの既定（env グローバル）
}
```

2. `generateJson`/`generateText` は `opts.model` を下位関数に渡す。

```ts
// generateJson 内部
return provider() === 'gemini'
  ? (geminiJson(system, user, schema, maxTokens, opts.model) as Promise<T>)
  : (anthropicJson(system, user, schema, maxTokens, opts.model) as Promise<T>);
```

3. `anthropic.ts` / `gemini.ts` の各関数に `model?: string` 引数を末尾追加し、`model ?? MODEL`（Anthropic）/ `model ?? MODEL`（Gemini）で解決する。**未指定時は従来のグローバル**を使うため、既存の全呼び出し側（extractors・analyzers・clone/engine 等）は無変更で従来通り動く。

```ts
// anthropic.ts（例）
export async function anthropicJson(
  system: string, user: string, schema: object, maxTokens: number, model?: string,
): Promise<unknown> {
  const response = await client().messages.create({
    model: model ?? MODEL,
    ...
  });
}
```

4. SES 側は `src/ses/config.ts` の `extractModel()` / `matchModel()` を渡して段階別モデルを指定する。

```ts
// extract.ts
await generateJson<...>(EXTRACT_SYSTEM, user, PROJECT_ENGINEER_SCHEMA, { model: extractModel(), maxTokens: 4000 });
// match.ts 最終判定 / draft.ts
await generateJson<...>(MATCH_SYSTEM, user, MATCH_SCHEMA, { model: matchModel() });
await generateText(DRAFT_SYSTEM, messages, { model: matchModel() });
```

### 5.3 .env との対応

| .env キー | 既定値 | 使用箇所 |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | 既存機能のグローバル既定（無変更） |
| `ANTHROPIC_MODEL_EXTRACT` | `claude-haiku-4-5` | `extractModel()` → extract |
| `ANTHROPIC_MODEL_MATCH` | `claude-sonnet-5` | `matchModel()` → match最終判定・draft |

抽出精度が不足した場合は `ANTHROPIC_MODEL_EXTRACT` を Sonnet に差し替えるだけで検証できる（要件定義 §7.1）。Gemini プロバイダ利用時（`LLM_PROVIDER=gemini`）は `model` 引数が Gemini モデルIDとして解釈されるため、SESで段階別を使う場合は Anthropic プロバイダを推奨（設計上は両対応、実運用はAnthropic前提）。

---

## 6. Notion DB設計

要件定義 §6.4 のプロパティを確定する。保存は既存 `saveSignal` と**同じ `data_source_id` 方式**（`resolveDataSourceId` → `createPageWithBody`）を用い、`saveProject` / `saveEngineer` / `saveMatch` を同型で `src/database/index.ts` に追加する。プロパティ名は日本語（既存流儀）。

### 6.1 案件DB（`NOTION_PROJECT_DB_ID`）

| プロパティ名（日本語） | Notion型 | 対応フィールド |
|---|---|---|
| 案件名 | title | `title` |
| 必須スキル | multi_select | `requiredSkills` |
| 尚可スキル | multi_select | `preferredSkills` |
| 単金下限 | number | `rateMin`（万円/月） |
| 単金上限 | number | `rateMax`（万円/月） |
| 勤務地 | rich_text | `location` |
| リモート | select（フル/一部/不可/不明） | `remote` |
| 開始時期 | rich_text | `startPeriod` |
| 商流メモ | rich_text | `businessFlow` |
| 営業元会社 | rich_text | `agentCompany` |
| 営業元担当 | rich_text | `agentContact` |
| 営業元メール | rich_text | `agentEmail` |
| 元メールID | rich_text | `sourceMailId` |
| 受信日 | date | `receivedAt` |
| ステータス | select（募集中/終了） | `status` |

### 6.2 要員DB（`NOTION_ENGINEER_DB_ID`）

| プロパティ名（日本語） | Notion型 | 対応フィールド |
|---|---|---|
| 表示名 | title | `displayName`（イニシャル推奨） |
| スキル | multi_select | `skills` |
| 経験年数 | number | `experienceYears` |
| 希望単金 | number | `desiredRate`（万円/月） |
| 居住地 | rich_text | `residence` |
| 最寄り駅 | rich_text | `nearestStation` |
| 稼働開始可能日 | date | `availableFrom`（不明はプロパティ省略） |
| リモート希望 | select | `remoteWish` |
| 営業元 | rich_text | `agentCompany` / `agentContact` / `agentEmail` を結合 |
| 元メールID | rich_text | `sourceMailId` |
| 受信日 | date | `receivedAt` |
| ステータス | select（提案可/決定済） | `status` |

### 6.3 マッチ結果DB（`NOTION_MATCH_DB_ID`）

| プロパティ名（日本語） | Notion型 | 対応フィールド |
|---|---|---|
| マッチ名 | title | `title`（「案件名 × 要員名」） |
| 案件 | relation（案件DB） | `projectId` の notionPageId |
| 要員 | relation（要員DB） | `engineerId` の notionPageId |
| 粗利額 | number | `grossMarginJpy`（円/月） |
| 適合スコア | number（0-100） | `score` |
| 判定根拠 | rich_text | `reason` |
| 案件側下書きURL | rich_text | `draftToProject.url` |
| 要員側下書きURL | rich_text | `draftToEngineer.url` |
| ステータス | select（未確認/紹介済/成約/見送り） | `status` |
| 検出日時 | date | `detectedAt` |

### 6.4 追加する save/fetch 関数（`src/database/index.ts`）

```ts
export async function saveProject(project: Project): Promise<string>;    // → notionPageId
export async function saveEngineer(engineer: Engineer): Promise<string>;
export async function saveMatch(match: MatchResult): Promise<string>;
// 突合対象の読み出し（ステータス=募集中/提案可 のみ。match --match-only で使用）
export async function fetchOpenProjects(limit?: number): Promise<Project[]>;
export async function fetchAvailableEngineers(limit?: number): Promise<Engineer[]>;
```

- DB ID 未設定時は `saveSignal` 同様に `console.warn` して継続（縮退動作）。
- relation プロパティは、案件・要員を先に保存して得た `notionPageId` を `saveMatch` に渡す設計（`store` 段で案件/要員→保存、`notify` 段でマッチ保存の順序）。
- 名寄せ済み・冪等: 決定的ID（`proj_<hash>` 等）で同一メール再処理時の二重登録を避ける（処理済みIDと併用）。

---

## 7. マッチングアルゴリズム設計

### 7.1 一次選抜（LLM不使用・`primarySelect`）

要件定義 §4.3 のルールを純コードで実装する。案件×要員の総当たりに以下のフィルタを順に適用し、通過ペアを `MatchPair` として返す。

**手順（案件ごとに全要員を評価）**

1. **ステータス除外**: 案件 `status==='closed'` / 要員 `status==='assigned'` は対象外（F9）。
2. **粗利条件**: `grossMarginJpy = (project.rateMax − engineer.desiredRate) × 10000`。
   - 双方の単金が既知 かつ `grossMarginJpy ≥ minGrossMarginJpy()` → 通過（`needsReview=false`）。
   - どちらかの単金が `null` → 粗利判定不能。他条件を満たせば `needsReview=true`（「要確認」枠）として別扱いで通過候補に含める。
3. **スキル一致**: `skillMatchRate(project.requiredSkills, engineer.skills) ≥ skillMatchThreshold()`。必須スキルが空の案件は 1.0 とみなす。
4. **勤務地**: `project.remote==='full'` または `isAdjacentOrSame(project.prefecture, engineer.prefecture)` が true。都道府県が両方 null の場合は判定不能→通過させ `needsReview` を立てる。
5. **時期**: `project.startDate` と `engineer.availableFrom` がともに既知なら「稼働可能日 ≤ 開始日+猶予（既定30日）」で整合判定。どちらか不明なら通過（時期は緩めに扱う）。
6. **候補上限**: 案件ごとに、通過ペアを「粗利額 降順 → スキル一致率 降順」でソートし、上位 `maxCandidatesPerItem()`（既定5）件に制限。これで最終判定に回る LLM コール数の上限を保証する。
7. `needsReview=true` の候補は通常候補と分離し、最終判定には回さず（LLM節約）サマリで「要確認」として提示する。

`primarySelect` は純関数（外部依存なし）とし、demo/本番共通で使う。

### 7.2 単金正規化（`pricing.ts`）

すべて **万円/月** の `number` に正規化する。

| 入力表記 | 換算式 | 例 |
|---|---|---|
| 万円/月（`manYenPerMonth`） | そのまま | 「80万」→ 80 |
| 円/時（`yenPerHour`） | `value × hourlyToMonthlyHours() ÷ 10000` | 4,500円/時・160h → 4500×160/10000 = 72 |
| 円/月（`yenPerMonth`） | `value ÷ 10000` | 800,000円/月 → 80 |
| 「スキル見合い」「応相談」等 | `null` | 抽出段で null を返す |

- 換算時間 `hourlyToMonthlyHours()` は `.env`（既定160）で調整可能。
- 抽出（extract）の LLM 出力は「数値 + 単位」で受け、`normalizeRate` で正規化する。範囲（下限・上限）はそれぞれ正規化する。粗利判定は `rateMax`（案件上限）を用いる（要件定義 §4.3）。

### 7.3 スキル正規化辞書（`skillDict.ts`）

- 表記ゆれを正規形に写像する辞書（例: `JAVA`/`java`/`ジャバ` → `Java`、`JS`/`javascript` → `JavaScript`、`GCP`/`Google Cloud` → `GCP`）。
- `normalizeSkill` は「小文字化 → 辞書引き（ヒットすれば正規形）→ ミスなら trim した原表記」の順。
- `skillMatchRate(required, have)` = `|normalize(required) ∩ normalize(have)| / |normalize(required)|`（必須スキル基準の被覆率、0〜1）。
- 辞書は初期は小規模でよく、Phase 1 の実メール検証で拡充する（要件定義のTest段階）。辞書が大きくなり抽出プロンプトが4Kトークンを超えたらプロンプトキャッシュを再検討（要件定義 §7.2-5）。

### 7.4 都道府県隣接判定（`prefecture.ts`）

- `normalizePrefecture(location)`: 住所文字列から47都道府県名を先頭一致・部分一致で抽出（「東京都千代田区」→「東京都」）。抽出不能は `null`。
- 隣接テーブル: 各都道府県に対する陸続き隣接県の静的マップ（例: 東京都 → 神奈川・埼玉・千葉・山梨）。通勤圏の近似として用いる。
- `isAdjacentOrSame(a, b)`: `a===b` または隣接テーブルに含まれれば true。どちらかが null の場合は呼び出し側（§7.1-4）で `needsReview` 扱い。

### 7.5 最終判定（本番=Sonnet / demo=テンプレート）

- 一次選抜通過（`needsReview=false`）の `MatchPair` のみを Sonnet 5 に渡し、構造化出力で `score`（0〜100）と `reason`（根拠文）を得る。
- 入力は案件・要員の要約（スキル・単金・勤務地・時期）+ 粗利額。1ペア1コール。
- demo は LLM を使わず、`score = round(skillMatchRate×70 + (locationOk?20:0) + (timingOk?10:0))` 等の**決定的ヒューリスティック**でスコアと定型根拠文を生成する（§8）。

---

## 8. demoモード設計（最重要）

### 8.1 目的と完走条件

`npm run ses:demo`（= `DEMO_MODE=true` で `src/ses/index.ts` を起動）が、**`ANTHROPIC_API_KEY` も Gmail/Notion/Sheets の認証も無い環境で、一切の外部呼び出しなしにパイプライン①〜⑦を完走**する。成果物は `data/ses-demo/` 配下のローカルJSON + コンソール出力。

### 8.2 判定フラグ（本番/demo の唯一の分岐点）

`src/ses/config.ts` の `isDemo()` を**単一の分岐点**とする:

```ts
export function isDemo(): boolean {
  return process.env.DEMO_MODE === 'true' || !process.env.ANTHROPIC_API_KEY;
}
```

- `DEMO_MODE=true` 明示、または `ANTHROPIC_API_KEY` 未設定なら demo。既存 `src/clone/engine.ts` の `DEMO_MODE` 流儀に、キー未設定でも自動 demo になるガードを足したもの（本タスク要件「キー未設定でもLLM/外部API無しで完走」を保証）。
- 各段モジュールは冒頭で `if (isDemo()) return demoImpl(...)` の形で分岐し、demo 経路では外部SDK（Anthropic/googleapis/Notion）を**呼ばない**。

### 8.3 段ごとの demo 実装

| 段 | 本番経路 | demo経路（外部呼び出しゼロ） |
|---|---|---|
| ① collect | Gmail API で SESクエリ取得 + 添付DL | `src/ses/fixtures/mails.ts` の固定 `SesRawMail[]` を返す（案件メール・要員メール・添付付き・スプシリンク付きを網羅） |
| ② parse | xlsx→テキスト / Sheets API / PDF温存 | fixture に予め添付テキスト（`attachments[].text`）を埋めておき、そのまま返す（xlsx/Sheets 展開をスキップ） |
| ③ extract | Haiku 4.5 + 構造化出力（PDFはdocumentブロック） | **決定的スタブ**: fixtureメールIDごとに、期待抽出結果 `ExtractedItem[]` を返す固定マッピング（`fixtures/expectedExtractions.ts`）。LLM不使用 |
| ④ store | Notion `saveProject`/`saveEngineer` + 名寄せ | `writeDemoArtifact('projects', ...)` / `('engineers', ...)` でローカルJSON。名寄せ（`src/dedup` 相当のロジック）はコードなので実行してよい |
| ⑤ match | `primarySelect`（純コード）→ Sonnet最終判定 | `primarySelect` は**そのまま実行**（純コード）。最終判定は §7.5 のヒューリスティックでスコア生成（LLM不使用） |
| ⑥ draft | Sonnet生成 → Gmail下書き作成 | テンプレート文面（案件側/要員側の定型メール）を組み立て、`writeDemoArtifact('drafts', ...)` に保存。`DraftRef.url` はローカルファイルパス、`draftId` は `demo_draft_<n>` |
| ⑦ notify | Notion マッチDB保存 + Gmail サマリ送信 | `writeDemoArtifact('matches', ...)` + サマリを**コンソール出力**（日本語）。0件でも結果を出す |

### 8.4 本番経路とのガード方法

- **クライアント遅延生成の活用**: 既存 `anthropic.ts` の遅延生成（`_client ??= new Anthropic()`）・`database/index.ts` の Notion クライアント・`googleAuth.ts` の null 返しにより、demo 経路がこれらを呼ばない限り**import しても落ちない**。demo 経路では `if (isDemo()) return demoImpl()` を各段の**最初**に置き、本番SDK呼び出しに到達させない。
- **設定未設定でも安全**: `config.ts` は全設定を `?? default` で読むため、`.env` が空でも例外を投げない。
- **成果物の隔離**: demo の書き込みは `data/ses-demo/` に限定（本番 `data/` の生ログや processed-ids とはディレクトリを分ける）。
- **fixtureの網羅性**: fixtureメールは「粗利成立ペア」「粗利不足で落ちるペア」「単金不明で要確認になるペア」「案件でも要員でもない“その他”メール」を各1件以上含め、①〜⑦の全分岐（成立・除外・要確認・破棄）がdemoで通ることを保証する。
- **ビルド安全性**: demo/本番いずれの経路でも strict TS（`noUnusedLocals`/`noUnusedParameters`）を満たす。未使用にならないよう、本番専用 import は使用箇所と同じモジュール内に閉じる。

### 8.5 demo の検証観点（実装完了条件）

`npm install && npm run build`（tsc通過）後、`npm run ses:demo` が: (a) 例外なく完走、(b) `data/ses-demo/{projects,engineers,matches,drafts,summary}.json` を生成、(c) コンソールに成立マッチ件数・要確認件数・0件時メッセージを日本語表示、(d) ネットワーク発信ゼロ（Anthropic/Gmail/Notion/Sheets を一度も呼ばない）。

---

## 9. 設定（.env）一覧

`src/ses/config.ts` で一元読み出しする。すべて `Number(process.env.X ?? default)` / `process.env.X ?? default` 形式（既存インライン env 流儀）。

```bash
# ===== SESマッチング設定 =====
MIN_GROSS_MARGIN_JPY=100000            # 粗利下限（円/月）。初期値10万円・変更可
SES_TARGET_GMAIL=ses@example.com       # 収集対象（Xserverからの転送先）Gmailアドレス
SES_NOTIFY_TO=you@example.com          # サマリ通知の宛先
MAX_CANDIDATES_PER_ITEM=5              # 1アイテムあたりLLM最終判定に回す候補上限
SKILL_MATCH_THRESHOLD=0.6              # 必須スキル一致率の下限（0〜1）
HOURLY_TO_MONTHLY_HOURS=160           # 時給→月額換算の稼働時間
MATCH_TIMING_GRACE_DAYS=30            # 時期整合の猶予日数（§7.1-5）
NOTION_PROJECT_DB_ID=                  # 案件DB
NOTION_ENGINEER_DB_ID=                 # 要員DB
NOTION_MATCH_DB_ID=                    # マッチ結果DB
ANTHROPIC_MODEL_EXTRACT=claude-haiku-4-5   # 抽出用（切替可）
ANTHROPIC_MODEL_MATCH=claude-sonnet-5      # 最終判定・メール生成用
USE_BATCH_API=false                    # trueでBatch API（50%割引・Phase3）
DEMO_MODE=false                        # trueで強制demo（キー有無に関わらず）
```

既存の共有設定（`ANTHROPIC_API_KEY`・`ANTHROPIC_MODEL`・`LLM_PROVIDER`・`GOOGLE_SA_*`・`GOOGLE_TARGET_EMAIL`・`NOTION_TOKEN`）はそのまま流用する。`scripts/setup.mjs`（`npm run setup`）が生成する `.env.local` テンプレートにも上記キーを追記する。

---

## 10. npm scripts / バッチ運用

`package.json` に追加する（既存 scripts は無変更）。

```jsonc
{
  "scripts": {
    "ses": "tsx src/ses/index.ts",                        // 本番: ①〜⑦一括（1日2回）
    "ses:demo": "DEMO_MODE=true tsx src/ses/index.ts",    // demo: 外部呼び出しゼロで完走
    "ses:collect": "tsx src/ses/index.ts --collect-only", // ①〜④のみ（収集〜保存）
    "ses:match": "tsx src/ses/index.ts --match-only"       // ⑤〜⑦のみ（既存DBから突合）
  }
}
```

- **スケジューリング**: 既存の cron/systemd timer 流儀（`deploy/systemd/`）に相乗りし、`npm run ses` を1日2回（例 8:00 / 17:00）実行。`--collect-only` と `--match-only` を別時刻に分ける運用も可能。
- **冪等性**: 処理済みメールIDと決定的IDにより、同一バッチを再実行しても二重登録・二重下書きが起きない（要件 非機能「再実行安全性」）。
- **受信0件監視**: collect が連続で0件なら notify のサマリで警告（要件定義 §10-5 転送設定の監視）。

---

## 11. 段階的導入（Phase 1〜3）と完了条件

要件定義 §9 のロードマップを、本設計のモジュール単位で完了条件化する。

| Phase | 実装スコープ（本設計のモジュール） | 完了条件 |
|---|---|---|
| **Phase 1**<br>収集・抽出・保存 | `config.ts` / `collect.ts` / `parse.ts` / `extract.ts` / `store.ts` / `skillDict.ts` / `pricing.ts` / `fixtures/` / 型追加 / `email.ts`拡張 / `saveProject`・`saveEngineer` / llm層 `model?` 拡張 | (1) `npm run build` 通過、(2) `npm run ses:demo` が collect→store まで完走し `data/ses-demo/{projects,engineers}.json` を生成、(3) 本番経路で実メール数日分の抽出精度を検証しスキーマ/辞書をチューニング（デザイン思考のTest段階） |
| **Phase 2**<br>マッチング・通知・名寄せ | `match.ts`（`primarySelect` + 最終判定）/ `prefecture.ts` / `notify.ts` / `saveMatch` / 名寄せ（`src/dedup`再利用） | (1) `npm run ses:demo` が①〜⑤+⑦（draftを除く）まで完走し `matches.json` とサマリを出力、(2) 本番で1日2回、粗利条件を満たすペアがサマリメール+Notionに届く、(3) 要確認枠・0件通知が機能する |
| **Phase 3**<br>下書き・ステータス・Batch API | `draft.ts` / `googleAuth.ts`スコープ追加（`gmail.compose`）/ ステータス管理（F9）/ 任意で `USE_BATCH_API` 経路 | (1) `npm run ses:demo` が①〜⑦フル完走し `drafts.json` を生成、(2) 本番で成立マッチごとにGmail下書き2通が保存される（自動送信しない）、(3) Notion上でステータス手動更新でき終了分が突合対象から除外される |

各 Phase は単体で価値が出る構成（Phase1=構造化DB、Phase2=マッチ通知、Phase3=下書きまで自動化）。全 Phase を通じて demo 経路を常に完走可能に保つ（回帰防止）。

---

## 付録A: 既存資産の拡張と後方互換性の担保

| 既存ファイル | 変更種別 | 後方互換の担保 |
|---|---|---|
| `src/types/index.ts` | 型の**追加のみ** | 既存 `RawLog`/`Signal`/`Story` は無変更 |
| `src/llm/index.ts` / `anthropic.ts` / `gemini.ts` | 引数 `model?` の**末尾追加** | 未指定時は従来のグローバル `MODEL`。既存呼び出しは無変更で動作 |
| `src/database/index.ts` | 関数の**追加のみ** | 既存 `saveSignal`/`saveStory`/`fetch*` は無変更。共通ヘルパー（`throttle`/`resolveDataSourceId`/`createPageWithBody`/`toRichText`）を再利用 |
| `src/collectors/email.ts` | 添付対応・クエリ引数の追加 | 既存 `collectFromEmail()`（引数なし）は従来動作を維持。SES用は別関数/オーバーロードで提供 |
| `src/collectors/googleAuth.ts` | `SCOPES` に2スコープ追加 | 既存の readonly 収集に影響なし（追加は権限拡張のみ。DWD側のスコープ登録が別途必要な旨を運用ドキュメントに明記） |
| `package.json` | scripts 追加 | 既存 scripts 無変更 |

## 付録B: パイプラインとデータ型の対応

```
collectSesMail()      : () → SesRawMail[]
parseAttachments()    : SesRawMail[] → SesRawMail[]（attachments[].text 充填）
extractItems()        : SesRawMail[] → ExtractedItem[]
store（saveProject/saveEngineer + 名寄せ）: ExtractedItem[] → Project[] / Engineer[]（notionPageId付与）
primarySelect()       : (Project[], Engineer[]) → MatchPair[]（LLM不使用・上限制御）
matchAll()            : (Project[], Engineer[]) → MatchResult[]（最終判定でscore/reason付与）
createDrafts()        : MatchResult[] → MatchResult[]（draftRef付与）
persistAndNotify()    : MatchResult[] → void（保存+通知）
```
