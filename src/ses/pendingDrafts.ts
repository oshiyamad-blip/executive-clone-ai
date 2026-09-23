// 担当者メール列による下書き作成（DB_PROVIDER=sheets の本番のみ）。
// バッチはマッチの「全員に返信」文面をスプレッドシートの下書きデータ列に用意しておき、営業が「担当者メール」に
// 自分の会社アドレスを入れた行について、次回バッチ（平日10:00/14:00）でそのアドレスを送信元とする下書きを作成する。
// 常駐の確認UIを置かずに定期実行だけで「本人のアドレスで下書き」を実現するための経路。自動送信はしない。
// 結果は状態列にだけ書き戻す（作成済 日時 / エラー: 理由）。担当者メール・文面はログに出さない。
import { isDemo, dbProvider, allowedSenderDomains } from './config.js';
import { materializeReplyDraft } from './draft.js';
import { replyDraftReady } from './mail/index.js';
import { recordHealEvent } from './heal/events.js';
import { safeErr, errKind, SafeLogError } from './redact.js';
import { isPlainEmailAddress } from './settingsFormat.js';
import {
  sheetsDbConfigured,
  draftRequestTabs,
  listDraftRequestRowsSheets,
  reloadDraftRequestRowSheets,
  writeDraftStatesSheets,
  type DraftRequestRow,
} from '../database/sheets.js';
import {
  DRAFT_STATE,
  isDraftStateActionable,
  parseDraftData,
  storedToDraftRef,
  type DraftSide,
  type StoredDraftData,
} from '../database/mapping.js';

export interface PendingDraftResult {
  created: number;
  failed: number;
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

// 許可ドメインは完全一致（サブドメインは別途列挙が必要）。未設定なら制限しない
export function senderDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
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

// 依頼の検証結果。作成に進む側と、作成せずエラーを書く側に分ける
export function planDraftRequest(
  row: DraftRequestRow,
  allowed: string[],
): { sender: string; data: StoredDraftData; create: DraftSide[]; errors: SideStates } {
  const sender = normalizeSenderEmail(row.senderEmail);
  const data = parseDraftData(row.draftData);
  const invalid = !isValidSenderEmail(sender)
    ? '担当者メールの形式が正しくありません（ご自身の会社アドレスを1件だけ入力してください）'
    : !senderDomainAllowed(sender, allowed)
      ? '送信元ドメインが許可されていません'
      : '';
  const create: DraftSide[] = [];
  const errors: SideStates = {};
  for (const side of pendingSides(row)) {
    if (invalid) errors[side] = errorState(invalid);
    else if (!data[side]) errors[side] = errorState('下書きの文面データがありません');
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

async function processRequest(listed: DraftRequestRow, allowed: string[]): Promise<PendingDraftResult> {
  const out: PendingDraftResult = { created: 0, failed: 0 };
  const label = `${listed.tab} ${listed.id}`;
  let row: DraftRequestRow | null;
  try {
    row = await reloadDraftRequestRowSheets(listed.tab, listed.id);
  } catch (err) {
    console.error(`SES下書き依頼: 行の再読込に失敗 (${label}): ${safeErr(err)}`);
    out.failed += pendingSides(listed).length;
    return out;
  }
  if (!row || !row.senderEmail.trim()) return out; // 行の削除・担当者メールの取り消し

  const { sender, data, create, errors } = planDraftRequest(row, allowed);
  out.failed += Object.keys(errors).length;
  if (create.length === 0 && Object.keys(errors).length === 0) return out;

  // 作成前に「作成中」を書いておく。作成後の書き戻しに失敗しても次回に同じ下書きを二重作成しないため
  const before: SideStates = { ...errors };
  for (const side of create) before[side] = DRAFT_STATE.inProgress;
  try {
    if (!(await writeDraftStatesSheets(row.tab, row.id, changedStates(row, before)))) return out;
  } catch (err) {
    console.error(`SES下書き依頼: 状態を書き込めないため作成を見送ります (${label}): ${safeErr(err)}`);
    out.failed += create.length;
    return out;
  }
  if (create.length === 0) return out;

  const after: SideStates = {};
  for (const side of create) {
    try {
      await materializeReplyDraft(storedToDraftRef(data[side]!), sender);
      after[side] = `${DRAFT_STATE.created} ${jstStamp()}`;
      out.created += 1;
    } catch (err) {
      console.error(`SES下書き依頼: 下書き作成に失敗 (${label} ${SIDE_LABEL[side]}): ${safeErr(err)}`);
      after[side] = errorState(failureReason(err));
      out.failed += 1;
    }
  }
  try {
    if (!(await writeDraftStatesSheets(row.tab, row.id, after))) {
      console.error(`SES下書き依頼: 行が見つからず結果を書き戻せません（「作成中」のまま） (${label})`);
    }
  } catch (err) {
    console.error(`SES下書き依頼: 結果を書き戻せません（「作成中」のまま。二重作成を避けるため自動では再作成しません） (${label}): ${safeErr(err)}`);
    recordHealEvent('warn', `下書きは作成しましたが状態列を更新できませんでした（${label}）。状態が「作成中」の行を確認してください`);
  }
  return out;
}

// スプレッドシートで担当者メールが入った行のうち、状態が 空欄・未作成・エラー の側の下書きを作成する。
// tabs は DRAFT_REQUEST_COLUMNS を持つタブ（既定はマッチ等の全登録タブ）
export async function materializePendingDrafts(tabs: string[] = draftRequestTabs()): Promise<PendingDraftResult> {
  const result: PendingDraftResult = { created: 0, failed: 0 };
  if (!draftRequestsEnabled()) {
    console.log('SES下書き依頼: 担当者メールによる下書き作成は DB_PROVIDER=sheets の本番実行でのみ行います（スキップ）');
    return result;
  }
  if (!sheetsDbConfigured()) return result;
  if (!replyDraftReady()) {
    console.warn('SES下書き依頼: メールの下書き作成設定が未完了のためスキップします（依頼は設定後のバッチで処理されます）');
    return result;
  }
  const allowed = allowedSenderDomains();
  if (allowed.length === 0) {
    console.warn('SES下書き依頼: SES_ALLOWED_SENDER_DOMAINS が未設定のため送信元ドメインを制限していません');
  }

  for (const tab of tabs) {
    let requests: DraftRequestRow[];
    try {
      requests = (await listDraftRequestRowsSheets(tab)).filter((r) => pendingSides(r).length > 0);
    } catch (err) {
      console.error(`SES下書き依頼: 「${tab}」タブの読み込みに失敗: ${safeErr(err)}`);
      recordHealEvent('warn', `「${tab}」タブの下書き依頼を読み込めませんでした（次回バッチで再試行します）`);
      continue;
    }
    for (const request of requests) {
      const r = await processRequest(request, allowed);
      result.created += r.created;
      result.failed += r.failed;
    }
  }

  console.log(`SES下書き依頼: 作成${result.created}件 / 失敗${result.failed}件`);
  if (result.failed > 0) {
    recordHealEvent(
      'warn',
      `担当者指定の下書き作成に${result.failed}件失敗しました（スプレッドシートの下書き状態列の「エラー」を確認してください）`,
    );
  }
  return result;
}
