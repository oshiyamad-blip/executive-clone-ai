// IT 未経験の社員（研修明け）を提案できる案件か。抽出の旗（level.inexperiencedOk）と本文の機械照合のどちらかが真なら true。
// 前の回から繰り越した案件には旗が無いため、本文の照合だけでも判定できるようにしている。
// 「若手可」「20代」「経験浅め可」は IT の実務経験が無い人まで受け入れる意味ではないので、ここでは数えない
import type { Project } from '../types/index.js';

const ACCEPTS =
  /未経験(?:者)?(?:可|OK|歓迎|でも可|でもOK|の方も|の方可|応募可)|経験不問|IT未経験/g;
// 一致の直前の「×」「不可」「NG」と、直後の「不可」「NG」（「IT未経験者不可」の前半だけに一致させない）
const NEGATED_BEFORE = /(?:[×✕✖]\s?|不可|NG)$/;
const NEGATED_AFTER = /^(?:者)?(?:は|も|の方は)?(?:不可|NG|お断り|ご遠慮)/;

export function textAcceptsInexperienced(text: string): boolean {
  const s = text.normalize('NFKC');
  for (const m of s.matchAll(ACCEPTS)) {
    const at = m.index ?? 0;
    if (NEGATED_BEFORE.test(s.slice(Math.max(0, at - 4), at))) continue;
    if (NEGATED_AFTER.test(s.slice(at + m[0].length, at + m[0].length + 6))) continue;
    return true;
  }
  return false;
}

export function acceptsInexperienced(p: Pick<Project, 'title' | 'requiredSkills' | 'preferredSkills' | 'businessFlow' | 'detail' | 'level'>): boolean {
  if (p.level?.inexperiencedOk === true) return true;
  return textAcceptsInexperienced([p.title, ...p.requiredSkills, ...p.preferredSkills, p.businessFlow, p.detail ?? ''].join('\n'));
}
