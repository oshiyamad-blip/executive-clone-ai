import { generateJson } from '../llm/index.js';
import type { RawLog, Signal, SignalCategory } from '../types/index.js';

// シグナル抽出の中核ロジック（要件3.2）。
// バッチ（index.ts）とリハーサル（rehearsal）から共用する。Notionへは書き込まない。

const IMPORTANCE_THRESHOLD = Number(process.env.SIGNAL_IMPORTANCE_THRESHOLD ?? '5');

const EXTRACTION_SYSTEM = `あなたは経営者のデータから重要な情報を抽出する専門家です。
テキストデータを分析し、経営や事業に影響を与える重要情報のみを抽出してください。

抽出基準:
- hypothesis: 新しいビジネス仮説や洞察
- key_person: 重要な人材や外部有識者との接触
- idea: 新規・既存事業に関するアイデア
- decision: 経営方針や重要な判断
- trend: 業界動向や競合情報

importance（重要度）は1〜10の整数で評価してください:
- 8〜10: 会社の方向性に関わる（大型投資・提携・方針転換・重要人物）
- 5〜7: 事業運営上おさえておくべき（顧客対応方針・現場の重要な気づき・競合動向）
- 1〜4: 参考程度（後で見返す価値が低いもの）

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
          importance: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: '経営へのインパクト（1〜10。10=会社の方向を変えるレベル）',
          },
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

export interface ExtractionOutcome {
  signals: Signal[];
  // 抽出（LLM呼び出し）自体が失敗したログのID。呼び出し側はこれらを処理済みに
  // マークしてはいけない（マークすると障害日のデータが復元不能に失われる）。
  failedLogIds: string[];
}

export async function extractSignals(logs: RawLog[]): Promise<ExtractionOutcome> {
  if (logs.length === 0) return { signals: [], failedLogIds: [] };

  const signals: Signal[] = [];
  const failedLogIds: string[] = [];
  for (const log of logs) {
    try {
      const extracted = await extractFromLog(log);
      signals.push(...extracted);
    } catch (err) {
      console.error(`抽出失敗 (log ${log.id}): ${String(err)}`);
      failedLogIds.push(log.id);
    }
  }

  console.log(`シグナル抽出完了: ${logs.length}件のログから${signals.length}件を抽出`);
  return { signals, failedLogIds };
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
