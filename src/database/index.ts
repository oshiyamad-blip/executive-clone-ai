import { Client } from '@notionhq/client';
import type { Signal, Story } from '../types/index.js';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const SIGNAL_DB_ID = process.env.NOTION_SIGNAL_DB_ID ?? '';
const STORY_DB_ID = process.env.NOTION_STORY_DB_ID ?? '';

// シグナルをNotionシグナルDBに保存する
export async function saveSignal(signal: Signal): Promise<string> {
  const response = await notion.pages.create({
    parent: { database_id: SIGNAL_DB_ID },
    properties: {
      概要: { title: [{ text: { content: signal.summary } }] },
      カテゴリ: { select: { name: signal.category } },
      重要度: { number: signal.importance },
      日時: { date: { start: signal.timestamp.toISOString() } },
      タグ: { multi_select: signal.tags.map((t) => ({ name: t })) },
      関係者: { multi_select: signal.relatedPeople.map((p) => ({ name: p })) },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: signal.detail } }],
        },
      },
    ],
  });
  return response.id;
}

// ストーリーをNotionストーリーDBに保存する
export async function saveStory(story: Story): Promise<string> {
  const response = await notion.pages.create({
    parent: { database_id: STORY_DB_ID },
    properties: {
      タイトル: { title: [{ text: { content: story.title } }] },
      '期間（開始）': { date: { start: story.period.start.toISOString() } },
      洞察: { rich_text: [{ text: { content: story.insight } }] },
    },
    children: [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: 'ナラティブ' } }] },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: story.narrative } }],
        },
      },
    ],
  });
  return response.id;
}

// Notionシグナルを取得する（対話インターフェースおよびストーリー分析で使用）
export async function fetchRecentSignals(limit = 50): Promise<Signal[]> {
  if (!SIGNAL_DB_ID) {
    console.warn('NOTION_SIGNAL_DB_ID が未設定 — シグナルなしで継続します');
    return [];
  }

  const response = await notion.databases.query({
    database_id: SIGNAL_DB_ID,
    sorts: [{ property: '日時', direction: 'descending' }],
    page_size: limit,
  });

  return response.results.map((page) => {
    // Notion SDKのpage.propertiesは動的な型のためanyキャストが必要
    const p = page as Record<string, unknown> & { properties: Record<string, unknown> };
    const props = p.properties;
    type NotionSelect = { select?: { name?: string } };
    type NotionNumber = { number?: number };
    type NotionDate = { date?: { start?: string } };
    type NotionMultiSelect = { multi_select?: Array<{ name: string }> };
    type NotionTitle = { title?: Array<{ text?: { content?: string } }> };

    return {
      id: page.id,
      rawLogIds: [],
      timestamp: new Date(((props['日時'] as NotionDate).date?.start) ?? Date.now()),
      category: ((props['カテゴリ'] as NotionSelect).select?.name ?? 'idea') as Signal['category'],
      summary: ((props['概要'] as NotionTitle).title?.[0]?.text?.content) ?? '',
      detail: '',
      tags: ((props['タグ'] as NotionMultiSelect).multi_select ?? []).map((t) => t.name),
      importance: ((props['重要度'] as NotionNumber).number) ?? 5,
      relatedPeople: ((props['関係者'] as NotionMultiSelect).multi_select ?? []).map((t) => t.name),
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

  const response = await notion.databases.query({
    database_id: STORY_DB_ID,
    sorts: [{ property: '期間（開始）', direction: 'descending' }],
    page_size: limit,
  });

  return response.results.map((page) => {
    const p = page as Record<string, unknown> & {
      properties: Record<string, unknown>;
      created_time: string;
      last_edited_time: string;
    };
    const props = p.properties;
    type NotionDate = { date?: { start?: string } };
    type NotionRichText = { rich_text?: Array<{ text?: { content?: string } }> };
    type NotionTitle = { title?: Array<{ text?: { content?: string } }> };

    return {
      id: page.id,
      title: ((props['タイトル'] as NotionTitle).title?.[0]?.text?.content) ?? '',
      signalIds: [],
      period: {
        start: new Date(((props['期間（開始）'] as NotionDate).date?.start) ?? Date.now()),
        end: new Date(),
      },
      narrative: '',
      causalChain: [],
      insight: ((props['洞察'] as NotionRichText).rich_text?.[0]?.text?.content) ?? '',
      createdAt: new Date(p.created_time),
      updatedAt: new Date(p.last_edited_time),
      notionPageId: page.id,
    };
  });
}
