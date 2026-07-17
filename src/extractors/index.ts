import '../env.js';
import { generateJson } from '../llm/index.js';
import { loadUnprocessedLogs, markProcessed, pruneProcessedLogs } from '../store/rawLogStore.js';
import { saveSignal } from '../database/index.js';
import type { RawLog, Signal, SignalCategory } from '../types/index.js';

const IMPORTANCE_THRESHOLD = Number(process.env.SIGNAL_IMPORTANCE_THRESHOLD ?? '5');

const EXTRACTION_SYSTEM = `あなたは経営者のデータから重要な情報を抽出する専門家です。
テキストデータを分析し、経営や事業に影響を与える重要情報のみを抽出してください。

抽出基準:
- hypothesis: 新しいビジネス仮説や洞察
- key_person: 重要な人材や外部有識者との接触
- idea: 新規・既存事業に関するアイデア
- decision: 経営方針や重要な判断
- trend: 業界動向や競合情報

除外するもの: 日常的な挨拶、雑談、事務的な連絡、単なるスケジュール確認。
シグナルが1つもなければ空配列を返してください。`;

// 構造化出力（output_config.format）でJSONパースの信頼性を担保する
const SIGNAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['hypothesis', 'key_person', 'idea', 'decision', 'trend'],
          },
          summary: { type: 'string' },
          detail: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: 'integer' },
          relatedPeople: { type: 'array', items: { type: 'string' } },
        },
        required: ['category', 'summary', 'detail', 'tags', 'importance', 'relatedPeople'],
      },
    },
  },
  required: ['signals'],
} as const;

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
    try {
      const extracted = await extractFromLog(log);
      signals.push(...extracted);
    } catch (err) {
      console.error(`抽出失敗 (log ${log.id}): ${String(err)}`);
    }
  }

  console.log(`シグナル抽出完了: ${logs.length}件のログから${signals.length}件を抽出`);
  return signals;
}

async function extractFromLog(log: RawLog): Promise<Signal[]> {
  const parsed = await generateJson<{ signals: ExtractedSignal[] }>(
    EXTRACTION_SYSTEM,
    `以下のテキストからシグナルを抽出してください。\n\n---\n${log.content}\n---`,
    SIGNAL_SCHEMA,
  );
  return (parsed.signals ?? [])
    .filter((e) => e.importance >= IMPORTANCE_THRESHOLD)
    .map((e) => ({
      id: `sig_${log.timestamp.getTime()}_${log.id}_${e.category}`,
      rawLogIds: [log.id],
      timestamp: log.timestamp,
      category: e.category,
      summary: e.summary,
      detail: e.detail,
      tags: e.tags,
      importance: e.importance,
      relatedPeople: e.relatedPeople,
    }));
}

// バッチ実行エントリーポイント（日次）
// ローカルストアの未処理ログを取得し、シグナルを抽出してNotionへ保存する
async function runExtractionBatch(): Promise<void> {
  console.log('=== シグナル抽出バッチ開始 ===');
  const logs = loadUnprocessedLogs();

  if (logs.length === 0) {
    console.log('未処理のログはありません。先に `npm run collect` を実行してください。');
    return;
  }

  const signals = await extractSignals(logs);

  let saved = 0;
  for (const signal of signals) {
    try {
      await saveSignal(signal);
      saved++;
    } catch (err) {
      console.error(`Notion保存失敗 (${signal.summary}): ${String(err)}`);
    }
  }

  // 抽出できたかに関わらず、処理したログは処理済みにする
  markProcessed(logs.map((l) => l.id));
  pruneProcessedLogs(); // 処理済みの生ログを整理してファイルサイズを抑える
  console.log(`=== 抽出バッチ完了: ${saved}件のシグナルをNotionに保存 ===`);
}

runExtractionBatch().catch(console.error);
