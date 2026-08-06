// SESデータのラベル・シリアライズ変換（DBプロバイダ共通）。
// Notion（index.ts）と Google Sheets（sheets.ts）の両バックエンドが同じ表記で保存・復元するための
// 単一の変換層。ここを変えると既存データの読み戻しに影響するため、値の変更は慎重に。
import type { RemoteOption, MatchStatus, ReplyTarget, FeedbackVerdict } from '../types/index.js';

export const REMOTE_LABEL: Record<RemoteOption, string> = {
  full: 'フル',
  partial: '一部',
  none: '不可',
  unknown: '不明',
};

export function remoteLabel(remote: RemoteOption): string {
  return REMOTE_LABEL[remote];
}

export function labelToRemote(label: string | undefined): RemoteOption {
  const entry = (Object.entries(REMOTE_LABEL) as Array<[RemoteOption, string]>).find(([, v]) => v === label);
  return entry ? entry[0] : 'unknown';
}

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  unconfirmed: '未確認',
  introduced: '紹介済',
  closed_won: '成約',
  dropped: '見送り',
};

export function matchStatusLabel(status: MatchStatus): string {
  return MATCH_STATUS_LABEL[status];
}

export const FB_VERDICT_LABEL: Record<FeedbackVerdict, string> = { good: '妥当', bad: 'ズレ' };

// 要員の「営業元」は 会社/担当/メール を1テキストに結合して保存する。
// 読み戻し時は " / " 区切りで分解する（値自体に " / " を含む場合もメールは '@' で確実に拾う）。
export function combineAgentInfo(company: string, contact: string, email: string): string {
  return `${company} / ${contact} / ${email}`;
}

export function parseAgentInfo(combined: string): { company: string; contact: string; email: string } {
  const parts = combined.split(' / ').map((s) => s.trim());
  const emailIdx = parts.findIndex((p) => p.includes('@'));
  const email = emailIdx >= 0 ? parts[emailIdx] : '';
  const rest = parts.filter((_, i) => i !== emailIdx);
  return { company: rest[0] ?? '', contact: rest[1] ?? '', email };
}

// 全員に返信のメタ情報（ReplyTarget）をJSONで永続化・復元する。
// これが無いと --match-only（DB読み出し）経路の下書きがスレッド返信にならない。
export function replyMetaJson(rt: ReplyTarget | undefined): string {
  return rt ? JSON.stringify(rt) : '';
}

export function parseReplyMeta(json: string): ReplyTarget | undefined {
  if (!json) return undefined;
  try {
    const o = JSON.parse(json) as ReplyTarget;
    return o && typeof o.from === 'string' && o.from ? o : undefined;
  } catch {
    return undefined;
  }
}

// スキル等の配列⇄テキスト（カンマ区切り）変換。Sheetsのセルや人手編集と相互運用するため
// 全角読点・カンマの両方を受け付ける。
export function joinList(items: string[]): string {
  return items.join(', ');
}

export function splitList(cell: string | undefined): string[] {
  return (cell ?? '')
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
