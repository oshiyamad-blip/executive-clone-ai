// 基本設計が必須の案件に、基本設計の経験が無い要員を載せないための判定（営業リストの優先度・ラベルの評価で使う）
import type { ProperEngineer, ProperJudgment } from '../../types/index.js';

export const BASIC_DESIGN_WORDS = /基本設計|外部設計|概要設計/;

// 必須の要件の文（AI判定の checks の必須、無ければ案件の必須スキル）に基本設計の語があるか
export function requiresBasicDesign(judgment: Pick<ProperJudgment, 'checks'> | undefined, requiredSkills: readonly string[] = []): boolean {
  const fromChecks = (judgment?.checks ?? []).filter((k) => k.kind === '必須').some((k) => BASIC_DESIGN_WORDS.test(k.requirement));
  return fromChecks || requiredSkills.some((s) => BASIC_DESIGN_WORDS.test(s));
}

// 経歴に基本設計の経験があるか: 工程ごとの年数に基本設計があるか、プロフィール・スキルシートの文に語があるか
export function hasBasicDesignExperience(e: Pick<ProperEngineer, 'level' | 'profileText'>): boolean {
  if ((e.level?.phaseYears ?? []).some((p) => p.phase === '基本設計' && p.years > 0)) return true;
  return BASIC_DESIGN_WORDS.test(e.profileText ?? '');
}
