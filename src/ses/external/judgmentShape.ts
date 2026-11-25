import type { RawProperJudgment } from '../proper/judge.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// 手書きの判定ファイルで欄の型が入れ替わることがある（都道府県に配列・気になる点に空文字など）ため、集計の前に型を直す
export function normalizeExtJudgment(raw: RawProperJudgment): { judgment: RawProperJudgment; fixed: boolean } {
  const before = JSON.stringify(raw);
  const j = { ...(raw as unknown as Record<string, unknown>) };
  const concernsOk = Array.isArray(j.concerns) && j.concerns.length > 0;
  if (Array.isArray(j.workPrefecture) && j.workPrefecture.every((x) => typeof x === 'string') && !concernsOk) j.concerns = j.workPrefecture;
  if (typeof j.workPrefecture !== 'string') j.workPrefecture = '';
  j.concerns = Array.isArray(j.concerns) ? j.concerns.filter((x) => typeof x === 'string') : typeof j.concerns === 'string' && j.concerns ? [j.concerns] : [];
  for (const k of ['work', 'levelFit', 'preferenceFit', 'pitch', 'rateReason'] as const) {
    if (k === 'rateReason' && j[k] === undefined) continue;
    j[k] = str(j[k]);
  }
  if (j.verdict !== 'recommend' && j.verdict !== 'conditional' && j.verdict !== 'reject') j.verdict = 'reject';
  j.requirements = Array.isArray(j.requirements)
    ? j.requirements.map((r) => {
        const o = { ...((r && typeof r === 'object' ? r : {}) as Record<string, unknown>) };
        for (const k of ['requirement', 'kind', 'quote', 'status', 'evidence', 'note']) {
          if (typeof o[k] !== 'string' && !(k === 'kind' && o[k] === undefined) && !(k === 'quote' && o[k] === undefined)) o[k] = '';
        }
        return o;
      })
    : [];
  const judgment = j as unknown as RawProperJudgment;
  return { judgment, fixed: JSON.stringify(judgment) !== before };
}
