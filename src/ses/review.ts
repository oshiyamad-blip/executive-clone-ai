// マッチ確認UI(web.ts)のデータ層。
// レビュー用ローカルJSON(reviewDataDir())を系のstore(Notion)とは別のレビュー作業領域として持つ。
// バッチ(notify.ts)と自社社員探し(ownMatch.ts)がここへ成果を書き出し、UIが読んでステータスを更新する。
// demo/本番のどちらでもこのローカル領域を使うため、UIはNotion接続なしでも動く。
// ※ スケジュール実行（GitHub Actions・DB_PROVIDER=sheets）ではこのローカル領域は実行ごとに消えるため、
//   本番の正はスプレッドシートの「マッチ」タブ（ステータス・担当者メール・下書き状態・文面）。ここは手元のUI用の写し。
// 書き込みは一時ファイル→rename で行い（途中で止まっても壊れたJSONを残さない）、読み込みに失敗した既存ファイルは
// 退避してから書き直す（壊れたファイルを空とみなして人のステータスを黙って消さない）。
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { reviewDataDir, demoDataDir, isDemo, matchLookbackDays, retentionDays } from './config.js';
import { updateMatchStatus } from '../database/index.js';
import { materializeReplyDraft, FROM_PLACEHOLDER } from './draft.js';
import { draftRequestsEnabled } from './pendingDrafts.js';
import { safeErr, logId } from './redact.js';
import type { ReviewMatch, OwnMatch, MatchResult, MatchStatus, DraftRef } from '../types/index.js';

// UIで送信元（本人の会社アドレス）を確定済みの下書きか。
// 未確定の下書きも from にはプレースホルダー文字列が入っているため、単なる truthy 判定では誤る。
function isFinalizedDraft(ref: DraftRef | undefined): boolean {
  return Boolean(ref?.from) && ref!.from !== FROM_PLACEHOLDER;
}

function reviewPath(name: string): string {
  return join(process.cwd(), reviewDataDir(), `${name}.json`);
}

function writeJson(name: string, data: unknown): void {
  try {
    const dir = join(process.cwd(), reviewDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${reviewPath(name)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, reviewPath(name));
  } catch (err) {
    console.warn(`SESレビュー: 書き出しに失敗 (${name}): ${safeErr(err)}`);
  }
}

// 配列のJSONを読む。ファイルが無ければ []、壊れていれば null（呼び出し側で上書きの扱いを決める）
function readArray<T>(name: string): T[] | null {
  try {
    const filePath = reviewPath(name);
    if (!existsSync(filePath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch (err) {
    console.warn(`SESレビュー: 読み込みに失敗 (${name}): ${safeErr(err)}`);
    return null;
  }
}

function readJson<T>(name: string): T[] {
  return readArray<T>(name) ?? [];
}

// 壊れた既存ファイルを退避する（書き直しで人のステータスの手掛かりまで消さないため）
function backupCorrupt(name: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(reviewPath(name), `${reviewPath(name)}.corrupt-${stamp}`);
    console.warn(`SESレビュー: ${name}.json を読めなかったため退避してから書き直します`);
  } catch {
    /* 退避できなくても書き出しは続ける */
  }
}

// demoの下書き本文（data/ses-demo/drafts/<id>.txt）をインライン表示用に読む。無ければ null。
function readDemoDraftText(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // urlはローカルファイルパス（demo）。存在すれば内容を返す。
    if (existsSync(url)) return readFileSync(url, 'utf-8');
    // 相対でdraftsディレクトリから拾うフォールバック
    const base = url.split('/').pop() ?? '';
    const alt = join(process.cwd(), demoDataDir(), 'drafts', base);
    if (base && existsSync(alt)) return readFileSync(alt, 'utf-8');
    return null;
  } catch {
    return null;
  }
}

// MatchResult[] を表示用 ReviewMatch[] に変換して書き出す（notify.ts が呼ぶ）。
// 既存ファイルとマッチID（案件ID×要員IDから作る安定ID）でマージし、人が付けたステータス・確定済み下書きを再実行で消さない。
// タイトル（案件名×イニシャル）は別ペアと重なり得るため突き合わせに使わない。
// 再生成されなかった過去分は、人が触ったもの（未確認以外）は履歴として、未確認でも直近
// SES_MATCH_LOOKBACK_DAYS 日以内に検出したものは確認待ちとして残す（次の実行で新着が無くても一覧から消さない）
export function writeReviewMatches(matches: MatchResult[]): void {
  const read = readArray<ReviewMatch>('matches');
  if (read === null) backupCorrupt('matches');
  const existing = read ?? [];
  const prevById = new Map(existing.map((m) => [m.id, m]));

  const fresh: ReviewMatch[] = matches.map((m) => {
    const prev = prevById.get(m.id);
    // UIで送信元を確定済みの下書きは温存。未確定なら今回の生成物（最新の本文）を採用
    const draftProject = isFinalizedDraft(prev?.draftProject) ? prev!.draftProject : m.draftToProject;
    const draftEngineer = isFinalizedDraft(prev?.draftEngineer) ? prev!.draftEngineer : m.draftToEngineer;
    return {
      id: m.id,
      title: m.title,
      grossMarginJpy: m.grossMarginJpy,
      score: m.score,
      reason: m.reason,
      needsReview: m.needsReview,
      band: m.band,
      category: m.category,
      negotiation: m.negotiation,
      // 人が変更したステータスは再実行で「未確認」に戻さない
      status: prev && prev.status !== 'unconfirmed' ? prev.status : m.status,
      lastActionBy: prev?.lastActionBy,
      lastActionAt: prev?.lastActionAt,
      draftToProjectUrl: draftProject?.url ?? null,
      draftToEngineerUrl: draftEngineer?.url ?? null,
      // 全員に返信の本文をプレビュー用にインライン（本文は our 生成物なのでdemo/本番共通で保持）
      draftToProjectText: draftProject?.body ?? readDemoDraftText(draftProject?.url),
      draftToEngineerText: draftEngineer?.body ?? readDemoDraftText(draftEngineer?.url),
      draftProject,
      draftEngineer,
      notionPageId: m.notionPageId ?? prev?.notionPageId,
      detectedAt: prev?.detectedAt ?? m.detectedAt.toISOString(),
    };
  });

  const freshIds = new Set(fresh.map((f) => f.id));
  const keepUnconfirmedSince = Date.now() - matchLookbackDays() * 24 * 60 * 60 * 1000;
  // 人が操作した組も、個人データの保存期間（SES_RETENTION_DAYS）を過ぎたら手元の控えから消す
  const retainSince = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
  const carried = existing.filter((m) => {
    if (freshIds.has(m.id)) return false;
    const detected = m.detectedAt ? new Date(m.detectedAt).getTime() : NaN;
    if (m.status !== 'unconfirmed') return !(Number.isFinite(detected) && detected < retainSince);
    return Number.isFinite(detected) && detected >= keepUnconfirmedSince;
  });
  writeJson('matches', [...fresh, ...carried]);
}

export function readReviewMatches(): ReviewMatch[] {
  return readJson<ReviewMatch>('matches');
}

export function writeReviewOwnMatches(matches: OwnMatch[]): void {
  writeJson('own-matches', matches);
}

export function readReviewOwnMatches(): OwnMatch[] {
  return readJson<OwnMatch>('own-matches');
}

// UIからのステータス更新。レビュー領域を更新し、notionPageIdがあればNotionへも反映(best-effort)。
// 複数人運用のため、変更者(reviewer)を記録する。
export async function setMatchStatus(
  id: string,
  status: MatchStatus,
  reviewer = '',
): Promise<ReviewMatch | null> {
  const matches = readReviewMatches();
  const target = matches.find((m) => m.id === id);
  if (!target) return null;
  target.status = status;
  target.lastActionBy = reviewer || '(不明)';
  target.lastActionAt = new Date().toISOString();
  writeReviewMatches2(matches);
  // demoのレビューデータは本番DBと無関係のため、DBへは反映しない
  if (target.notionPageId && !isDemo()) {
    try {
      await updateMatchStatus(target.notionPageId, status);
    } catch (err) {
      console.warn(`SESレビュー: ステータスのDB反映に失敗 (${logId(id)}): ${safeErr(err)}`);
    }
  }
  return target;
}

// 既に ReviewMatch[] を持っている場合の書き出し（setMatchStatus用。変換不要）
function writeReviewMatches2(matches: ReviewMatch[]): void {
  writeJson('matches', matches);
}

// 確認UIから「送信元＝担当営業本人の会社アドレス」で全員に返信の下書きを作成する。
// demo=Fromを入れてローカル保存、prod=本人のGmail／共有の下書きフォルダにスレッド返信下書きを作成。
// 同じ側の下書きが作成済みなら作らない（二重の紹介メール防止）。作成の待ち時間中に他の操作・バッチが
// 書いた内容を古い写しで上書きしないよう、作成後に読み直してこのマッチのこの側だけを書き換える
export type DraftCreateResult = { ok: true; ref: DraftRef } | { ok: false; reason: 'not_found' | 'already_created' | 'use_sheet' };

export async function createReplyDraftForSender(
  matchId: string,
  side: 'project' | 'engineer',
  fromEmail: string,
): Promise<DraftCreateResult> {
  // Sheets運用の本番では、下書きはスプレッドシートの「担当者メール」列からバッチだけが作る（作成中の印・下書きの識別子で
  // 二重作成を防ぐ）。確認UIから直接作るとシートの状態列に作成済みが残らず、同じ組の依頼からバッチがもう1通作ってしまう
  if (draftRequestsEnabled()) return { ok: false, reason: 'use_sheet' };
  const target = readReviewMatches().find((m) => m.id === matchId);
  const ref = target && (side === 'project' ? target.draftProject : target.draftEngineer);
  if (!target || !ref) return { ok: false, reason: 'not_found' };
  if (isFinalizedDraft(ref) || inFlight.has(`${matchId}:${side}`)) return { ok: false, reason: 'already_created' };

  inFlight.add(`${matchId}:${side}`);
  let finalized: DraftRef;
  try {
    finalized = await materializeReplyDraft(ref, fromEmail);
  } finally {
    inFlight.delete(`${matchId}:${side}`);
  }

  const latest = readReviewMatches();
  const current = latest.find((m) => m.id === matchId);
  if (current) {
    if (side === 'project') {
      current.draftProject = finalized;
      current.draftToProjectUrl = finalized.url;
      current.draftToProjectText = finalized.body ?? current.draftToProjectText;
    } else {
      current.draftEngineer = finalized;
      current.draftToEngineerUrl = finalized.url;
      current.draftToEngineerText = finalized.body ?? current.draftToEngineerText;
    }
    writeReviewMatches2(latest);
  }
  return { ok: true, ref: finalized };
}

// 同じプロセス内で同じ側の下書きを同時に作らないための印（UIの連打・複数人の同時操作）
const inFlight = new Set<string>();

// レビュー領域に何か成果があるか（UI起動時の案内用）
export function hasReviewData(): boolean {
  const dir = join(process.cwd(), reviewDataDir());
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
