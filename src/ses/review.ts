// マッチ確認UI(web.ts)のデータ層。
// レビュー用ローカルJSON(reviewDataDir())を系のstore(Notion)とは別のレビュー作業領域として持つ。
// バッチ(notify.ts)と自社社員探し(ownMatch.ts)がここへ成果を書き出し、UIが読んでステータスを更新する。
// demo/本番のどちらでもこのローカル領域を使うため、UIはNotion接続なしでも動く。
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { reviewDataDir, demoDataDir } from './config.js';
import { updateMatchStatus } from '../database/index.js';
import { materializeReplyDraft } from './draft.js';
import type { ReviewMatch, OwnMatch, MatchResult, MatchStatus, DraftRef } from '../types/index.js';

function reviewPath(name: string): string {
  return join(process.cwd(), reviewDataDir(), `${name}.json`);
}

function writeJson(name: string, data: unknown): void {
  try {
    const dir = join(process.cwd(), reviewDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(reviewPath(name), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SESレビュー: 書き出しに失敗 (${name}): ${String(err)}`);
  }
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const filePath = reviewPath(name);
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.warn(`SESレビュー: 読み込みに失敗 (${name}): ${String(err)}`);
    return fallback;
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
export function writeReviewMatches(matches: MatchResult[]): void {
  const review: ReviewMatch[] = matches.map((m) => ({
    id: m.id,
    title: m.title,
    grossMarginJpy: m.grossMarginJpy,
    score: m.score,
    reason: m.reason,
    needsReview: m.needsReview,
    band: m.band,
    category: m.category,
    negotiation: m.negotiation,
    status: m.status,
    draftToProjectUrl: m.draftToProject?.url ?? null,
    draftToEngineerUrl: m.draftToEngineer?.url ?? null,
    // 全員に返信の本文をプレビュー用にインライン（本文は our 生成物なのでdemo/本番共通で保持）
    draftToProjectText: m.draftToProject?.body ?? readDemoDraftText(m.draftToProject?.url),
    draftToEngineerText: m.draftToEngineer?.body ?? readDemoDraftText(m.draftToEngineer?.url),
    draftProject: m.draftToProject,
    draftEngineer: m.draftToEngineer,
    notionPageId: m.notionPageId,
  }));
  writeJson('matches', review);
}

export function readReviewMatches(): ReviewMatch[] {
  return readJson<ReviewMatch[]>('matches', []);
}

export function writeReviewOwnMatches(matches: OwnMatch[]): void {
  writeJson('own-matches', matches);
}

export function readReviewOwnMatches(): OwnMatch[] {
  return readJson<OwnMatch[]>('own-matches', []);
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
  if (target.notionPageId) {
    try {
      await updateMatchStatus(target.notionPageId, status);
    } catch (err) {
      console.warn(`SESレビュー: ステータスのNotion反映に失敗 (${id}): ${String(err)}`);
    }
  }
  return target;
}

// 既に ReviewMatch[] を持っている場合の書き出し（setMatchStatus用。変換不要）
function writeReviewMatches2(matches: ReviewMatch[]): void {
  writeJson('matches', matches);
}

// 確認UIから「送信元＝担当営業本人の会社アドレス」で全員に返信の下書きを作成する。
// demo=Fromを入れてローカル保存、prod=本人のGmailにスレッド返信下書きを作成。
export async function createReplyDraftForSender(
  matchId: string,
  side: 'project' | 'engineer',
  fromEmail: string,
): Promise<DraftRef | null> {
  const matches = readReviewMatches();
  const target = matches.find((m) => m.id === matchId);
  if (!target) return null;
  const ref = side === 'project' ? target.draftProject : target.draftEngineer;
  if (!ref) return null;

  const finalized = await materializeReplyDraft(ref, fromEmail);
  if (side === 'project') {
    target.draftProject = finalized;
    target.draftToProjectUrl = finalized.url;
  } else {
    target.draftEngineer = finalized;
    target.draftToEngineerUrl = finalized.url;
  }
  writeReviewMatches2(matches);
  return finalized;
}

// レビュー領域に何か成果があるか（UI起動時の案内用）
export function hasReviewData(): boolean {
  const dir = join(process.cwd(), reviewDataDir());
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
