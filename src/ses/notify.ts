// マッチ結果DB更新 + サマリ生成。demo=ローカルJSON+コンソール、本番=DB保存+サマリメール送信。
// Sheets運用の本番では、担当者メールによる下書き作成の結果と依頼方法もサマリに載せる。
// 0件でも実行結果を通知する（要件F6）。ログ秘匿モードではコンソールに件数1行だけを出す（詳細はメールのみ）。
//
// 基本設計I/F（persistAndNotify(matches): Promise<void>）に対し、実装ではマッチ結果DBのrelation
// （案件・要員）を張るため projects/engineers を追加引数にしている（draft.tsと同様の変更点）。
import { saveMatches } from '../database/index.js';
import { sheetsDbConfigured, readStateJson, writeStateJson, fetchMatchSummariesSheets, type MatchSummaryRow } from '../database/sheets.js';
import { sendPlainMailViaMail, sendMailReady } from './mail/index.js';
import { SUMMARY_SUBJECT } from './mail/ownMail.js';
import { isDemo, sesNotifyTo, notifyRecipients, logRedact, mailProvider, requireLive, dbProvider, draftSigningKey } from './config.js';
import { writeDemoArtifact } from './store.js';
import { writeReviewMatches } from './review.js';
import { buildDiagnosisReport, recordFatal } from './heal/events.js';
import { redactable, safeErr, logId } from './redact.js';
import { draftRequestsEnabled, type PendingDraftResult } from './pendingDrafts.js';
import { properSummaryLines, type ProperRunResult } from './proper/index.js';
import { primarySelectTally, DEAL_BREAKER_CODES, DEAL_BREAKER_LABEL } from './match.js';
import {
  INJECTION_REVIEW_REASON,
  OUTGOING_TEXT_REVIEW_REASON,
  INJECTION_CAUTION,
  OUTGOING_TEXT_CAUTION,
  linkOrContactLike,
  unsafeOutgoingText,
} from './injection.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { marketSummaryLines } from './marketRate.js';
import { collectBatchMetrics, recordBatchMetrics, formatMetricsLines, metricsRowValues } from './batchMetrics.js';
import type { MatchResult, Project, Engineer, DraftRef } from '../types/index.js';

export async function persistAndNotify(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
  requestedDrafts: PendingDraftResult = { created: 0, failed: 0 },
  proper: ProperRunResult | null = null,
): Promise<void> {
  const { saved } = await persistMatches(matches, projects, engineers);
  await notifyResults(saved, requestedDrafts, proper);
}

// サマリの送信結果。skipped = 宛先・送信設定が無い、または demo（知らせる先が無いため、知らせ損ねの記録は持ち越さない）
export type NotifyOutcome = 'sent' | 'skipped' | 'failed';

// 保存済みのマッチ（保存できなかったものは含めない）のサマリを作って通知する。
// carried は前回までの実行で保存したがサマリで知らせ損ねたマッチ（loadUnnotifiedMatches）
export async function notifyResults(
  saved: MatchResult[],
  requestedDrafts: PendingDraftResult = { created: 0, failed: 0 },
  proper: ProperRunResult | null = null,
  carried: MatchSummaryRow[] = [],
): Promise<NotifyOutcome> {
  // 確認UI(web.ts)用のレビュー成果を書き出す（demo/本番共通。UIはこれを読む）
  writeReviewMatches(saved);
  // バッチのメトリクス（件数・比率だけ）。しきい値の警告が診断レポートに載るよう、レポートを作る前に記録する
  const metrics = collectBatchMetrics({ requestedDrafts: requestedDrafts.created });
  await recordBatchMetrics(metrics);
  const metricsLines = formatMetricsLines(metrics);
  // プロパー候補の節は、メールには氏名・案件名つき、コンソールには件数だけを載せる
  const base = buildSummary(saved, requestedDrafts, carried);
  let summary = `${base}\n${[...properSummaryLines(proper, true), ...marketSummaryLines(true)].join('\n')}`;
  const consoleSummary = `${base}\n${[...properSummaryLines(proper, false), ...marketSummaryLines(false)].join('\n')}`;
  // 本番のみ、自動検証・修復の診断レポート（コスト概算・異常検知・隔離状況・メトリクス）をサマリ末尾に添える
  if (!isDemo()) {
    summary = `${summary}\n${await buildDiagnosisReport({ lines: metricsLines, values: metricsRowValues(metrics) })}`;
  }
  return notifySummary(summary, consoleSummary, countLine(saved, proper), metricsLines);
}

// ===== サマリで知らせ損ねたマッチの持ち越し（Sheets運用の本番のみ） =====
// マッチは判定のたびに保存するため、サマリを送れずに終わった回（送信の失敗・実行の打ち切り）のマッチは「判定済み」として
// 次の回の判定から外れ、誰にも知らされない。保存したマッチのIDを「_状態」タブに控え、サマリを送れたら消す。
// 控えが残っていれば、次の回のサマリに「前回までにお知らせできなかったマッチ」として載せる

const UNNOTIFIED_KEY = 'unnotifiedMatches';
// 1セルに収まる件数の上限（超えた分は件数だけを知らせる）
const UNNOTIFIED_MAX_IDS = 800;
const CARRIED_LIST_MAX = 30;

interface UnnotifiedState {
  ids: string[];
  overflow: number; // 上限を超えて控えられなかった件数
  sig?: string; // SES_DRAFT_SIGNING_KEY による署名（「_状態」タブは人も編集できるため、書き換えた控えをサマリに載せない）
}

function unnotifiedSignature(ids: string[], overflow: number, key: string): string {
  return createHmac('sha256', key).update(JSON.stringify(['unnotifiedMatches', ids, overflow])).digest('base64url');
}

// 控えに署名する（鍵が無ければ署名しない）
export function signUnnotified(state: { ids: string[]; overflow: number }, key: string): UnnotifiedState {
  return key ? { ...state, sig: unnotifiedSignature(state.ids, state.overflow, key) } : { ...state };
}

// 保存された控えを読む。鍵があるのに署名が無い・合わない控えは使わない（null）
export function verifiedUnnotified(raw: unknown, key: string): { ids: string[]; overflow: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Partial<UnnotifiedState>;
  if (!Array.isArray(o.ids) || !o.ids.every((id) => typeof id === 'string')) return null;
  const overflow = typeof o.overflow === 'number' && Number.isFinite(o.overflow) ? o.overflow : 0;
  if (key) {
    const expected = Buffer.from(unnotifiedSignature(o.ids, overflow, key));
    const actual = Buffer.from(typeof o.sig === 'string' ? o.sig : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  }
  return { ids: o.ids, overflow: Math.min(Math.max(Math.floor(overflow), 0), 1_000_000) };
}

function carryEnabled(): boolean {
  return !isDemo() && dbProvider() === 'sheets' && sheetsDbConfigured();
}

let carriedOverflow = 0;
// 直近に読んだ・書いた控えの内容（控えが空なら ''。同じ内容を書き直さないため）
let persisted = '';

function stateJson(state: UnnotifiedState): string {
  return state.ids.length === 0 && state.overflow === 0 ? '' : JSON.stringify(state);
}

// 前回までに知らせ損ねたマッチ（控えのID）。読めなければ空（知らせ損ねは次の回に持ち越す）
export async function loadUnnotifiedMatches(): Promise<{ ids: string[]; rows: MatchSummaryRow[] }> {
  carriedOverflow = 0;
  persisted = '';
  if (!carryEnabled()) return { ids: [], rows: [] };
  try {
    const raw = await readStateJson<unknown>(UNNOTIFIED_KEY);
    const state = verifiedUnnotified(raw, draftSigningKey());
    if (raw !== null && !state) {
      console.warn('SES通知: 知らせ損ねたマッチの控えの署名が合わないため使いません（「_状態」タブの unnotifiedMatches）');
    }
    const ids = state?.ids ?? [];
    carriedOverflow = state?.overflow ?? 0;
    persisted = stateJson({ ids, overflow: carriedOverflow });
    return { ids, rows: await fetchMatchSummariesSheets(ids) };
  } catch (err) {
    console.warn(`SES通知: 前回までに知らせ損ねたマッチの控えを読めません: ${safeErr(err)}`);
    return { ids: [], rows: [] };
  }
}

// 保存したがまだ知らせていないマッチのIDを控える（前回までの控え carriedIds を含めて書く。変わらなければ書かない）。
// 不適合（件数だけ知らせる）・未判定（次回判定してから知らせる）の組は控えない
export async function rememberUnnotified(carriedIds: string[], saved: MatchResult[]): Promise<void> {
  if (!carryEnabled()) return;
  const listed = saved.filter((m) => isListed(m)).map((m) => m.id);
  const all = [...new Set([...carriedIds, ...listed])];
  const state: UnnotifiedState = {
    ids: all.slice(0, UNNOTIFIED_MAX_IDS),
    overflow: carriedOverflow + Math.max(0, all.length - UNNOTIFIED_MAX_IDS),
  };
  const json = stateJson(state);
  if (json === persisted) return;
  await writeStateJson(UNNOTIFIED_KEY, signUnnotified(state, draftSigningKey()));
  persisted = json;
}

// サマリを送れた（または送る先が無い）ので控えを消す
export async function clearUnnotified(): Promise<void> {
  if (!carryEnabled() || persisted === '') return;
  await writeStateJson(UNNOTIFIED_KEY, signUnnotified({ ids: [], overflow: 0 }, draftSigningKey()));
  persisted = '';
}

// 持ち越しの行はこの回に作った値ではなく、人も編集できるマッチタブのセルから読むため、短く切り、リンク・連絡先・
// 指示らしき記載があれば中身を載せない（公式のサマリメールとしてフィッシングの文面を送らせない）
const CARRIED_REASON_CHARS = 200;
export const CARRIED_UNSAFE_TEXT = 'スプレッドシートで確認してください';

export function carriedText(s: string, max: number): string {
  const oneLine = (s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
  const capped = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return unsafeOutgoingText([capped]) || /[@＠]/.test(capped) ? CARRIED_UNSAFE_TEXT : capped;
}

function carriedSection(carried: MatchSummaryRow[], savedIds: Set<string>): string[] {
  const rows = carried.filter((r) => !savedIds.has(r.id));
  if (rows.length === 0 && carriedOverflow === 0) return [];
  const lines = [`【前回までの実行でお知らせできなかったマッチ（${rows.length + carriedOverflow}件）】`];
  for (const r of rows.slice(0, CARRIED_LIST_MAX)) {
    const margin = r.grossMarginJpy !== null ? `粗利${(r.grossMarginJpy / 10000).toFixed(1)}万円/月, ` : '';
    lines.push(`・${carriedText(r.title, SUMMARY_TITLE_CHARS)} — ${margin}適合スコア${r.score ?? '-'}点`);
    lines.push(`  根拠: ${carriedText(r.reason, CARRIED_REASON_CHARS)}`);
  }
  const more = rows.length - Math.min(rows.length, CARRIED_LIST_MAX) + carriedOverflow;
  if (more > 0) lines.push(`  ほか${more}件（スプレッドシート「マッチ」タブの検出日時で確認してください）`);
  lines.push('');
  return lines;
}

// マッチを保存する。保存できなかったものはサマリに載せず（マッチタブに無い行を案内しない）、異常終了として知らせる。
// 通常バッチでは保存できなかったペアの案件・要員に「突合済」を付けないため、次回の実行で判定し直される
export async function persistMatches(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
): Promise<{ saved: MatchResult[]; failed: number }> {
  if (isDemo()) {
    writeDemoArtifact('matches', matches);
    return { saved: matches, failed: 0 };
  }
  const projectPageIds = new Map(projects.map((p) => [p.id, p.notionPageId]));
  const engineerPageIds = new Map(engineers.map((e) => [e.id, e.notionPageId]));
  const result = await saveMatches(matches, (m) => ({
    projectNotionPageId: projectPageIds.get(m.projectId),
    engineerNotionPageId: engineerPageIds.get(m.engineerId),
  }));
  const saved: MatchResult[] = [];
  for (const match of matches) {
    const err = result.failed.get(match.id);
    if (err === undefined) {
      saved.push({ ...match, notionPageId: result.pageIds.get(match.id) });
      continue;
    }
    console.error(`SES通知: マッチ保存失敗 (${logId(match.id)} ${redactable(match.title)}): ${safeErr(err)}`);
  }
  const failed = matches.length - saved.length;
  if (failed > 0) {
    recordFatal(`マッチ${failed}件を保存できませんでした（次回の実行で判定し直します。スプレッドシートの共有・見出し・容量を確認してください）`);
  }
  return { saved, failed };
}

// サマリに1件ずつ載せる区分か（不適合・未判定は件数だけ）
function isListed(m: MatchResult): boolean {
  return m.category !== 'rejected' && m.category !== 'deferred';
}

// 区分ごとの件数（サマリ本文とログ秘匿モードのコンソール出力で共用。人名・案件名を含まない）
function countLine(matches: MatchResult[], proper: ProperRunResult | null = null): string {
  const count = (category: MatchResult['category']) => matches.filter((m) => m.category === category).length;
  const suppressed = primarySelectTally().suppressed;
  const extra = [
    count('rejected') > 0 ? ` / 不適合（AI判定）: ${count('rejected')}件` : '',
    count('deferred') > 0 ? ` / AI判定待ち: ${count('deferred')}件` : '',
    suppressed > 0 ? ` / 再提案抑制: ${suppressed}件` : '',
  ].join('');
  const properCount = proper ? ` / プロパー候補: ${proper.candidates.length}件` : '';
  return `成立候補: ${count('confirmed')}件 / 交渉提案: ${count('negotiable')}件 / 参考提案: ${count('tentative')}件 / 要確認: ${count('review')}件${extra}${properCount}`;
}

// 1件ずつは載せない組の件数（AI判定で不適合・判定待ち・再提案抑制・低評価）。人名・案件名を含まない
function countOnlySection(matches: MatchResult[]): string[] {
  const rejected = matches.filter((m) => m.category === 'rejected');
  const deferred = matches.filter((m) => m.category === 'deferred').length;
  const low = matches.filter((m) => m.verdict === 'low').length;
  const suppressed = primarySelectTally().suppressed;
  const lines: string[] = [];
  if (low > 0) lines.push(`・AI判定のスコアが基準（MATCH_MIN_LLM_SCORE）未満のため参考提案にした組: ${low}件（上の参考提案に含みます）`);
  if (rejected.length > 0) {
    const byCode = DEAL_BREAKER_CODES.map((c) => [c, rejected.filter((m) => m.dealBreakers?.includes(c)).length] as const)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => `${DEAL_BREAKER_LABEL[c]}${n}`);
    const lowScore = rejected.filter((m) => !m.dealBreakers?.length).length;
    const detail = [...byCode, ...(lowScore > 0 ? [`スコア不足${lowScore}`] : [])].join('・');
    const where =
      dbProvider() === 'sheets'
        ? 'スプレッドシート「マッチ」タブの「判定」列が「不適合」の行'
        : '確認UI（「不適合（AI判定）」の印）またはマッチDBの「判定」列';
    lines.push(`・AI判定で不適合: ${rejected.length}件（${detail}）— 下書きは作っていません。${where}で内容を確認できます`);
  }
  if (deferred > 0) {
    lines.push(`・AI判定待ち: ${deferred}件 — 1回の実行の判定予算・一時的な失敗のため、次回の実行で判定します（下書きは判定の後）`);
  }
  if (suppressed > 0) lines.push(`・再提案抑制 ${suppressed}件 — 以前「見送り」「ズレ」にした組の再送のため載せていません`);
  return lines.length > 0 ? ['【件数のみのお知らせ】', ...lines, ''] : [];
}

// Sheets運用では下書きは担当者メールの入力で次回バッチが作るため、URLの代わりに文面の在りかを示す
function draftLine(label: string, ref: DraftRef): string {
  if (ref.url) return `  ${label}: ${ref.url}`;
  if (draftRequestsEnabled()) return `  ${label}: 文面はスプレッドシート「マッチ」タブにあります（担当者メール入力で作成）`;
  return `  ${label}: 未作成（確認UIで送信元のアドレスを入力すると作成されます）`;
}

// 利用者向けの日時は日本時間で表記する（UTCのランナーでも10:00/14:00の実行と一致させる）
function jstNow(): string {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// 件名に実行時刻（JST）を添え、1日2回のサマリを見分けられるようにする
function summarySubject(): string {
  const hm = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  return `${SUMMARY_SUBJECT}（${hm}）`;
}

// 担当者メールによる下書き依頼の結果と使い方（Sheets運用の本番のみ）
function draftRequestSection(requested: PendingDraftResult): string[] {
  if (!draftRequestsEnabled()) return [];
  return [
    '【紹介メール下書き（担当者指定）】',
    `下書き作成: ${requested.created}件（担当者指定分）${requested.failed > 0 ? ` / 失敗: ${requested.failed}件` : ''}`,
    '■下書きの作り方',
    '1. スプレッドシート「マッチ」タブで、成立候補・交渉提案の行の「案件側文面」「要員側文面」を確認する',
    '2. その行の「担当者メール」列に、送信元にするご自身の会社メールアドレスを1件入力する',
    '3. 次回のバッチ（平日10:00／14:00）で、そのアドレスを送信元とした「全員に返信」の下書きが作成され、',
    '   「案件側下書き状態」「要員側下書き状態」が「作成済 日時」になります（送信はご自身で内容を確認してから）',
    `   作成先: ${mailProvider() === 'gmail' ? 'ご自身のGmailの下書き' : '共有メールボックスの下書きフォルダ'}`,
    '・片側だけ作る場合は、不要な側の状態を「不要」にしてください',
    '・状態が「エラー: …」の側は次回バッチで再試行します（担当者メールを直せば反映されます）',
    ...(requested.stale
      ? [`・状態が「作成中」のまま残っている依頼が${requested.stale}件あります。下書きフォルダを確認し、あれば「作成済」、無ければ空欄に戻してください`]
      : []),
    '・文面の修正は、作成された下書き上で行ってください（シートの文面列を書き換えても下書きには反映されません）',
    '・「プロパー候補」タブ（自社社員のご提案）も同じ手順です（案件側の下書きのみ）',
    '',
  ];
}

function buildSummary(matches: MatchResult[], requestedDrafts: PendingDraftResult, carried: MatchSummaryRow[] = []): string {
  const confirmed = matches.filter((m) => m.category === 'confirmed');
  const tentative = matches.filter((m) => m.category === 'tentative');
  const negotiable = matches.filter((m) => m.category === 'negotiable');
  const needsReview = matches.filter((m) => m.category === 'review');

  const lines: string[] = [];
  lines.push('=== SESマッチング結果サマリ ===');
  lines.push(`検出日時: ${jstNow()}`);
  lines.push(countLine(matches));
  lines.push('');
  lines.push(...draftRequestSection(requestedDrafts));
  lines.push(...carriedSection(carried, new Set(matches.map((m) => m.id))));

  if (!matches.some(isListed)) {
    lines.push('今回のバッチで成立・交渉・参考のいずれの候補も検出されませんでした。');
  } else {
    if (confirmed.length > 0) {
      lines.push('【成立候補】');
      for (const m of confirmed) {
        lines.push(`・${summaryTitle(m.title)} — 粗利${(m.grossMarginJpy / 10000).toFixed(1)}万円/月, 適合スコア${m.score}点`);
        lines.push(`  根拠: ${summaryText(m.reason)}`);
        if (m.draftToProject) lines.push(draftLine('案件側下書き', m.draftToProject));
        if (m.draftToEngineer) lines.push(draftLine('要員側下書き', m.draftToEngineer));
      }
      lines.push('');
    }
    if (tentative.length > 0) {
      lines.push('【参考提案（スキルは許容範囲内・人によるご確認を推奨）】');
      for (const m of tentative) {
        lines.push(`・${summaryTitle(m.title)} — 適合スコア${m.score}点`);
        lines.push(`  根拠: ${summaryText(m.reason)}`);
      }
      lines.push('');
    }
    if (negotiable.length > 0) {
      lines.push('【交渉提案（単金を両者で調整すれば成立見込み）】');
      for (const m of negotiable) {
        const n = m.negotiation!;
        lines.push(
          `・${summaryTitle(m.title)} — 案件+${n.projectRaiseMan}万円／要員−${n.engineerCutMan}万円で粗利${(n.resultingGrossMarginJpy / 10000).toFixed(1)}万円/月, 適合スコア${m.score}点`,
        );
        lines.push(`  根拠: ${summaryText(m.reason)}`);
        if (m.draftToProject) lines.push(draftLine('案件側下書き（交渉前提）', m.draftToProject));
        if (m.draftToEngineer) lines.push(draftLine('要員側下書き（交渉前提）', m.draftToEngineer));
      }
      lines.push('');
    }
    if (needsReview.length > 0) {
      lines.push('【要確認（単金・勤務地等が不明のため人による確認が必要）】');
      for (const m of needsReview) {
        // 指示混入疑い・文面に入る項目のURL等で止めた組は、社外の記載そのもの（案件名）を載せずマッチIDだけにする
        // （バッチ自身が送る社内向けのサマリに、社外の文言・リンクを信頼できる体裁で載せないため）
        const held = [INJECTION_REVIEW_REASON, OUTGOING_TEXT_REVIEW_REASON, INJECTION_CAUTION, OUTGOING_TEXT_CAUTION].some((r) => m.reason.includes(r));
        lines.push(held ? `・マッチ ${m.id} — ${heldReason(m.reason)}（内容はスプレッドシートで確認してください）` : `・${summaryTitle(m.title)} — ${summaryText(m.reason)}`);
      }
      lines.push('');
    }
  }
  lines.push(...countOnlySection(matches));

  return lines.join('\n');
}

// サマリに載せる社外由来の文字列（案件名・判定根拠）の無害化: リンク・アドレスとして働かない表記にし（スキーム・'.'・'@'）、
// 長さを抑える。サマリはバッチ自身が社内へ送るメールのため、社外の文言に社内の案内の体裁を与えない
const SUMMARY_TITLE_CHARS = 80;
const SUMMARY_TEXT_CHARS = 400;

export function summaryText(s: string, max = SUMMARY_TEXT_CHARS): string {
  const oneLine = (s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
  const capped = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  if (!linkOrContactLike(capped) && !/[@＠]/.test(capped)) return capped;
  return capped
    .replace(/\b(h)(?:tt|xx)(ps?):\/\//gi, '$1xx$2[:]//')
    .replace(/\b(ftp):\/\//gi, '$1[:]//')
    .replace(/[@＠]/g, '[at]')
    .replace(/([A-Za-z0-9-])[.．]([A-Za-z]{2,24})(?![A-Za-z0-9-])/g, '$1[.]$2');
}

export function summaryTitle(s: string): string {
  return summaryText(s, SUMMARY_TITLE_CHARS);
}

function heldReason(reason: string): string {
  if (reason.includes(INJECTION_REVIEW_REASON) || reason.includes(INJECTION_CAUTION)) return INJECTION_REVIEW_REASON;
  return OUTGOING_TEXT_REVIEW_REASON;
}

// metricsLines は件数・比率だけの行（秘匿モードのコンソールにも出してよい）
async function notifySummary(summary: string, consoleSummary: string, counts: string, metricsLines: string[] = []): Promise<NotifyOutcome> {
  if (logRedact()) console.log(`SES通知: 結果 ${counts}（詳細はサマリメールを参照）`);
  else console.log(`\n${consoleSummary}\n`);
  if (metricsLines.length > 0) console.log(`${metricsLines.join('\n')}\n`);
  if (isDemo()) return 'skipped'; // demoはコンソール出力のみ

  if (!sesNotifyTo()) {
    console.warn('SES通知: SES_NOTIFY_TO が未設定のためサマリメール送信をスキップ');
    return 'skipped';
  }
  // サマリには社員・要員の個人データが載るため、社外のドメインの宛先には送らない（明示の許可がある場合を除く）
  const { to, externalSkipped } = notifyRecipients();
  if (externalSkipped > 0) {
    console.warn(`SES通知: SES_NOTIFY_TO のうち社外のドメインの${externalSkipped}件には送りません（社外にも送る場合は SES_NOTIFY_ALLOW_EXTERNAL=true）`);
  }
  if (!to) {
    recordFatal('SES_NOTIFY_TO に社内のドメインの宛先が無いため、サマリメールを送れません（SES_OWN_DOMAINS と宛先を確認してください）');
    return 'failed';
  }
  if (!sendMailReady()) {
    // 宛先があるのに送れない設定は、スケジュール実行では結果が誰にも届かないため異常終了扱いにする
    const message = 'サマリメールの送信設定（XSERVER_SMTP_* または SES_TARGET_GMAIL と Google認証）が未完了です';
    if (requireLive()) {
      recordFatal(message);
      return 'failed';
    }
    console.warn(`SES通知: ${message} — 送信をスキップします`);
    return 'skipped';
  }
  try {
    await sendPlainMailViaMail(to, summarySubject(), summary);
    return 'sent';
  } catch (err) {
    console.error(`SES通知: サマリメール送信に失敗: ${safeErr(err)}`);
    recordFatal('サマリメールの送信に失敗しました（このサマリのマッチは次の回のサマリにも載せます）');
    return 'failed';
  }
}
