// SESデータのラベル・シリアライズ変換（DBプロバイダ共通）。
// Notion（index.ts）と Google Sheets（sheets.ts）の両バックエンドが同じ表記で保存・復元するための
// 単一の変換層。ここを変えると既存データの読み戻しに影響するため、値の変更は慎重に。
import { createHmac, timingSafeEqual } from 'crypto';
import type { RemoteOption, MatchStatus, ReplyTarget, FeedbackVerdict, DraftRef, JudgeVerdict } from '../types/index.js';

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

// AI最終判定の結果（マッチタブの「判定」列）。「未判定」の行は判定済みに数えず、次回の実行で判定し直す
export const JUDGE_VERDICT_LABEL: Record<JudgeVerdict, string> = {
  passed: '通過',
  low: '低評価',
  rejected: '不適合',
  deferred: '未判定',
  failed: '判定失敗',
  rule: 'ルールのみ',
};

export function judgeVerdictLabel(verdict: JudgeVerdict | undefined): string {
  return verdict ? JUDGE_VERDICT_LABEL[verdict] : '';
}

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
// binding（署名鍵つき）を渡すと、行のタブ・ID・営業元メールと合わせて署名する（下書きの宛先はこの列と営業元メールから
// 作り直されるため。シート上で宛先を書き換えた行・別の行から写した返信メタを宛先に使わないように）
export interface ReplyMetaBinding {
  key: string; // SES_DRAFT_SIGNING_KEY（空なら署名しない）
  tab: string;
  id: string;
  agentEmail: string;
}

const REPLY_META_FIELDS = ['from', 'replyTo', 'to', 'cc', 'subject', 'messageId', 'references'] as const;

function replyMetaSignature(rt: ReplyTarget | undefined, b: ReplyMetaBinding): string {
  const fields = rt ? REPLY_META_FIELDS.map((f) => rt[f] ?? '') : null;
  const canonical = JSON.stringify([b.tab, b.id.trim(), b.agentEmail.trim(), fields]);
  return createHmac('sha256', b.key).update(canonical).digest('base64url');
}

export function replyMetaJson(rt: ReplyTarget | undefined, binding?: ReplyMetaBinding): string {
  if (!binding?.key) return rt ? JSON.stringify(rt) : '';
  return JSON.stringify({ ...(rt ?? {}), sig: replyMetaSignature(rt, binding) });
}

function parseReplyMetaObject(json: string): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseReplyMeta(json: string): ReplyTarget | undefined {
  const o = parseReplyMetaObject(json);
  if (!o || typeof o.from !== 'string' || !o.from) return undefined;
  const { sig: _sig, ...rest } = o;
  return rest as unknown as ReplyTarget;
}

// 返信メタ（と営業元メール）がこの行のものとして署名どおりか。鍵が無ければ検証しない（true）
export function verifyReplyMeta(json: string, binding: ReplyMetaBinding): boolean {
  if (!binding.key) return true;
  const o = parseReplyMetaObject(json);
  const sig = o && typeof o.sig === 'string' ? o.sig : '';
  if (!sig) return false;
  const expected = Buffer.from(replyMetaSignature(parseReplyMeta(json), binding));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// スキル等の1要素から区切り文字（カンマ・全角カンマ・読点）を除く。'Java(Spring, MyBatis)' のような値が
// Sheetsの読み戻しで2要素に割れたり、Notionの multi_select（カンマ不可）で保存全体が失敗したりしないように、
// 区切り文字は '/' に置き換える（抽出直後と保存時の両方で通し、経路によって値が変わらないようにする）
export function sanitizeListItem(item: string): string {
  return item
    .replace(/\s*[,，、]\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// スキル等の配列⇄テキスト（カンマ区切り）変換。Sheetsのセルや人手編集と相互運用するため
// 全角読点・カンマの両方を受け付ける。
export function joinList(items: string[]): string {
  return items.map(sanitizeListItem).filter(Boolean).join(', ');
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
// genFailed は成立候補・交渉提案なのに文面を用意できなかった行（依頼を受けず、バッチが判定からやり直して文面を作り直す）
export const DRAFT_STATE = {
  pending: '未作成',
  notNeeded: '不要',
  inProgress: '作成中',
  created: '作成済',
  sent: '送信済',
  error: 'エラー',
  genFailed: 'エラー: 文面を用意できませんでした（次回のバッチで作り直します）',
  // 宛先（元メールの差出人・営業元メール）が分からない、または署名の合わない返信メタから作った側。依頼を受けない
  noRecipient: '不要（宛先が不明なため作成できません）',
  // 稼働可でなくなった社員のプロパー候補（再び稼働可になって候補に戻れば「未作成」に戻す）
  retired: '不要（稼働可の社員ではなくなりました）',
  // AI判定を次回に回した組（判定の結果、下書きを作る区分になれば「未作成」、ならなければ「不要」に変わる）
  awaitingJudge: '判定待ち（次回のバッチでAI判定します）',
} as const;

// 作成済・送信済・作成中は機械が上書きしない（文面・下書きデータも固定する）
export function isDraftStateLocked(state: string): boolean {
  const s = state.trim();
  return s.startsWith(DRAFT_STATE.created) || s.startsWith(DRAFT_STATE.sent) || s.startsWith(DRAFT_STATE.inProgress);
}

// 文面の作り直し待ち（バッチが判定し直す）の状態か
export function isDraftRegenerationPending(state: string): boolean {
  return state.trim().startsWith(DRAFT_STATE.genFailed);
}

// 担当者メールが入っていれば下書きを作成しに行く状態か
export function isDraftStateActionable(state: string): boolean {
  const s = state.trim();
  if (isDraftRegenerationPending(s)) return false;
  return s === '' || s === DRAFT_STATE.pending || s.startsWith(DRAFT_STATE.error);
}

// 下書きデータ列に保存する片側分。draftId/url は下書き作成時に、from は担当者メールで、draftKey は行の位置から決まるため持たない
export type StoredDraft = Omit<DraftRef, 'draftId' | 'url' | 'from' | 'draftKey'>;

export interface StoredDraftData {
  project?: StoredDraft;
  engineer?: StoredDraft;
}

export type DraftSide = keyof StoredDraftData;

export function toStoredDraft(ref: DraftRef): StoredDraft {
  const { draftId: _id, url: _url, from: _from, draftKey: _key, ...rest } = ref;
  return rest;
}

export function storedToDraftRef(stored: StoredDraft): DraftRef {
  return { ...stored, draftId: '', url: '' };
}

const OPTIONAL_TEXT_FIELDS = ['cc', 'body', 'inReplyTo', 'references', 'addressNote'] as const;

// 下書きデータ列は人も編集できるセルのため、決まった項目の文字列だけを取り出して新しいオブジェクトを作る。
// 文字列以外（{path:…} {href:…} 等。MIMEの組み立てでファイル・URLの読み込みに化ける）が入っていれば、その側ごと捨てる
function cleanStoredDraft(v: unknown): StoredDraft | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.to !== 'string' || o.to === '' || typeof o.subject !== 'string') return undefined;
  const out: StoredDraft = { to: o.to, subject: o.subject };
  for (const f of OPTIONAL_TEXT_FIELDS) {
    const value = o[f];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return undefined;
    out[f] = value;
  }
  return out;
}

function parseDraftJson(json: string): Record<string, unknown> | null {
  if (!json.trim()) return null;
  try {
    const o = JSON.parse(json) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 人が壊した・空のセルでも例外にせず、読めた側だけ返す
export function parseDraftData(json: string): StoredDraftData {
  const o = parseDraftJson(json);
  if (!o) return {};
  const out: StoredDraftData = {};
  const project = cleanStoredDraft(o.project);
  const engineer = cleanStoredDraft(o.engineer);
  if (project) out.project = project;
  if (engineer) out.engineer = engineer;
  return out;
}

// 署名の対象（項目の順序を固定した正規形）。bind（タブ・ID）を含めると、署名つきの下書きデータを別の行へ写しても通らない
function canonicalDraftData(data: StoredDraftData, bind: string[]): string {
  const side = (d: StoredDraft | undefined) =>
    d ? [d.to, d.subject, ...OPTIONAL_TEXT_FIELDS.map((f) => d[f] ?? null)] : null;
  const body = [side(data.project), side(data.engineer)];
  return JSON.stringify(bind.length > 0 ? [bind, ...body] : body);
}

function draftSignature(data: StoredDraftData, key: string, bind: string[]): string {
  return createHmac('sha256', key).update(canonicalDraftData(data, bind)).digest('base64url');
}

// 下書きデータ列の署名を確かめる。鍵が無ければ検証しない（true）。鍵があるのに署名が無い・合わない（人が書き換えた・
// 別の行から写した）なら false。bind は署名したときと同じ行の識別（タブ・ID）
export function verifyDraftData(json: string, key: string, bind: string[] = []): boolean {
  if (!key) return true;
  const o = parseDraftJson(json);
  if (!o) return !json.trim();
  const sig = typeof o.sig === 'string' ? o.sig : '';
  const expected = draftSignature(parseDraftData(json), key, bind);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 署名は読み戻したときと同じ正規形（parseDraftData が捨てる側＝宛先の無い側などを除いたもの）に付ける。
// 片側の宛先が空でも、もう片側の署名が合わなくなって両側とも作れなくなることがないように
function serializeDraftData(data: StoredDraftData, key: string, bind: string[]): string {
  const clean = parseDraftData(JSON.stringify(data));
  if (!clean.project && !clean.engineer) return '';
  return JSON.stringify(key ? { ...clean, sig: draftSignature(clean, key, bind) } : clean);
}

// 文面列（人が読む用）。宛先・件名を本文の前に付ける
export function draftDisplayText(d: StoredDraft): string {
  const header = [`To: ${d.to}`, d.cc ? `Cc: ${d.cc}` : '', `Subject: ${d.subject}`, d.addressNote ? `※ ${d.addressNote}` : '']
    .filter(Boolean)
    .join('\n');
  return `${header}\n\n${d.body ?? ''}`;
}

export interface DraftColumns {
  projectState: string;
  engineerState: string;
  projectText: string;
  engineerText: string;
  data: string; // StoredDraftData のJSON（空なら ''）
}

export interface DraftMergeOptions {
  // 下書きを作るべき区分なのに文面を用意できなかった（空欄の状態を「文面を用意できませんでした」にする）
  failed?: boolean;
  // AI判定を次回に回した組（空欄の状態を「判定待ち」にする。人が付けたものと区別できない「不要」にしない）
  deferred?: boolean;
  // 下書きデータ列の署名鍵（SES_DRAFT_SIGNING_KEY）。空なら署名しない
  signingKey?: string;
  // 署名に含める行の識別（タブ・ID）
  bind?: string[];
}

// 再実行で同じマッチを保存し直すときの下書き列の決め方。状態列は人も編集するため空欄を埋める以外は
// 変えない（人が付けた「不要」を戻さない）。作成済等になった側は文面・下書きデータも固定し、
// 依頼前の側だけ最新の生成物に差し替える。署名の合わない既存の下書きデータ（人が書き換えたもの）は引き継がない
export function mergeDraftColumns(
  existing: DraftColumns | null,
  project: DraftRef | undefined,
  engineer: DraftRef | undefined,
  opts: DraftMergeOptions = {},
): DraftColumns {
  const key = opts.signingKey ?? '';
  const bind = opts.bind ?? [];
  const prevJson = existing?.data ?? '';
  const prev = verifyDraftData(prevJson, key, bind) ? parseDraftData(prevJson) : {};
  const flags = { failed: Boolean(opts.failed), deferred: Boolean(opts.deferred) };
  const p = mergeDraftSide(existing?.projectState ?? '', existing?.projectText ?? '', prev.project, project, flags);
  const e = mergeDraftSide(existing?.engineerState ?? '', existing?.engineerText ?? '', prev.engineer, engineer, flags);
  const data: StoredDraftData = {};
  if (p.stored) data.project = p.stored;
  if (e.stored) data.engineer = e.stored;
  return {
    projectState: p.state,
    engineerState: e.state,
    projectText: p.text,
    engineerText: e.text,
    data: serializeDraftData(data, key, bind),
  };
}

function mergeDraftSide(
  state: string,
  text: string,
  prevStored: StoredDraft | undefined,
  fresh: DraftRef | undefined,
  flags: { failed: boolean; deferred: boolean },
): { state: string; text: string; stored: StoredDraft | undefined } {
  const s = state.trim();
  if (isDraftStateLocked(s)) return { state, text, stored: prevStored };
  const awaiting = s === DRAFT_STATE.awaitingJudge;
  const machineState =
    s === '' || isDraftRegenerationPending(s) || s === DRAFT_STATE.noRecipient || s === DRAFT_STATE.retired || awaiting;
  if (fresh) {
    // 読み戻せない側（宛先が空等）は下書きデータに入れず、依頼を受けない状態にする（文面は人が読めるよう残す）
    const stored = cleanStoredDraft(toStoredDraft(fresh));
    const display = draftDisplayText(toStoredDraft(fresh));
    if (!stored) return { state: machineState ? DRAFT_STATE.noRecipient : state, text: display, stored: undefined };
    return { state: machineState ? DRAFT_STATE.pending : state, text: draftDisplayText(stored), stored };
  }
  if (flags.deferred && (s === '' || awaiting) && !prevStored) {
    return { state: DRAFT_STATE.awaitingJudge, text, stored: undefined };
  }
  // 作り直し待ちの側がAI判定の見送り（予算・一時的な失敗）になった: 作り直し待ちのまま残す（「不要」にすると判定し直しても作らない）
  if (flags.deferred && isDraftRegenerationPending(s)) return { state, text, stored: prevStored };
  if (flags.failed && (s === '' || awaiting || isDraftRegenerationPending(s)) && !prevStored) {
    return { state: DRAFT_STATE.genFailed, text, stored: undefined };
  }
  // 作り直し待ち・判定待ちだった側が、判定し直しで下書きを作らない区分（参考提案・要確認・不適合）になった
  if (isDraftRegenerationPending(s) || awaiting) {
    return { state: prevStored ? DRAFT_STATE.pending : DRAFT_STATE.notNeeded, text, stored: prevStored };
  }
  if (s) return { state, text, stored: prevStored };
  return { state: prevStored ? DRAFT_STATE.pending : DRAFT_STATE.notNeeded, text, stored: prevStored };
}
