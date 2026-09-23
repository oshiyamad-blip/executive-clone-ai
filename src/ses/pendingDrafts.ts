// 担当者メール列による下書き作成（DB_PROVIDER=sheets の本番のみ）。
// バッチはマッチの「全員に返信」文面をスプレッドシートの下書きデータ列に用意しておき、営業が「担当者メール」に
// 自分の会社アドレスを入れた行について、次回バッチ（平日10:00/14:00）でそのアドレスを送信元とする下書きを作成する。
// 常駐の確認UIを置かずに定期実行だけで「本人のアドレスで下書き」を実現するための経路。自動送信はしない。
// 結果は状態列にだけ書き戻す（作成済 日時 / エラー: 理由）。担当者メール・文面はログに出さない。
// シートの編集者なら誰でも担当者メールを書けるため、送信元は許可したドメイン・アドレスに限る（未設定なら作らない）。
// 作成の前に「作成中 日時 #照合用の記号」を書いてから読み直し、自分の記号が残っているときだけ作る（同時に動いた別の実行と
// 二重に作らないため）。下書きには記号から作った識別子（X-SES-Draft-Key）を付け、応答が失われた作成を後から確かめる。
import { createHash, randomBytes } from 'crypto';
import {
  isDemo,
  dbProvider,
  allowedSenderDomains,
  allowedSenders,
  ownDomains,
  mailProvider,
  xserverSharedUser,
  sesTargetGmail,
  draftSigningKey,
} from './config.js';
import { materializeReplyDraft, hasNonInitialsEngineerLabel } from './draft.js';
import { replyDraftReady, replyDraftExistsViaMail } from './mail/index.js';
import { recordHealEvent } from './heal/events.js';
import { safeErr, errKind, SafeLogError } from './redact.js';
import { isPlainEmailAddress } from './settingsFormat.js';
import {
  sheetsDbConfigured,
  draftRequestTabs,
  draftBinding,
  listDraftRequestRowsSheets,
  reloadDraftRequestRowSheets,
  writeDraftStatesSheets,
  properEngineerIdOfCandidate,
  PROPER_CANDIDATE_TAB,
  type DraftRequestRow,
} from '../database/sheets.js';
import {
  DRAFT_STATE,
  isDraftStateActionable,
  parseDraftData,
  storedToDraftRef,
  verifyDraftData,
  type DraftSide,
  type StoredDraftData,
} from '../database/mapping.js';

export interface PendingDraftResult {
  created: number;
  failed: number;
  stale?: number; // 前回の実行から「作成中」のまま残っている側（作成できたか分からない）
}

type SideStates = Partial<Record<DraftSide, string>>;

const SIDES: DraftSide[] = ['project', 'engineer'];
const SIDE_LABEL: Record<DraftSide, string> = { project: '案件側', engineer: '要員側' };

// 担当者メールによる下書き依頼を扱う実行か（Notion運用・demoでは従来どおり確認UI経由のみ）
export function draftRequestsEnabled(): boolean {
  return dbProvider() === 'sheets' && !isDemo();
}

// 全角の＠・英数字（日本語入力のまま打った場合）を半角に寄せ、前後の空白を除き、ドメイン部を小文字にする
export function normalizeSenderEmail(raw: string): string {
  const s = raw.normalize('NFKC').trim();
  const at = s.lastIndexOf('@');
  return at < 0 ? s : `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

export function isValidSenderEmail(email: string): boolean {
  return isPlainEmailAddress(email);
}

// 許可ドメインは完全一致（サブドメインは別途列挙が必要）。一覧が空なら許可しない
export function senderDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
}

// 送信元にしてよいアドレスの条件
export interface SenderPolicy {
  domains: string[]; // 許可ドメイン（SES_ALLOWED_SENDER_DOMAINS。未設定なら自社ドメインと共有メールボックスのドメイン）
  addresses: string[]; // 許可アドレス（SES_ALLOWED_SENDERS）。設定されていればこのアドレスだけ
  requireAddress: boolean; // アドレスの一覧が必須か（Gmailは本人のメールボックスへのなりすましになるため）
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

export function currentSenderPolicy(): SenderPolicy {
  const explicit = allowedSenderDomains();
  const fallback = [...ownDomains(), domainOf(xserverSharedUser()), domainOf(sesTargetGmail())].filter(Boolean);
  return {
    domains: [...new Set(explicit.length > 0 ? explicit : fallback)],
    addresses: allowedSenders(),
    requireAddress: mailProvider() === 'gmail',
  };
}

// 送信元にできないなら理由（固定文言）、できるなら ''
export function senderRejection(email: string, policy: SenderPolicy): string {
  if (isDemo()) return ''; // demoはローカルにファイルを書くだけ
  const address = email.toLowerCase();
  if (policy.addresses.length > 0) return policy.addresses.includes(address) ? '' : '送信元アドレスが許可されていません';
  if (policy.requireAddress) return 'Gmail運用では送信元にできるアドレスを SES_ALLOWED_SENDERS に登録してください';
  if (policy.domains.length === 0) return '送信元に使えるドメインが設定されていません（SES_ALLOWED_SENDER_DOMAINS）';
  return senderDomainAllowed(address, policy.domains) ? '' : '送信元ドメインが許可されていません';
}

// 状態列に書く日時。実行環境のタイムゾーンに依らずJSTで表記する
export function jstStamp(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function errorState(reason: string): string {
  return `${DRAFT_STATE.error}: ${reason}`.slice(0, 120);
}

// シートは社内限定だが、API応答が宛先・本文を反響し得るため固定文言か種別・コードだけを書く
function failureReason(err: unknown): string {
  if (err instanceof SafeLogError) return err.message;
  return `下書きの作成に失敗しました（${errKind(err)}）`;
}

function stateOf(row: DraftRequestRow, side: DraftSide): string {
  return side === 'project' ? row.projectState : row.engineerState;
}

export function pendingSides(row: DraftRequestRow): DraftSide[] {
  return SIDES.filter((side) => isDraftStateActionable(stateOf(row, side)));
}

function inProgressSides(row: DraftRequestRow): DraftSide[] {
  return SIDES.filter((side) => stateOf(row, side).trim().startsWith(DRAFT_STATE.inProgress));
}

// 下書きの識別子（下書きの X-SES-Draft-Key ヘッダ）。タブ・ID・側と、作成の試み1回ごとの照合用の記号（nonce）から決まり、
// 中身を推測できない値にする。記号が違えば別の試み（前に別の担当者で作った下書き等）とみなす。
// 記号の無い識別子は以前の版の「作成中」の行を確かめるためだけに使う
export function draftKeyOf(tab: string, id: string, side: DraftSide, nonce = ''): string {
  const parts = [tab, id, side, ...(nonce ? [nonce] : [])];
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 24);
}

// 状態列に添える照合用の記号（「作成中 日時 #記号」「エラー: 理由 #記号」）
function newNonce(): string {
  return randomBytes(6).toString('base64url');
}

export function nonceOf(state: string): string {
  return state.trim().match(/ #([A-Za-z0-9_-]{6,})$/)?.[1] ?? '';
}

function inProgressState(nonce: string): string {
  return `${DRAFT_STATE.inProgress} ${jstStamp()} #${nonce}`;
}

// 作成を試みて失敗した側のエラー（作成自体は済んで応答だけ失われた可能性があるため、記号を残して次回に確かめる）
function attemptErrorState(reason: string, nonce: string): string {
  return `${errorState(reason).slice(0, 110)} #${nonce}`;
}

// 依頼の検証結果。作成に進む側と、作成せずエラーを書く側に分ける
export function planDraftRequest(
  row: DraftRequestRow,
  policy: SenderPolicy,
  signingKey = '',
  activeProperEngineers: Set<string> | null = null,
): { sender: string; data: StoredDraftData; create: DraftSide[]; errors: SideStates } {
  const sender = normalizeSenderEmail(row.senderEmail);
  const data = parseDraftData(row.draftData);
  const invalid = !isValidSenderEmail(sender)
    ? '担当者メールの形式が正しくありません（ご自身の会社アドレスを1件だけ入力してください）'
    : senderRejection(sender, policy);
  const tampered = !verifyDraftData(row.draftData, signingKey, draftBinding(row.tab, row.id));
  // プロパー候補は、今も稼働可の社員のものだけ作る（管理表で対象外・アサイン済にした社員を社外に紹介しない）
  const retired = row.tab === PROPER_CANDIDATE_TAB && !activeProperEngineers?.has(properEngineerIdOfCandidate(row.id));
  const create: DraftSide[] = [];
  const errors: SideStates = {};
  for (const side of pendingSides(row)) {
    if (invalid) errors[side] = errorState(invalid);
    else if (retired) {
      errors[side] = errorState(
        activeProperEngineers ? 'この社員は稼働可ではないため作成しません（プロパー管理表の稼働状況）' : 'プロパー管理表を確認できないため作成しません（次回のバッチで再試行します）',
      );
    } else if (tampered) errors[side] = errorState('下書きデータが書き換えられているため作成しません');
    else if (!data[side]) errors[side] = errorState('下書きの文面データがありません');
    // 表示名をイニシャルにする前の版で保存した文面に氏名が残っていれば作らず、次回のバッチで文面を作り直す
    else if (row.tab !== PROPER_CANDIDATE_TAB && hasNonInitialsEngineerLabel(data[side]!)) errors[side] = DRAFT_STATE.genFailed;
    else create.push(side);
  }
  return { sender, data, create, errors };
}

// 前回と同じ値の状態は書き直さない（直らないエラーを毎回書き込んでAPIクォータを使わないため）
function changedStates(row: DraftRequestRow, states: SideStates): SideStates {
  const out: SideStates = {};
  for (const side of SIDES) {
    const v = states[side];
    if (v !== undefined && v !== stateOf(row, side)) out[side] = v;
  }
  return out;
}

// 下書きフォルダに同じ識別子の下書きがあるか（確かめられないプロバイダ・失敗時は null）
async function draftAlreadyExists(key: string): Promise<boolean | null> {
  try {
    return await replyDraftExistsViaMail(key);
  } catch (err) {
    console.warn(`SES下書き依頼: 既存の下書きの確認に失敗: ${safeErr(err)}`);
    return null;
  }
}

// ログ用の行の表記。プロパー候補のIDはDriveのファイルID（＝ファイルのURL）を含むため短いハッシュにする
function rowLabel(tab: string, id: string): string {
  return id.includes('proper_') ? `${tab} #${createHash('sha256').update(id).digest('hex').slice(0, 8)}` : `${tab} ${id}`;
}

// プロパー候補の依頼を受けてよい社員（稼働可）の一覧。必要になったときに1回だけ読む（読めなければ null）
export type ProperActiveLoader = () => Promise<Set<string> | null>;

async function processRequest(
  listed: DraftRequestRow,
  policy: SenderPolicy,
  properActive: () => Promise<Set<string> | null>,
): Promise<PendingDraftResult> {
  const out: PendingDraftResult = { created: 0, failed: 0 };
  const label = rowLabel(listed.tab, listed.id);
  let row: DraftRequestRow | null;
  try {
    row = await reloadDraftRequestRowSheets(listed);
  } catch (err) {
    console.error(`SES下書き依頼: 行の再読込に失敗 (${label}): ${safeErr(err)}`);
    out.failed += pendingSides(listed).length;
    return out;
  }
  if (!row || !row.senderEmail.trim()) return out; // 行の削除・担当者メールの取り消し

  const active = row.tab === PROPER_CANDIDATE_TAB ? await properActive() : null;
  const { sender, data, create, errors } = planDraftRequest(row, policy, draftSigningKey(), active);
  out.failed += Object.keys(errors).length;
  if (create.length === 0 && Object.keys(errors).length === 0) return out;

  // 作成前に「作成中 日時 #記号」を書いておく。作成後の書き戻しに失敗しても次回に同じ下書きを二重作成しないため。
  // 読み直した行の状態が変わっていれば（別の実行・人が先に進めた）書かずにやめる
  const before: SideStates = { ...errors };
  const nonces: Partial<Record<DraftSide, string>> = {};
  for (const side of create) {
    nonces[side] = newNonce();
    before[side] = inProgressState(nonces[side]!);
  }
  try {
    const changed = changedStates(row, before);
    if (Object.keys(changed).length > 0 && !(await writeDraftStatesSheets(row, changed, row))) return out;
  } catch (err) {
    console.error(`SES下書き依頼: 状態を書き込めないため作成を見送ります (${label}): ${safeErr(err)}`);
    out.failed += create.length;
    return out;
  }
  if (create.length === 0) return out;

  // 書いた「作成中」が残っている側だけを作る（ほぼ同時に同じ行を処理した別の実行がいれば、後から書いた方だけが作る）
  let confirmed: DraftRequestRow | null;
  try {
    confirmed = await reloadDraftRequestRowSheets(row);
  } catch (err) {
    console.error(`SES下書き依頼: 「作成中」の確認に失敗したため作成を見送ります (${label}): ${safeErr(err)}`);
    return out;
  }
  const mine = create.filter((side) => confirmed !== null && stateOf(confirmed, side) === before[side]);
  if (mine.length < create.length) {
    console.warn(`SES下書き依頼: 別の実行が同じ依頼を処理しているため作成を見送りました (${label})`);
  }

  const after: SideStates = {};
  for (const side of mine) {
    const nonce = nonces[side]!;
    const prevNonce = nonceOf(stateOf(row, side));
    // 前回の作成の試みが「エラー」になった側は、作成自体は済んでいて応答だけ失敗した可能性があるため、
    // その試みの識別子の下書きが下書きフォルダに無いかを先に確かめる（入力の誤り等で作成を試みていないエラーは確かめない）
    if (prevNonce && stateOf(row, side).trim().startsWith(DRAFT_STATE.error) && (await draftAlreadyExists(draftKeyOf(row.tab, row.id, side, prevNonce))) === true) {
      after[side] = `${DRAFT_STATE.created} ${jstStamp()}`;
      out.created += 1;
      continue;
    }
    try {
      await materializeReplyDraft({ ...storedToDraftRef(data[side]!), draftKey: draftKeyOf(row.tab, row.id, side, nonce) }, sender);
      after[side] = `${DRAFT_STATE.created} ${jstStamp()}`;
      out.created += 1;
    } catch (err) {
      console.error(`SES下書き依頼: 下書き作成に失敗 (${label} ${SIDE_LABEL[side]}): ${safeErr(err)}`);
      after[side] = attemptErrorState(failureReason(err), nonce);
      out.failed += 1;
    }
  }
  if (Object.keys(after).length === 0) return out;
  try {
    if (!(await writeDraftStatesSheets(row, after))) {
      console.error(`SES下書き依頼: 行が見つからず結果を書き戻せません（「作成中」のまま） (${label})`);
    }
  } catch (err) {
    console.error(`SES下書き依頼: 結果を書き戻せません（「作成中」のまま。二重作成を避けるため自動では再作成しません） (${label}): ${safeErr(err)}`);
    recordHealEvent('warn', `下書きは作成しましたが状態列を更新できませんでした（${label}）。状態が「作成中」の行を確認してください`);
  }
  return out;
}

// 前回の実行から「作成中」のまま残っている側（実行の中断・書き戻しの失敗）。下書きフォルダで作成を確かめられた側は
// 「作成済」にし、確かめられない側の数を返す（人が下書きフォルダを見て状態を直す）
async function resolveInProgress(listed: DraftRequestRow): Promise<number> {
  const sides = inProgressSides(listed);
  if (sides.length === 0) return 0;
  const found: SideStates = {};
  for (const side of sides) {
    const key = draftKeyOf(listed.tab, listed.id, side, nonceOf(stateOf(listed, side)));
    if ((await draftAlreadyExists(key)) === true) {
      found[side] = `${DRAFT_STATE.created} ${jstStamp()}（作成を確認）`;
    }
  }
  if (Object.keys(found).length > 0) {
    try {
      await writeDraftStatesSheets(listed, found, listed);
    } catch (err) {
      console.error(`SES下書き依頼: 「作成中」の行を更新できません (${rowLabel(listed.tab, listed.id)}): ${safeErr(err)}`);
      return sides.length;
    }
  }
  return sides.length - Object.keys(found).length;
}

// スプレッドシートで担当者メールが入った行のうち、状態が 空欄・未作成・エラー の側の下書きを作成する。
// tabs は DRAFT_REQUEST_COLUMNS を持つタブ（既定はマッチ等の全登録タブ）
// properActive はプロパー候補の依頼があったときだけ呼ぶ（稼働可の社員IDの一覧。確かめられなければ null）
export async function materializePendingDrafts(
  tabs: string[] = draftRequestTabs(),
  properActive: ProperActiveLoader = async () => null,
): Promise<PendingDraftResult> {
  const result: PendingDraftResult = { created: 0, failed: 0, stale: 0 };
  if (!draftRequestsEnabled()) {
    console.log('SES下書き依頼: 担当者メールによる下書き作成は DB_PROVIDER=sheets の本番実行でのみ行います（スキップ）');
    return result;
  }
  if (!sheetsDbConfigured()) return result;
  if (!replyDraftReady()) {
    console.warn('SES下書き依頼: メールの下書き作成設定が未完了のためスキップします（依頼は設定後のバッチで処理されます）');
    return result;
  }
  const policy = currentSenderPolicy();
  if (policy.addresses.length === 0 && (policy.requireAddress || policy.domains.length === 0)) {
    console.warn(
      'SES下書き依頼: 送信元に使えるアドレス・ドメインが設定されていないため、依頼にはエラーを返します（SES_ALLOWED_SENDER_DOMAINS / SES_ALLOWED_SENDERS）',
    );
  }

  let activeProper: Promise<Set<string> | null> | null = null;
  const loadActive = (): Promise<Set<string> | null> => {
    activeProper ??= properActive().catch((err) => {
      console.error(`SES下書き依頼: プロパー管理表を読めません: ${safeErr(err)}`);
      return null;
    });
    return activeProper;
  };
  let stale = 0;
  for (const tab of tabs) {
    let rows: DraftRequestRow[];
    try {
      rows = await listDraftRequestRowsSheets(tab);
    } catch (err) {
      console.error(`SES下書き依頼: 「${tab}」タブの読み込みに失敗: ${safeErr(err)}`);
      recordHealEvent('warn', `「${tab}」タブの下書き依頼を読み込めませんでした（次回バッチで再試行します）`);
      continue;
    }
    for (const row of rows) stale += await resolveInProgress(row);
    for (const request of rows.filter((r) => pendingSides(r).length > 0)) {
      const r = await processRequest(request, policy, loadActive);
      result.created += r.created;
      result.failed += r.failed;
    }
  }
  result.stale = stale;

  console.log(`SES下書き依頼: 作成${result.created}件 / 失敗${result.failed}件${stale > 0 ? ` / 作成中のまま${stale}件` : ''}`);
  if (result.failed > 0) {
    recordHealEvent(
      'warn',
      `担当者指定の下書き作成に${result.failed}件失敗しました（スプレッドシートの下書き状態列の「エラー」を確認してください）`,
    );
  }
  if (stale > 0) {
    recordHealEvent(
      'warn',
      `下書き状態が「作成中」のまま残っている依頼が${stale}件あります（前回の実行が途中で止まった可能性があります。` +
        '下書きフォルダを確認し、下書きがあれば「作成済」、無ければ空欄に戻してください）',
    );
  }
  return result;
}
