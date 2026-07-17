// マッチ評価（人間フィードバック）の保存・読み込みと、LLM最終判定へのfew-shot生成。
// 複数人運用のため共有の正は prod=Notion（評価ログDB）、demo=ローカルJSON。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, reviewDataDir } from './config.js';
import { saveMatchFeedback, fetchRecentFeedback } from '../database/index.js';
import type { MatchFeedback } from '../types/index.js';

function localPath(): string {
  return join(process.cwd(), reviewDataDir(), 'feedback.json');
}

function readLocal(): MatchFeedback[] {
  try {
    if (!existsSync(localPath())) return [];
    return JSON.parse(readFileSync(localPath(), 'utf-8')) as MatchFeedback[];
  } catch {
    return [];
  }
}

function writeLocal(list: MatchFeedback[]): void {
  try {
    const dir = join(process.cwd(), reviewDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(localPath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`フィードバックの保存に失敗: ${String(err)}`);
  }
}

// 評価を記録（確認UIから。demo=ローカル追記、prod=Notion評価ログDB）。
export async function recordFeedback(fb: MatchFeedback): Promise<void> {
  if (isDemo()) {
    const list = readLocal();
    list.push(fb);
    writeLocal(list);
    return;
  }
  try {
    await saveMatchFeedback(fb);
  } catch (err) {
    console.warn(`フィードバックのNotion保存に失敗: ${String(err)}`);
  }
}

// 蓄積された評価を読み込む（メトリクス・few-shot用）。
export async function loadFeedback(limit = 200): Promise<MatchFeedback[]> {
  if (isDemo()) return readLocal().slice(-limit);
  try {
    return await fetchRecentFeedback(limit);
  } catch (err) {
    console.warn(`フィードバックの取得に失敗: ${String(err)}`);
    return [];
  }
}

// LLM最終判定のシステムプロンプトに添える few-shot（御社の許容感覚を学習させる）。
export async function buildFeedbackFewShot(max = 6): Promise<string> {
  const all = await loadFeedback(50);
  if (all.length === 0) return '';
  const recent = all.slice(-max);
  const lines = recent.map(
    (f) => `- 「${f.matchTitle}」→ ${f.verdict === 'good' ? '妥当' : 'ズレ'}${f.note ? `（${f.note}）` : ''}`,
  );
  return `【過去のマッチ評価（社内の人間フィードバック。同様の判断基準・許容度で採点してください）】\n${lines.join('\n')}`;
}
