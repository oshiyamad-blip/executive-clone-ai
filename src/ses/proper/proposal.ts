// プロパー（自社社員）を案件にご提案する「全員に返信」文面（LLMを使わない定型文）。
// 社外に出る文面のため、氏名ではなく提案用表記（イニシャル）だけを使い、必要案件単価（社内の採算ライン）は書かない。
import { buildReplyRef } from '../draft.js';
import { unsafeOutgoingText } from '../injection.js';
import { jstDateOf } from '../dates.js';
import type { DraftRef, Project, ProperEngineer, RemoteOption } from '../../types/index.js';

// 提案用表記が未入力のときの差し込み。氏名で代用しない（送る前に営業が気付けるよう目立つ表記にする）
export const MISSING_INITIALS_PLACEHOLDER = '《提案用表記（イニシャル）を記入》';

const REMOTE_WISH_TEXT: Record<RemoteOption, string> = {
  full: 'フルリモート希望',
  partial: '一部リモート希望',
  none: '出社・常駐可',
  unknown: '',
};

// 社外に出す稼働開始の表記。管理表の「稼働可能日」は人・AIの自由記述（「産休明け」「現案件（○○銀行）終了後」等、
// 本人の事情や今の客先が入り得る）のため文面には写さず、日付として読めた値と「即日」だけを使う
export function availabilityText(e: Pick<ProperEngineer, 'availableDate' | 'availableFrom'>, today: Date = new Date()): string {
  if (/^(?:即日|即稼働可|即時|随時)(?:可)?$/.test(e.availableDate.normalize('NFKC').replace(/\s/g, ''))) return '即日';
  const m = (e.availableFrom ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '別途ご相談';
  if (`${m[1]}-${m[2]}-${m[3]}` <= jstDateOf(today)) return '即日';
  const day = Number(m[3]);
  return `${m[1]}年${Number(m[2])}月${day > 1 ? `${day}日` : ''}〜`;
}

export function buildProperProposalBody(e: ProperEngineer, project: Project): string {
  const label = e.proposalLabel || MISSING_INITIALS_PLACEHOLDER;
  const lines = [
    `${project.agentContact || 'ご担当者'}様`,
    '',
    'いつもお世話になっております。',
    `ご案内いただいた案件「${project.title}」につきまして、弊社所属のエンジニアをご提案させていただきます。`,
    '',
    '■ご提案要員（弊社社員）',
    `・イニシャル: ${label}`,
    `・主なスキル: ${e.skills.slice(0, 12).join('、')}`,
    `・経験年数: ${e.experienceYears !== null ? `${e.experienceYears}年` : 'スキルシートをご参照ください'}`,
    `・稼働開始: ${availabilityText(e)}`,
  ];
  if (e.prefecture) lines.push(`・居住地: ${e.prefecture}`);
  if (REMOTE_WISH_TEXT[e.remoteWish]) lines.push(`・勤務形態: ${REMOTE_WISH_TEXT[e.remoteWish]}`);
  lines.push(
    '',
    '詳細なスキルシートは別途お送りいたします。',
    '単価等の条件につきましては、ご相談させていただけますと幸いです。',
    'ご検討のほど、よろしくお願いいたします。',
  );
  return lines.join('\n');
}

// 提案文面にそのまま差し込む項目（案件名・営業元担当はスプレッドシートで書き換えられる）に URL・メールアドレス・
// 指示らしき記載があるか。あれば文面を用意しない（書き換えた文言に署名を付けて社外への下書きにしないため）
export function properProposalTextSuspicious(e: ProperEngineer, project: Project): boolean {
  return unsafeOutgoingText([
    project.title, project.agentContact, e.proposalLabel, ...e.skills.slice(0, 12), e.availableDate, e.availableFrom, e.prefecture,
  ]);
}

// 案件の元メールへの全員に返信（元メール情報が無ければ営業元メール宛）。宛先が全く無ければ作らない
export function buildProperProposalDraft(e: ProperEngineer, project: Project): DraftRef | undefined {
  if (!project.replyTarget?.from && !project.agentEmail) return undefined;
  if (properProposalTextSuspicious(e, project)) return undefined;
  return buildReplyRef(
    project.replyTarget,
    project.agentEmail,
    `【ご提案】${project.title} - 弊社エンジニアのご紹介`,
    buildProperProposalBody(e, project),
  );
}
