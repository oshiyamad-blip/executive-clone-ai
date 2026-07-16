import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import type { RawLog, Signal, SignalCategory } from '../types/index.js';

const client = new Anthropic();

const EXTRACTION_SYSTEM = `あなたは経営者のデータから重要な情報を抽出する専門家です。
テキストデータを分析し、経営や事業に影響を与える重要情報のみを抽出してください。

抽出基準:
- hypothesis: 新しいビジネス仮説や洞察
- key_person: 重要な人材や外部有識者との接触
- idea: 新規・既存事業に関するアイデア
- decision: 経営方針や重要な判断
- trend: 業界動向や競合情報

除外するもの: 日常的な挨拶、雑談、事務的な連絡、スケジュール確認

シグナルがない場合は空のJSON配列 [] を返してください。`;

interface ExtractedSignal {
  category: SignalCategory;
  summary: string;
  detail: string;
  tags: string[];
  importance: number;
  relatedPeople: string[];
}

export async function extractSignals(logs: RawLog[]): Promise<Signal[]> {
  if (logs.length === 0) return [];

  const signals: Signal[] = [];

  for (const log of logs) {
    const extracted = await extractFromLog(log);
    signals.push(...extracted);
  }

  console.log(`シグナル抽出完了: ${logs.length}件のログから${signals.length}件を抽出`);
  return signals;
}

async function extractFromLog(log: RawLog): Promise<Signal[]> {
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `以下のテキストからシグナルを抽出してJSON配列で返してください。\n\n---\n${log.content}\n---`,
      },
    ],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '';

  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const extracted: ExtractedSignal[] = JSON.parse(match[0]);
    return extracted.map((e) => ({
      id: `sig_${log.timestamp.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
      rawLogIds: [log.id],
      timestamp: log.timestamp,
      category: e.category,
      summary: e.summary,
      detail: e.detail,
      tags: e.tags,
      importance: e.importance,
      relatedPeople: e.relatedPeople,
    }));
  } catch {
    return [];
  }
}

// バッチ実行エントリーポイント
// 本番ではcollectAllの結果を受け取るか、Notionの未処理RawLogを取得して処理する
const sampleLog: RawLog = {
  id: 'sample',
  source: 'slack',
  timestamp: new Date(),
  content: '（テスト実行: 実際のログをデータベースから取得して処理してください）',
  participants: [],
  metadata: {},
};

extractSignals([sampleLog]).then((signals) => {
  console.log(`抽出結果: ${signals.length}件`);
}).catch(console.error);
