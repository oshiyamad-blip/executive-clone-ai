// SESデータのラベル・シリアライズ変換（DBプロバイダ共通）。
// Notion（index.ts）と Google Sheets（sheets.ts）の両バックエンドが同じ表記で保存・復元するための
// 単一の変換層。ここを変えると既存データの読み戻しに影響するため、値の変更は慎重に。
import type { RemoteOption, MatchStatus, ReplyTarget, FeedbackVerdict, DraftRef } from '../types/index.js';

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

// ===== 担当者メール列による下書き依頼（Sheets版のマッチ等のタブ） =====
// 状態列の値。空欄と「未作成」は依頼待ち、「エラー: …」は次回バッチで再試行する。
// 「作成中」は下書き作成の直前に書く目印（作成後の状態書き戻しに失敗しても二重作成しないため）。
export const DRAFT_STATE = {
  pending: '未作成',
  notNeeded: '不要',
  inProgress: '作成中',
  created: '作成済',
  sent: '送信済',
  error: 'エラー',
} as const;

// 作成済・送信済・作成中は機械が上書きしない（文面・下書きデータも固定する）
export function isDraftStateLocked(state: string): boolean {
  const s = state.trim();
  return s.startsWith(DRAFT_STATE.created) || s.startsWith(DRAFT_STATE.sent) || s.startsWith(DRAFT_STATE.inProgress);
}

// 担当者メールが入っていれば下書きを作成しに行く状態か
export function isDraftStateActionable(state: string): boolean {
  const s = state.trim();
  return s === '' || s === DRAFT_STATE.pending || s.startsWith(DRAFT_STATE.error);
}

// 下書きデータ列に保存する片側分。draftId/url は下書き作成時に決まり、from は担当者メールで確定するため持たない
export type StoredDraft = Omit<DraftRef, 'draftId' | 'url' | 'from'>;

export interface StoredDraftData {
  project?: StoredDraft;
  engineer?: StoredDraft;
}

export type DraftSide = keyof StoredDraftData;

export function toStoredDraft(ref: DraftRef): StoredDraft {
  const { draftId: _id, url: _url, from: _from, ...rest } = ref;
  return rest;
}

export function storedToDraftRef(stored: StoredDraft): DraftRef {
  return { ...stored, draftId: '', url: '' };
}

function isStoredDraft(v: unknown): v is StoredDraft {
  const o = v as Partial<StoredDraft> | null;
  return Boolean(o) && typeof o!.to === 'string' && o!.to !== '' && typeof o!.subject === 'string';
}

// 人が壊した・空のセルでも例外にせず、読めた側だけ返す
export function parseDraftData(json: string): StoredDraftData {
  if (!json.trim()) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: StoredDraftData = {};
    if (isStoredDraft(o?.project)) out.project = o.project;
    if (isStoredDraft(o?.engineer)) out.engineer = o.engineer;
    return out;
  } catch {
    return {};
  }
}

// 文面列（人が読む用）。宛先・件名を本文の前に付ける
export function draftDisplayText(d: StoredDraft): string {
  const header = [`To: ${d.to}`, d.cc ? `Cc: ${d.cc}` : '', `Subject: ${d.subject}`].filter(Boolean).join('\n');
  return `${header}\n\n${d.body ?? ''}`;
}

export interface DraftColumns {
  projectState: string;
  engineerState: string;
  projectText: string;
  engineerText: string;
  data: string; // StoredDraftData のJSON（空なら ''）
}

// 再実行で同じマッチを保存し直すときの下書き列の決め方。状態列は人も編集するため空欄を埋める以外は
// 変えない（人が付けた「不要」を戻さない）。作成済等になった側は文面・下書きデータも固定し、
// 依頼前の側だけ最新の生成物に差し替える
export function mergeDraftColumns(
  existing: DraftColumns | null,
  project: DraftRef | undefined,
  engineer: DraftRef | undefined,
): DraftColumns {
  const prev = parseDraftData(existing?.data ?? '');
  const p = mergeDraftSide(existing?.projectState ?? '', existing?.projectText ?? '', prev.project, project);
  const e = mergeDraftSide(existing?.engineerState ?? '', existing?.engineerText ?? '', prev.engineer, engineer);
  const data: StoredDraftData = {};
  if (p.stored) data.project = p.stored;
  if (e.stored) data.engineer = e.stored;
  return {
    projectState: p.state,
    engineerState: e.state,
    projectText: p.text,
    engineerText: e.text,
    data: data.project || data.engineer ? JSON.stringify(data) : '',
  };
}

function mergeDraftSide(
  state: string,
  text: string,
  prevStored: StoredDraft | undefined,
  fresh: DraftRef | undefined,
): { state: string; text: string; stored: StoredDraft | undefined } {
  const s = state.trim();
  if (isDraftStateLocked(s)) return { state, text, stored: prevStored };
  if (fresh) {
    const stored = toStoredDraft(fresh);
    return { state: s === '' ? DRAFT_STATE.pending : state, text: draftDisplayText(stored), stored };
  }
  if (s) return { state, text, stored: prevStored };
  return { state: prevStored ? DRAFT_STATE.pending : DRAFT_STATE.notNeeded, text, stored: prevStored };
}
