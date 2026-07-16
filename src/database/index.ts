import { Client } from '@notionhq/client';
import type { Signal, Story } from '../types/index.js';

// Notion API バージョン 2025-09-03 以降、database ID と data source ID は別物になった。
// ページ作成・クエリは data_source_id ベースで行う（database_id は不可）。
// @notionhq/client v5 は既定で 2025-09-03 を使う。
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const SIGNAL_DB_ID = process.env.NOTION_SIGNAL_DB_ID ?? '';
const STORY_DB_ID = process.env.NOTION_STORY_DB_ID ?? '';

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
    dataSourceCache.set(databaseId, id);
    return id;
  } catch {
    // 与えられた ID が既に data_source_id の場合はそのまま使う
    dataSourceCache.set(databaseId, databaseId);
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
    return {
      id: page.id,
      title: readTitle(props['タイトル']),
      signalIds: [],
      period: { start: new Date(readDate(props['期間（開始）']) ?? nowIso()), end: new Date(nowIso()) },
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
