import { Client } from '@notionhq/client';
import { normalizePrefecture } from '../ses/prefecture.js';
import { normalizeSkills } from '../ses/skillDict.js';
import {
  dbProvider,
  notionProjectDbId,
  notionEngineerDbId,
  notionMatchDbId,
  notionOwnEngineerDbId,
  notionFeedbackDbId,
  notionSkillEquivDbId,
} from '../ses/config.js';
import { safeErr } from '../ses/redact.js';
import * as sheetsDb from './sheets.js';
import {
  remoteLabel,
  labelToRemote,
  matchStatusLabel,
  FB_VERDICT_LABEL,
  combineAgentInfo,
  parseAgentInfo,
  replyMetaJson,
  parseReplyMeta,
  sanitizeListItem,
} from './mapping.js';
import type {
  Signal,
  Story,
  Project,
  Engineer,
  MatchResult,
  MatchStatus,
  OwnEngineer,
  MatchFeedback,
  SkillEquivalence,
} from '../types/index.js';

// Notion API バージョン 2025-09-03 以降、database ID と data source ID は別物になった。
// ページ作成・クエリは data_source_id ベースで行う（database_id は不可）。
// @notionhq/client v5 は既定で 2025-09-03 を使う。
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const SIGNAL_DB_ID = process.env.NOTION_SIGNAL_DB_ID ?? '';
const STORY_DB_ID = process.env.NOTION_STORY_DB_ID ?? '';
// SESマッチング機能で追加（設定の単一の真実の源である ses/config.ts のゲッターを経由する）
const PROJECT_DB_ID = notionProjectDbId();
const ENGINEER_DB_ID = notionEngineerDbId();
const MATCH_DB_ID = notionMatchDbId();
const OWN_ENGINEER_DB_ID = notionOwnEngineerDbId();
const FEEDBACK_DB_ID = notionFeedbackDbId();
const SKILL_EQUIV_DB_ID = notionSkillEquivDbId();

// --- レート制限（平均 3 req/s）+ 429/529 リトライ ---
// 全 Notion 呼び出しをこのラッパー経由にして最小間隔を空ける。
const MIN_INTERVAL_MS = 350;
let lastCall = Promise.resolve(0);

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  // 直列化して最小間隔を保証する（Date.now は使えないため performance.now を利用）
  const prev = lastCall;
  let release: (t: number) => void = () => {};
  lastCall = new Promise<number>((res) => (release = res));

  await prev;
  return runWithRetry(fn).finally(() => release(0));
}

async function runWithRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    const result = await fn();
    await sleep(MIN_INTERVAL_MS);
    return result;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if ((status === 429 || status === 529) && attempt < 5) {
      const retryAfter = Number((err as { headers?: Record<string, string> }).headers?.['retry-after'] ?? 1);
      await sleep(retryAfter * 1000);
      return runWithRetry(fn, attempt + 1);
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// --- data source ID 解決（起動時に一度だけ、キャッシュする）---
const dataSourceCache = new Map<string, string>();

async function resolveDataSourceId(databaseId: string): Promise<string> {
  const cached = dataSourceCache.get(databaseId);
  if (cached) return cached;

  try {
    const db = await throttle(() => notion.databases.retrieve({ database_id: databaseId }));
    // v5 のレスポンスは data_sources[] を持つ
    const sources = (db as { data_sources?: Array<{ id: string }> }).data_sources;
    const id = sources?.[0]?.id ?? databaseId;
    dataSourceCache.set(databaseId, id); // 成功時のみキャッシュ
    return id;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      // 恒久的に「見つからない」= 与えられた ID が既に data_source_id とみなしてキャッシュ
      dataSourceCache.set(databaseId, databaseId);
      return databaseId;
    }
    // 一過性エラー（429/5xx/ネットワーク）はキャッシュ汚染を避け、今回のみフォールバック
    console.warn(`Notion: data_source_id 解決に失敗（今回のみフォールバック）: ${safeErr(err)}`);
    return databaseId;
  }
}

// --- rich_text ヘルパー（1オブジェクト最大2000文字）---
function toRichText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push(text.slice(i, i + 2000));
  }
  return (chunks.length ? chunks : ['']).map((content) => ({ type: 'text' as const, text: { content } }));
}

// 長文を段落ブロックの配列に変換する（1ブロックあたり rich_text ≤2000文字）
function toParagraphBlocks(text: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < text.length; i += 2000) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(i, i + 2000) } }] },
    });
  }
  return blocks;
}

// children は1リクエスト最大100件。超過分は append で追記する。
async function createPageWithBody(
  args: Parameters<typeof notion.pages.create>[0],
  bodyBlocks: Array<Record<string, unknown>>,
): Promise<string> {
  const first = bodyBlocks.slice(0, 100);
  const rest = bodyBlocks.slice(100);

  const page = await throttle(() =>
    notion.pages.create({ ...args, children: first as never }),
  );
  const pageId = page.id;

  for (let i = 0; i < rest.length; i += 100) {
    const batch = rest.slice(i, i + 100);
    await throttle(() =>
      notion.blocks.children.append({ block_id: pageId, children: batch as never }),
    );
  }
  return pageId;
}

// シグナルをNotionシグナルDBに保存する
export async function saveSignal(signal: Signal): Promise<string> {
  const dataSourceId = await resolveDataSourceId(SIGNAL_DB_ID);
  return createPageWithBody(
    {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        概要: { title: toRichText(signal.summary) },
        カテゴリ: { select: { name: signal.category } },
        重要度: { number: signal.importance },
        日時: { date: { start: signal.timestamp.toISOString() } },
        タグ: { multi_select: signal.tags.map((t) => ({ name: t })) },
        関係者: { multi_select: signal.relatedPeople.map((p) => ({ name: p })) },
      },
    } as never,
    toParagraphBlocks(signal.detail),
  );
}

// ストーリーをNotionストーリーDBに保存する
export async function saveStory(story: Story): Promise<string> {
  const dataSourceId = await resolveDataSourceId(STORY_DB_ID);
  return createPageWithBody(
    {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        タイトル: { title: toRichText(story.title) },
        '期間（開始）': { date: { start: story.period.start.toISOString() } },
        洞察: { rich_text: toRichText(story.insight) },
      },
    } as never,
    [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: 'ナラティブ' } }] },
      },
      ...toParagraphBlocks(story.narrative),
    ],
  );
}

// ===== SESマッチング機能向けの拡張 =====
// saveSignal/saveStory と同型（data_source_id 方式・共通ヘルパー再利用）。既存関数は無変更。
// プロパティ名は docs/ses-matching-basic-design.md §6 のNotion DB設計に一致させる。

// ラベル変換・返信メタ・営業元の結合/分解は DBプロバイダ共通のため ./mapping.ts に集約
// （Sheets版バックエンド ./sheets.ts と同じ表記で保存・復元するための単一の変換層）

// Notion APIの1ページあたりの取得上限
const NOTION_PAGE_SIZE = 100;

type QueryArgs = Omit<Parameters<typeof notion.dataSources.query>[0], 'data_source_id' | 'start_cursor' | 'page_size'>;

// has_more/next_cursor を辿って最大 limit 件まで取得する（page_size は常に100以下）
async function queryAll(dataSourceId: string, args: QueryArgs, limit: number): Promise<unknown[]> {
  const results: unknown[] = [];
  let cursor: string | undefined;
  do {
    const res = await throttle(() =>
      notion.dataSources.query({
        ...args,
        data_source_id: dataSourceId,
        page_size: Math.min(NOTION_PAGE_SIZE, Math.max(1, limit - results.length)),
        ...(cursor ? { start_cursor: cursor } : {}),
      } as never),
    );
    const page = res as { results: unknown[]; has_more: boolean; next_cursor: string | null };
    results.push(...page.results);
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && results.length < limit);
  return results.slice(0, limit);
}

// SESで後から追加したテキスト列（安定ID）を、既存のDBにも自動で追加する（プロセス内で1回。
// 既存の列は型を変えない。権限不足等で追加できなければ警告のみ — 保存時に失敗し、元メールは次回再処理される）
const ensuredProps = new Map<string, Promise<void>>();

function ensureTextProperties(dataSourceId: string, names: string[]): Promise<void> {
  const key = `${dataSourceId}:${names.join(',')}`;
  let pending = ensuredProps.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const ds = (await throttle(() => notion.dataSources.retrieve({ data_source_id: dataSourceId }))) as {
          properties?: Record<string, unknown>;
        };
        const missing = names.filter((n) => !(n in (ds.properties ?? {})));
        if (missing.length === 0) return;
        await throttle(() =>
          notion.dataSources.update({
            data_source_id: dataSourceId,
            properties: Object.fromEntries(missing.map((n) => [n, { rich_text: {} }])),
          } as never),
        );
        console.log(`Notion: SES用のテキスト列を追加しました（${missing.join(', ')}）`);
      } catch (err) {
        ensuredProps.delete(key); // 次回呼び出しで再試行
        console.warn(`Notion: SES用の列（${names.join(', ')}）の確認・追加に失敗: ${safeErr(err)}`);
      }
    })();
    ensuredProps.set(key, pending);
  }
  return pending;
}

// 安定IDの列で既存ページを探す（見つからなければ null）
async function findPageIdByText(dataSourceId: string, property: string, value: string): Promise<string | null> {
  if (!value) return null;
  const res = await throttle(() =>
    notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property, rich_text: { equals: value } },
      page_size: 1,
    } as never),
  );
  const first = (res as { results: Array<{ id?: string }> }).results[0];
  return first?.id ?? null;
}

// multi_select の選択肢名はカンマを含められず100文字まで（LLMの抽出値でページ作成全体が失敗しないように整える）
function multiSelect(values: string[]): { multi_select: Array<{ name: string }> } {
  const names = [...new Set(values.map((v) => sanitizeListItem(v).slice(0, 100)).filter(Boolean))];
  return { multi_select: names.map((name) => ({ name })) };
}

// 実在する YYYY-MM-DD だけを日付型に入れる（それ以外はプロパティ自体を省く）
function dateOnly(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

// 安定IDで upsert する。人が進めたステータスは再保存で巻き戻さない（更新時はステータスを送らない）
async function upsertByStableId(
  dataSourceId: string,
  idProperty: string,
  id: string,
  properties: Record<string, unknown>,
  bodyBlocks: Array<Record<string, unknown>>,
): Promise<string> {
  await ensureTextProperties(dataSourceId, [idProperty]);
  const existingId = await findPageIdByText(dataSourceId, idProperty, id);
  if (existingId) {
    const { ステータス: _status, ...rest } = properties;
    await throttle(() => notion.pages.update({ page_id: existingId, properties: rest } as never));
    return existingId;
  }
  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    bodyBlocks,
  );
}

// SES案件をNotion案件DBに保存する（案件ID=抽出時の決定的IDで upsert。再実行で重複ページを作らない）
export async function saveProject(project: Project): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveProjectSheets(project);
  if (!PROJECT_DB_ID) {
    console.warn('NOTION_PROJECT_DB_ID が未設定 — 案件の保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(PROJECT_DB_ID);
  const properties: Record<string, unknown> = {
    案件名: { title: toRichText(project.title) },
    案件ID: { rich_text: toRichText(project.id) },
    必須スキル: multiSelect(project.requiredSkills),
    尚可スキル: multiSelect(project.preferredSkills),
    単金下限: { number: project.rateMin },
    単金上限: { number: project.rateMax },
    勤務地: { rich_text: toRichText(project.location) },
    リモート: { select: { name: remoteLabel(project.remote) } },
    開始時期: { rich_text: toRichText(project.startPeriod) },
    商流メモ: { rich_text: toRichText(project.businessFlow) },
    営業元会社: { rich_text: toRichText(project.agentCompany) },
    営業元担当: { rich_text: toRichText(project.agentContact) },
    営業元メール: { rich_text: toRichText(project.agentEmail) },
    元メールID: { rich_text: toRichText(project.sourceMailId) },
    // 全員に返信の再現用（--match-only 経路のため。DBにプロパティが必要 → 導入マニュアル4-1参照）
    返信メタ: { rich_text: toRichText(replyMetaJson(project.replyTarget)) },
    受信日: { date: { start: project.receivedAt.toISOString() } },
    ステータス: { select: { name: project.status === 'closed' ? '終了' : '募集中' } },
  };
  const startDate = dateOnly(project.startDate);
  if (startDate) properties['開始日'] = { date: { start: startDate } };
  return upsertByStableId(
    dataSourceId,
    '案件ID',
    project.id,
    properties,
    toParagraphBlocks(`期間: ${project.duration}\n開始日(正規化): ${startDate ?? '不明'}`),
  );
}

// SES要員をNotion要員DBに保存する（要員ID=抽出時の決定的IDで upsert）
export async function saveEngineer(engineer: Engineer): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveEngineerSheets(engineer);
  if (!ENGINEER_DB_ID) {
    console.warn('NOTION_ENGINEER_DB_ID が未設定 — 要員の保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(ENGINEER_DB_ID);
  const properties: Record<string, unknown> = {
    表示名: { title: toRichText(engineer.displayName) },
    要員ID: { rich_text: toRichText(engineer.id) },
    スキル: multiSelect(engineer.skills),
    経験年数: { number: engineer.experienceYears },
    希望単金: { number: engineer.desiredRate },
    居住地: { rich_text: toRichText(engineer.residence) },
    リモート希望: { select: { name: remoteLabel(engineer.remoteWish) } },
    営業元: { rich_text: toRichText(combineAgentInfo(engineer.agentCompany, engineer.agentContact, engineer.agentEmail)) },
    元メールID: { rich_text: toRichText(engineer.sourceMailId) },
    // 全員に返信の再現用（--match-only 経路のため。DBにプロパティが必要 → 導入マニュアル4-2参照）
    返信メタ: { rich_text: toRichText(replyMetaJson(engineer.replyTarget)) },
    受信日: { date: { start: engineer.receivedAt.toISOString() } },
    ステータス: { select: { name: engineer.status === 'assigned' ? '決定済' : '提案可' } },
  };
  const availableFrom = dateOnly(engineer.availableFrom);
  if (availableFrom) properties['稼働開始可能日'] = { date: { start: availableFrom } };
  return upsertByStableId(
    dataSourceId,
    '要員ID',
    engineer.id,
    properties,
    toParagraphBlocks(
      `最寄り駅: ${engineer.nearestStation}\n稼働開始可能日(原文): ${engineer.availableDate}\n稼働率: ${engineer.utilization}`,
    ),
  );
}

// マッチ結果をNotionマッチDBに保存する。案件・要員のNotionページIDが分かればrelationも張る。
// マッチID（案件ID×要員IDから作る安定ID）で upsert する（タイトルは表示用で、別ペアと重なり得るため鍵にしない）
export async function saveMatch(
  match: MatchResult,
  refs?: { projectNotionPageId?: string; engineerNotionPageId?: string },
): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveMatchSheets(match);
  if (!MATCH_DB_ID) {
    console.warn('NOTION_MATCH_DB_ID が未設定 — マッチ結果の保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(MATCH_DB_ID);
  const properties: Record<string, unknown> = {
    マッチ名: { title: toRichText(match.title) },
    マッチID: { rich_text: toRichText(match.id) },
    粗利額: { number: match.grossMarginJpy },
    適合スコア: { number: match.score },
    判定根拠: { rich_text: toRichText(match.reason) },
    案件側下書きURL: { rich_text: toRichText(match.draftToProject?.url ?? '') },
    要員側下書きURL: { rich_text: toRichText(match.draftToEngineer?.url ?? '') },
    ステータス: { select: { name: matchStatusLabel(match.status) } },
    検出日時: { date: { start: match.detectedAt.toISOString() } },
  };
  if (refs?.projectNotionPageId) properties['案件'] = { relation: [{ id: refs.projectNotionPageId }] };
  if (refs?.engineerNotionPageId) properties['要員'] = { relation: [{ id: refs.engineerNotionPageId }] };
  return upsertByStableId(dataSourceId, 'マッチID', match.id, properties, toParagraphBlocks(match.reason));
}

// ===== まとめ保存（Sheetsは新しい行をまとめて追記。Notionは1件ずつ） =====

export interface BatchSaveResult {
  failed: Map<string, unknown>; // 保存できなかった ID → エラー
  pageIds: Map<string, string>; // 保存できた ID → 参照ID（NotionのページID。Sheetsは自ID）
}

async function saveEach<T extends { id: string }>(items: T[], save: (item: T) => Promise<string>): Promise<BatchSaveResult> {
  const result: BatchSaveResult = { failed: new Map(), pageIds: new Map() };
  for (const item of items) {
    try {
      result.pageIds.set(item.id, await save(item));
    } catch (err) {
      result.failed.set(item.id, err);
    }
  }
  return result;
}

function sheetsResult<T extends { id: string }>(items: T[], failed: Map<string, unknown>): BatchSaveResult {
  return { failed, pageIds: new Map(items.filter((i) => !failed.has(i.id)).map((i) => [i.id, i.id])) };
}

export async function saveProjects(projects: Project[]): Promise<BatchSaveResult> {
  if (dbProvider() === 'sheets') return sheetsResult(projects, await sheetsDb.saveProjectsSheets(projects));
  return saveEach(projects, saveProject);
}

export async function saveEngineers(engineers: Engineer[]): Promise<BatchSaveResult> {
  if (dbProvider() === 'sheets') return sheetsResult(engineers, await sheetsDb.saveEngineersSheets(engineers));
  return saveEach(engineers, saveEngineer);
}

export async function saveMatches(
  matches: MatchResult[],
  refsOf: (match: MatchResult) => { projectNotionPageId?: string; engineerNotionPageId?: string },
): Promise<BatchSaveResult> {
  if (dbProvider() === 'sheets') return sheetsResult(matches, await sheetsDb.saveMatchesSheets(matches));
  return saveEach(matches, (m) => saveMatch(m, refsOf(m)));
}

// 候補ペアの判定・保存まで済んだ案件・要員に印を付ける（Sheets運用のみ。Notionは印を持たず、その回の新着だけを突合する）
export async function markItemsMatched(kind: 'project' | 'engineer', ids: string[]): Promise<number> {
  if (dbProvider() === 'sheets') return sheetsDb.markItemsMatchedSheets(kind, ids);
  return 0;
}

// 判定済みのマッチID（通常バッチで同じペアをLLMで判定し直さないため）。since 以降に検出したものに絞る
export async function fetchJudgedMatchIds(since?: Date): Promise<Set<string>> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchJudgedMatchIdsSheets();
  if (!MATCH_DB_ID) return new Set();
  const dataSourceId = await resolveDataSourceId(MATCH_DB_ID);
  await ensureTextProperties(dataSourceId, ['マッチID']);
  const pages = await queryAll(
    dataSourceId,
    since ? { filter: { property: '検出日時', date: { on_or_after: since.toISOString() } } } : {},
    10_000,
  );
  const ids = pages
    .map((page) => readRichText(((page as { properties?: Record<string, unknown> }).properties ?? {})['マッチID']))
    .filter(Boolean);
  return new Set(ids);
}

// 突合対象の案件（募集中のみ）を新しい順に取得する（通常バッチの突合プール・--match-only・プロパー候補探しで使用）。
// receivedSince 指定時はその日時以降に受信した案件に絞る
export async function fetchOpenProjects(limit = 100, opts: { receivedSince?: Date } = {}): Promise<Project[]> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchOpenProjectsSheets(limit, opts.receivedSince);
  if (!PROJECT_DB_ID) {
    console.warn('NOTION_PROJECT_DB_ID が未設定 — 案件なしで継続します');
    return [];
  }
  const dataSourceId = await resolveDataSourceId(PROJECT_DB_ID);
  const open = { property: 'ステータス', select: { equals: '募集中' } };
  const since = opts.receivedSince;
  const pages = await queryAll(
    dataSourceId,
    {
      filter: since ? { and: [open, { property: '受信日', date: { on_or_after: since.toISOString() } }] } : open,
      sorts: [{ property: '受信日', direction: 'descending' }],
    } as QueryArgs,
    limit,
  );
  return pages.map((page) => projectFromPage(page));
}

// 突合対象の要員（提案可のみ）を新しい順に取得する。receivedSince 指定時はその日時以降に受信した要員に絞る
export async function fetchAvailableEngineers(limit = 100, opts: { receivedSince?: Date } = {}): Promise<Engineer[]> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchAvailableEngineersSheets(limit, opts.receivedSince);
  if (!ENGINEER_DB_ID) {
    console.warn('NOTION_ENGINEER_DB_ID が未設定 — 要員なしで継続します');
    return [];
  }
  const dataSourceId = await resolveDataSourceId(ENGINEER_DB_ID);
  const available = { property: 'ステータス', select: { equals: '提案可' } };
  const since = opts.receivedSince;
  const pages = await queryAll(
    dataSourceId,
    {
      filter: since
        ? { and: [available, { property: '受信日', date: { on_or_after: since.toISOString() } }] }
        : available,
      sorts: [{ property: '受信日', direction: 'descending' }],
    } as QueryArgs,
    limit,
  );
  return pages.map((page) => engineerFromPage(page));
}

function projectFromPage(page: unknown): Project {
  const p = page as { id: string; properties?: Record<string, unknown> };
  const props = p.properties ?? {};
  const location = readRichText(props['勤務地']);
  return {
    // 収集経路と同じ決定的ID（マッチIDの一致に必要）。列が無い古いページだけページIDで代用する
    id: readRichText(props['案件ID']) || p.id,
    title: readTitle(props['案件名']),
    // 人がNotion上で直接編集したスキル（'JS'/'k8s' 等の表記ゆれ）もマッチングに乗るよう読出時に正規化する
    requiredSkills: normalizeSkills(readMultiSelect(props['必須スキル'])),
    preferredSkills: normalizeSkills(readMultiSelect(props['尚可スキル'])),
    rateMin: readNumber(props['単金下限']) ?? null,
    rateMax: readNumber(props['単金上限']) ?? null,
    location,
    prefecture: normalizePrefecture(location),
    remote: labelToRemote(readSelect(props['リモート'])),
    startPeriod: readRichText(props['開始時期']),
    startDate: readDate(props['開始日']) ?? null,
    duration: '',
    businessFlow: readRichText(props['商流メモ']),
    agentCompany: readRichText(props['営業元会社']),
    agentContact: readRichText(props['営業元担当']),
    agentEmail: readRichText(props['営業元メール']),
    sourceMailId: readRichText(props['元メールID']),
    replyTarget: parseReplyMeta(readRichText(props['返信メタ'])),
    receivedAt: new Date(readDate(props['受信日']) ?? nowIso()),
    status: readSelect(props['ステータス']) === '終了' ? 'closed' : 'open',
    notionPageId: p.id,
  };
}

function engineerFromPage(page: unknown): Engineer {
  const p = page as { id: string; properties?: Record<string, unknown> };
  const props = p.properties ?? {};
  const residence = readRichText(props['居住地']);
  const agentInfo = parseAgentInfo(readRichText(props['営業元']));
  return {
    id: readRichText(props['要員ID']) || p.id,
    displayName: readTitle(props['表示名']),
    age: null,
    skills: normalizeSkills(readMultiSelect(props['スキル'])),
    experienceYears: readNumber(props['経験年数']) ?? null,
    desiredRate: readNumber(props['希望単金']) ?? null,
    residence,
    prefecture: normalizePrefecture(residence),
    nearestStation: '',
    availableDate: '',
    availableFrom: readDate(props['稼働開始可能日']) ?? null,
    utilization: '',
    remoteWish: labelToRemote(readSelect(props['リモート希望'])),
    agentCompany: agentInfo.company,
    agentContact: agentInfo.contact,
    agentEmail: agentInfo.email,
    sourceMailId: readRichText(props['元メールID']),
    replyTarget: parseReplyMeta(readRichText(props['返信メタ'])),
    receivedAt: new Date(readDate(props['受信日']) ?? nowIso()),
    status: readSelect(props['ステータス']) === '決定済' ? 'assigned' : 'available',
    notionPageId: p.id,
  };
}

// 自社社員をNotion自社社員DBに保存する（候補要員→案件探し機能）
export async function saveOwnEngineer(own: OwnEngineer): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveOwnEngineerSheets(own);
  if (!OWN_ENGINEER_DB_ID) {
    console.warn('NOTION_OWN_ENGINEER_DB_ID が未設定 — 自社社員の保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(OWN_ENGINEER_DB_ID);
  const properties: Record<string, unknown> = {
    表示名: { title: toRichText(own.displayName) },
    スキル: multiSelect(own.skills),
    経験年数: { number: own.experienceYears },
    必要案件単価: { number: own.requiredProjectRate },
    居住地: { rich_text: toRichText(own.residence) },
    リモート希望: { select: { name: remoteLabel(own.remoteWish) } },
    ステータス: { select: { name: own.status === 'assigned' ? 'アサイン済' : '稼働可' } },
  };
  const availableFrom = dateOnly(own.availableFrom);
  if (availableFrom) properties['稼働可能日'] = { date: { start: availableFrom } };
  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    toParagraphBlocks(`稼働可能時期(原文): ${own.availableDate}`),
  );
}

// 突合対象の自社社員（稼働可のみ）を取得する
export async function fetchOwnEngineers(limit = 100): Promise<OwnEngineer[]> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchOwnEngineersSheets(limit);
  if (!OWN_ENGINEER_DB_ID) {
    console.warn('NOTION_OWN_ENGINEER_DB_ID が未設定 — 自社社員なしで継続します');
    return [];
  }
  const dataSourceId = await resolveDataSourceId(OWN_ENGINEER_DB_ID);
  const pages = await queryAll(dataSourceId, { filter: { property: 'ステータス', select: { equals: '稼働可' } } } as QueryArgs, limit);
  return pages.map((page) => ownEngineerFromPage(page));
}

function ownEngineerFromPage(page: unknown): OwnEngineer {
  const p = page as { id: string; properties?: Record<string, unknown> };
  const props = p.properties ?? {};
  const residence = readRichText(props['居住地']);
  return {
    id: p.id,
    displayName: readTitle(props['表示名']),
    // 自社社員DBは人手入力のため表記ゆれ（'JS'/'k8s' 等）が入りやすい。読出時に正規化してマッチングに乗せる
    skills: normalizeSkills(readMultiSelect(props['スキル'])),
    experienceYears: readNumber(props['経験年数']) ?? null,
    requiredProjectRate: readNumber(props['必要案件単価']) ?? null,
    residence,
    prefecture: normalizePrefecture(residence),
    availableDate: '',
    availableFrom: readDate(props['稼働可能日']) ?? null,
    remoteWish: labelToRemote(readSelect(props['リモート希望'])),
    status: readSelect(props['ステータス']) === 'アサイン済' ? 'assigned' : 'available',
    notionPageId: p.id,
  };
}

// マッチ結果のステータスをNotion側で更新する（確認UIの操作を系のstore=Notionへ反映）
export async function updateMatchStatus(notionPageId: string, status: MatchStatus): Promise<void> {
  if (dbProvider() === 'sheets') return sheetsDb.updateMatchStatusSheets(notionPageId, status);
  await throttle(() =>
    notion.pages.update({
      page_id: notionPageId,
      properties: { ステータス: { select: { name: matchStatusLabel(status) } } },
    } as never),
  );
}

// ===== フィードバック（マッチ評価ログ）: 複数人運用の共有の正 =====

export async function saveMatchFeedback(fb: MatchFeedback): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveMatchFeedbackSheets(fb);
  if (!FEEDBACK_DB_ID) {
    console.warn('NOTION_FEEDBACK_DB_ID が未設定 — フィードバックの保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(FEEDBACK_DB_ID);
  const properties: Record<string, unknown> = {
    マッチ: { title: toRichText(fb.matchTitle) },
    元マッチID: { rich_text: toRichText(fb.matchId) },
    評価: { select: { name: FB_VERDICT_LABEL[fb.verdict] } },
    メモ: { rich_text: toRichText(fb.note) },
    評価者: { rich_text: toRichText(fb.reviewer) },
    日時: { date: { start: fb.at } },
  };
  if (fb.band) properties['バンド'] = { select: { name: fb.band } };
  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    [],
  );
}

export async function fetchRecentFeedback(limit = 200): Promise<MatchFeedback[]> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchRecentFeedbackSheets(limit);
  if (!FEEDBACK_DB_ID) return [];
  const dataSourceId = await resolveDataSourceId(FEEDBACK_DB_ID);
  const pages = await queryAll(dataSourceId, { sorts: [{ property: '日時', direction: 'descending' }] } as QueryArgs, limit);
  return pages.map((page) => {
    const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
    const bandRaw = readSelect(props['バンド']);
    return {
      matchId: readRichText(props['元マッチID']),
      matchTitle: readTitle(props['マッチ']),
      verdict: readSelect(props['評価']) === 'ズレ' ? 'bad' : 'good',
      note: readRichText(props['メモ']),
      reviewer: readRichText(props['評価者']),
      band: bandRaw === 'strong' || bandRaw === 'tentative' ? bandRaw : undefined,
      at: readDate(props['日時']) ?? nowIso(),
    };
  });
}

// ===== スキル同義辞書（共有・育てる） =====
export async function saveSkillEquivalence(e: SkillEquivalence): Promise<string> {
  if (dbProvider() === 'sheets') return sheetsDb.saveSkillEquivalenceSheets(e);
  if (!SKILL_EQUIV_DB_ID) {
    console.warn('NOTION_SKILL_EQUIV_DB_ID が未設定 — スキル同義の保存をスキップします');
    return '';
  }
  const dataSourceId = await resolveDataSourceId(SKILL_EQUIV_DB_ID);
  return createPageWithBody(
    {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        スキルA: { title: toRichText(e.a) },
        スキルB: { rich_text: toRichText(e.b) },
        追加者: { rich_text: toRichText(e.addedBy) },
        日時: { date: { start: e.at } },
      },
    } as never,
    [],
  );
}

export async function fetchSkillEquivalences(limit = 500): Promise<SkillEquivalence[]> {
  if (dbProvider() === 'sheets') return sheetsDb.fetchSkillEquivalencesSheets(limit);
  if (!SKILL_EQUIV_DB_ID) return [];
  const dataSourceId = await resolveDataSourceId(SKILL_EQUIV_DB_ID);
  const pages = await queryAll(dataSourceId, { sorts: [{ property: '日時', direction: 'descending' }] } as QueryArgs, limit);
  return pages.map((page) => {
    const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      a: readTitle(props['スキルA']),
      b: readRichText(props['スキルB']),
      addedBy: readRichText(props['追加者']),
      at: readDate(props['日時']) ?? nowIso(),
    };
  });
}

// 指定した親ページの下に、Markdownを変換した子ページを作成する
// （ブリーフィング・週次ダイジェストの出力先）
export async function createChildPage(
  parentPageId: string,
  title: string,
  markdown: string,
): Promise<string> {
  return createPageWithBody(
    {
      parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: { title: toRichText(title) } },
    } as never,
    markdownToBlocks(markdown),
  );
}

// 簡易 Markdown → Notion ブロック変換（見出し/箇条書き/段落）
function markdownToBlocks(md: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (line.startsWith('### ')) blocks.push(headingBlock('heading_3', line.slice(4)));
    else if (line.startsWith('## ')) blocks.push(headingBlock('heading_2', line.slice(3)));
    else if (line.startsWith('# ')) blocks.push(headingBlock('heading_1', line.slice(2)));
    else if (/^[-*] /.test(line))
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: toRichText(stripInlineMd(line.slice(2))) },
      });
    else if (numbered)
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: toRichText(stripInlineMd(numbered[2])) },
      });
    else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(stripInlineMd(line)) } });
  }
  return blocks;
}

function headingBlock(
  type: 'heading_1' | 'heading_2' | 'heading_3',
  text: string,
): Record<string, unknown> {
  return { object: 'block', type, [type]: { rich_text: toRichText(stripInlineMd(text)) } };
}

// Notion のプレーン rich_text は Markdown 記法を解釈しないため、装飾記号を除去する
function stripInlineMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*>\s?/, '');
}

// Notionシグナルを取得する（対話インターフェース・ストーリー分析で使用）
export async function fetchRecentSignals(limit = 50): Promise<Signal[]> {
  if (!SIGNAL_DB_ID) {
    console.warn('NOTION_SIGNAL_DB_ID が未設定 — シグナルなしで継続します');
    return [];
  }
  const dataSourceId = await resolveDataSourceId(SIGNAL_DB_ID);
  const response = await throttle(() =>
    notion.dataSources.query({
      data_source_id: dataSourceId,
      sorts: [{ property: '日時', direction: 'descending' }],
      page_size: limit,
    }),
  );

  return response.results.map((page) => {
    const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      id: page.id,
      rawLogIds: [],
      timestamp: new Date(readDate(props['日時']) ?? nowIso()),
      category: (readSelect(props['カテゴリ']) ?? 'idea') as Signal['category'],
      summary: readTitle(props['概要']),
      detail: '',
      tags: readMultiSelect(props['タグ']),
      importance: readNumber(props['重要度']) ?? 5,
      relatedPeople: readMultiSelect(props['関係者']),
      notionPageId: page.id,
    };
  });
}

// Notionストーリーを取得する（対話インターフェースで使用）
export async function fetchRecentStories(limit = 20): Promise<Story[]> {
  if (!STORY_DB_ID) {
    console.warn('NOTION_STORY_DB_ID が未設定 — ストーリーなしで継続します');
    return [];
  }
  const dataSourceId = await resolveDataSourceId(STORY_DB_ID);
  const response = await throttle(() =>
    notion.dataSources.query({
      data_source_id: dataSourceId,
      sorts: [{ property: '期間（開始）', direction: 'descending' }],
      page_size: limit,
    }),
  );

  return response.results.map((page) => {
    const p = page as {
      properties?: Record<string, unknown>;
      created_time?: string;
      last_edited_time?: string;
    };
    const props = p.properties ?? {};
    // 終了日時は Notion に保存していないため開始日時と同じにする（1970年になるのを防ぐ）
    const startIso = readDate(props['期間（開始）']) ?? nowIso();
    return {
      id: page.id,
      title: readTitle(props['タイトル']),
      signalIds: [],
      period: { start: new Date(startIso), end: new Date(startIso) },
      narrative: '',
      causalChain: [],
      insight: readRichText(props['洞察']),
      createdAt: new Date(p.created_time ?? nowIso()),
      updatedAt: new Date(p.last_edited_time ?? nowIso()),
      notionPageId: page.id,
    };
  });
}

// --- プロパティ読み取りヘルパー（Notionの動的な型に対応）---
function nowIso(): string {
  // Notionから取れなかった場合のフォールバック（値が無いページのみ）
  return new Date(0).toISOString();
}

function readTitle(prop: unknown): string {
  const t = (prop as { title?: Array<{ plain_text?: string; text?: { content?: string } }> })?.title;
  return t?.[0]?.plain_text ?? t?.[0]?.text?.content ?? '';
}

function readRichText(prop: unknown): string {
  const t = (prop as { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> })?.rich_text;
  return (t ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
}

function readSelect(prop: unknown): string | undefined {
  return (prop as { select?: { name?: string } })?.select?.name;
}

function readMultiSelect(prop: unknown): string[] {
  return ((prop as { multi_select?: Array<{ name: string }> })?.multi_select ?? []).map((m) => m.name);
}

function readNumber(prop: unknown): number | undefined {
  return (prop as { number?: number })?.number;
}

function readDate(prop: unknown): string | undefined {
  return (prop as { date?: { start?: string } })?.date?.start;
}
