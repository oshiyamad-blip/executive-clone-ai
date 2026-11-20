// 外部マッチ（試行）: 提携先の要員を、プロパー用のAI判定（judgeSystemFor・verifyJudgment）に渡せる形にする。
// 経歴は抽出した項目と要員メール本文の冒頭（個人情報を伏せたもの）。同じ判定の規則で見る
import { maskPii } from '../pii.js';
import type { Engineer, OwnEngineer } from '../../types/index.js';

const BODY_MAX = 1500;

export function extProfileText(e: Engineer, bodyHead: string): string {
  const lines = [`スキル: ${e.skills.join('、') || '（記載なし）'}`];
  if (e.experienceYears !== null) lines.push(`経験年数: ${e.experienceYears}年`);
  if (e.age !== null) lines.push(`年齢: ${e.age}歳`);
  if (e.residence) lines.push(`居住地: ${e.residence}`);
  if (e.availableDate) lines.push(`稼働開始: ${e.availableDate}`);
  if (e.utilization) lines.push(`稼働率: ${e.utilization}`);
  const body = maskPii(bodyHead).trim().slice(0, BODY_MAX);
  if (body) lines.push('', '要員メール（抜粋）:', body);
  return lines.join('\n');
}

export function extOwnEngineer(e: Engineer, bodyHead: string): OwnEngineer {
  return {
    id: e.id,
    displayName: e.displayName,
    skills: e.skills,
    experienceYears: e.experienceYears,
    requiredProjectRate: e.desiredRate,
    residence: e.residence,
    prefecture: e.prefecture,
    availableDate: e.availableDate,
    availableFrom: e.availableFrom,
    remoteWish: e.remoteWish,
    status: 'available',
    profileText: extProfileText(e, bodyHead),
  };
}

// 判定ファイル・システム文のファイル名に使う短い要員キー
export const extKeyOf = (engineerId: string): string => `X${engineerId.replace(/^eng_/, '').slice(0, 6)}`;
