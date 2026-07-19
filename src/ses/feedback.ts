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

function appendLocal(fb: MatchFeedback): void {
  const list = readLocal();
  list.push(fb);
  writeLocal(list);
}

// UI連打のたびにNotionへ問い合わせないための短TTLキャッシュ（記録時は無効化して即反映）
let feedbackCache: { at: number; list: MatchFeedback[] } | null = null;
const FEEDBACK_CACHE_TTL_MS = 60_000;

// 評価を記録（確認UIから。demo=ローカル追記、prod=Notion評価ログDB）。
// prodでNotion保存に失敗した場合はローカルへ退避して消失を防ぎ、保存先を返す（UIで縮退を通知する）。
export async function recordFeedback(fb: MatchFeedback): Promise<'notion' | 'local'> {
  feedbackCache = null;
  if (isDemo()) {
    appendLocal(fb);
    return 'local';
  }
  try {
    const pageId = await saveMatchFeedback(fb);
    if (pageId) return 'notion';
  } catch (err) {
    console.warn(`フィードバックのNotion保存に失敗: ${String(err)}`);
  }
  appendLocal(fb); // 退避分は loadFeedback がマージして読むため、学習・メトリクスには反映され続ける
  return 'local';
}

// 蓄積された評価を読み込む（メトリクス・few-shot用）。常に「新しい順」で返す。
// prodはNotionを正としつつ、Notion障害時にローカル退避した分もマージする。
export async function loadFeedback(limit = 200): Promise<MatchFeedback[]> {
  if (isDemo()) return readLocal().slice(-limit).reverse(); // ローカルは追記順（古い順）のため反転
  if (feedbackCache && Date.now() - feedbackCache.at < FEEDBACK_CACHE_TTL_MS) {
    return feedbackCache.list.slice(0, limit);
  }
  let fromNotion: MatchFeedback[] = [];
  try {
    fromNotion = await fetchRecentFeedback(limit);
  } catch (err) {
    console.warn(`フィードバックの取得に失敗: ${String(err)}`);
  }
  const merged = [...fromNotion, ...readLocal()]
    .sort((a, b) => b.at.localeCompare(a.at)) // ISO文字列の辞書順=時刻順（新しい順）
    .slice(0, limit);
  feedbackCache = { at: Date.now(), list: merged };
  return merged;
}

// LLM最終判定のシステムプロンプトに添える few-shot（御社の許容感覚を学習させる）。
export async function buildFeedbackFewShot(max = 6): Promise<string> {
  const all = await loadFeedback(50);
  if (all.length === 0) return '';
  const recent = all.slice(0, max); // loadFeedbackは新しい順のため先頭が最新
  const lines = recent.map(
    (f) => `- 「${f.matchTitle}」→ ${f.verdict === 'good' ? '妥当' : 'ズレ'}${f.note ? `（${f.note}）` : ''}`,
  );
  return `【過去のマッチ評価（社内の人間フィードバック。同様の判断基準・許容度で採点してください）】\n${lines.join('\n')}`;
}
