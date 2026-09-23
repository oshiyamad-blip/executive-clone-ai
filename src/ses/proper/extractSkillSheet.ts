// プロパー（自社社員）のスキルシート1ファイル → 提案に必要な項目の抽出（1ファイル1コール・抽出用モデル）。
// PDFはdocumentブロックでそのまま、Excel/Word/Googleドキュメントはテキスト化して渡す。構造化出力でJSONを受ける。
// 住所の番地・電話番号・生年月日などは抽出しない（管理表に載せる必要が無い個人情報のため）。
import { generateJsonWithDocuments } from '../../llm/index.js';
import type { HealAttempt } from '../heal/retry.js';
import { isDemo, extractModel } from '../config.js';
import { withExtractModelFallback } from '../extractModelFallback.js';
import { normalizeSkills } from '../skillDict.js';
import { tallySkillTokens } from '../skillStats.js';
import { normalizePrefecture } from '../prefecture.js';
import { SafeLogError } from '../redact.js';
import { callLimits } from '../schedule.js';
import type { RemoteOption } from '../../types/index.js';
import type { SkillSheetContent } from './drive.js';

const REMOTE_ENUM = ['full', 'partial', 'none', 'unknown'] as const;

const SKILL_SHEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    displayName: { type: 'string' },
    initials: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    experienceYears: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    residence: { type: 'string' },
    remoteWish: { type: 'string', enum: [...REMOTE_ENUM] },
    availableDateText: { type: 'string' },
    availableFromIso: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    desiredRateMan: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  },
  required: [
    'displayName',
    'initials',
    'skills',
    'experienceYears',
    'residence',
    'remoteWish',
    'availableDateText',
    'availableFromIso',
    'desiredRateMan',
  ],
} as const;

function systemPrompt(todayIso: string): string {
  return `あなたはSES事業者の営業アシスタントです。自社社員のスキルシート（経歴書）から、案件への提案に必要な項目を抽出してください。
今日の日付は ${todayIso} です。

抽出のルール:
- displayName: 氏名（記載どおり。無ければ空文字）
- initials: 提案用のローマ字イニシャル（例: "K.S."）。シートにイニシャルが書かれていればそのまま使う。
  氏名の読み（ふりがな・ローマ字）が書かれている場合のみ「名.姓.」の順で作る。読みが分からない漢字の氏名から推測しない（分からなければ空文字）
- skills: プログラミング言語・フレームワーク・DB・クラウド・OS・ミドルウェア・主要ツールの名称。
  実務経験のあるものを優先し、重要度の高い順に最大20件。資格名や業務知識は含めない。
  1要素に1つの技術名だけを入れ（「Java(Spring Boot)」→ "Java", "Spring Boot"）、バージョン・経験年数は名前に含めない（「Python3」→ "Python"）
- experienceYears: IT業界での実務経験年数の合計（数値。分からなければ null）
- residence: 居住地（都道府県と市区町村まで。番地・建物名は含めない。無ければ空文字）
- remoteWish: リモート勤務の希望。full（フルリモート希望）/ partial（一部リモート希望）/ none（常駐可・出社希望）/ unknown（記載なし）
- availableDateText: 稼働開始可能時期の記載（例: "即日", "2026年10月〜"。記載なしは空文字）
- availableFromIso: 稼働開始可能日が特定できれば YYYY-MM-DD（月だけなら1日）。「即日」は今日の日付。分からなければ null
- desiredRateMan: 希望単価の記載があれば万円/月の数値。無ければ null
- 電話番号・メールアドレス・生年月日・番地などの連絡先情報は、どの項目にも含めないでください`;
}

interface RawSkillSheet {
  displayName: string;
  initials: string;
  skills: string[];
  experienceYears: number | null;
  residence: string;
  remoteWish: RemoteOption;
  availableDateText: string;
  availableFromIso: string | null;
  desiredRateMan: number | null;
}

export interface SkillSheetProfile extends RawSkillSheet {
  prefecture: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 提案用表記（社外に出る提案文面に載る）として使えるイニシャルか。「T.Y.」「TY」「T・Y」「K.S.T」のような
// ローマ字2〜3文字だけを通し、氏名の一部（ローマ字・漢字）を含むものは捨てる（''＝未入力扱いで記入を促す）
export function sanitizeInitials(raw: string, displayName: string): string {
  const value = raw.normalize('NFKC').trim();
  const upper = value.toUpperCase();
  if (!/^[A-Z](?:[.・･]?\s?[A-Z]){1,2}[.・･]?$/.test(upper)) return '';
  const letters = upper.replace(/[^A-Z]/g, '');
  const nameParts = displayName
    .normalize('NFKC')
    .toUpperCase()
    .split(/[\s・,，()（）]+/)
    .map((t) => t.replace(/[^A-Z]/g, ''))
    .filter((t) => t.length >= 2);
  if (nameParts.some((part) => letters.includes(part) || part === letters)) return '';
  return value;
}

// 指示に反して番地まで返された場合に備え、最初の数字以降（丁目・番地・建物）を落とす
function coarseResidence(raw: string): string {
  return raw.normalize('NFKC').replace(/\d.*$/, '').trim();
}

// attempt は自動修復（heal/retry.ts）の再試行・上位モデル昇格用（出力上限の拡大・SDK再試行の抑止を含む）
export async function extractSkillSheet(content: SkillSheetContent, attempt?: HealAttempt): Promise<SkillSheetProfile> {
  if (isDemo()) throw new SafeLogError('プロパー: demoではスキルシートの抽出を行いません');
  const maxTokens = 4000 * (attempt?.maxTokensFactor ?? 1);
  // 出力量に応じた待ち時間（SDKの既定の10分×再試行で、実行の期限・ジョブの制限時間を越えないように）
  const limits = callLimits(60_000 + maxTokens * 15, attempt ? attempt.sdkRetries : 1);
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const system = systemPrompt(todayJst);
  // 抽出モデルが退役・提供終了で使えなければ、判定用モデルに切り替えて呼び直す（extractModelFallback.ts）
  const raw = await withExtractModelFallback(attempt?.model ?? extractModel(), (model) => {
    const opts = { model, maxTokens, ...limits };
    return content.kind === 'pdf'
      ? generateJsonWithDocuments<RawSkillSheet>(
          system,
          '添付のスキルシートから項目を抽出してください。',
          SKILL_SHEET_SCHEMA,
          [{ mediaType: 'application/pdf', dataBase64: content.base64 }],
          opts,
        )
      : generateJsonWithDocuments<RawSkillSheet>(
          system,
          `以下のスキルシートから項目を抽出してください。\n\n${content.text}`,
          SKILL_SHEET_SCHEMA,
          [],
          opts,
        );
  });

  const exp = raw.experienceYears;
  const rate = raw.desiredRateMan;
  const displayName = raw.displayName.trim();
  const initials = sanitizeInitials(raw.initials, displayName);
  const skills = normalizeSkills(raw.skills);
  tallySkillTokens(skills, [displayName, raw.initials]);
  return {
    displayName,
    initials,
    skills,
    experienceYears: exp !== null && Number.isFinite(exp) && exp >= 0 && exp < 60 ? exp : null,
    residence: coarseResidence(raw.residence),
    prefecture: normalizePrefecture(raw.residence),
    remoteWish: REMOTE_ENUM.includes(raw.remoteWish) ? raw.remoteWish : 'unknown',
    availableDateText: raw.availableDateText.trim(),
    availableFromIso: raw.availableFromIso && ISO_DATE.test(raw.availableFromIso) ? raw.availableFromIso : null,
    desiredRateMan: rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}
