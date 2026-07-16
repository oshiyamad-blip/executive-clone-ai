import type { RawLog } from '../types/index.js';

// 文字bigram集合のJaccard係数で類似度を計算する。
// 日本語は単語間に空白が無いため、空白分割ではなく文字bigramでトークン化する
// （英語テキストにも有効）。
function charBigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const grams = new Set<string>();
  if (t.length <= 1) {
    if (t.length === 1) grams.add(t);
    return grams;
  }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

function similarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  const intersection = new Set([...setA].filter((g) => setB.has(g)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// 同一時間帯（±30分）かつ内容が類似するログを1件にマージする
export function deduplicateLogs(logs: RawLog[]): RawLog[] {
  const SIMILARITY_THRESHOLD = 0.6;
  const TIME_WINDOW_MS = 30 * 60 * 1000;

  const used = new Set<string>();
  const merged: RawLog[] = [];
  const sorted = [...logs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const log of sorted) {
    if (used.has(log.id)) continue;

    const duplicates = sorted.filter(
      (other) =>
        !used.has(other.id) &&
        other.id !== log.id &&
        Math.abs(other.timestamp.getTime() - log.timestamp.getTime()) <= TIME_WINDOW_MS &&
        similarity(log.content, other.content) >= SIMILARITY_THRESHOLD,
    );

    if (duplicates.length > 0) {
      const all = [log, ...duplicates];
      // 最も長いコンテンツを持つログをメインとして採用する
      const primary = all.reduce((a, b) => (a.content.length >= b.content.length ? a : b));
      merged.push({
        ...primary,
        metadata: {
          ...primary.metadata,
          mergedFrom: all.map((l) => l.id),
          sources: [...new Set(all.map((l) => l.source))],
        },
      });
      all.forEach((l) => used.add(l.id));
    } else {
      merged.push(log);
      used.add(log.id);
    }
  }

  const dedupedCount = logs.length - merged.length;
  if (dedupedCount > 0) {
    console.log(`名寄せ: ${dedupedCount}件の重複を統合（${logs.length} → ${merged.length}件）`);
  }

  return merged;
}
