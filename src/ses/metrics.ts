// バンド別の成約率メトリクス。参考提案(tentative)枠が実際どれだけ成約に繋がるかを可視化し、
// しきい値を締める/緩める判断材料にする。確認UIのメトリクスパネルが参照。
import type { ReviewMatch, MatchFeedback, BandMetrics, MatchBand } from '../types/index.js';

type BandKey = MatchBand | 'negotiable';

function bandKeyOf(m: ReviewMatch): BandKey {
  return m.category === 'negotiable' ? 'negotiable' : m.band;
}

export function computeBandMetrics(matches: ReviewMatch[], feedback: MatchFeedback[]): BandMetrics[] {
  const fbByMatch = new Map<string, MatchFeedback[]>();
  for (const f of feedback) {
    const arr = fbByMatch.get(f.matchId);
    if (arr) arr.push(f);
    else fbByMatch.set(f.matchId, [f]);
  }

  const keys: BandKey[] = ['strong', 'tentative', 'negotiable'];
  return keys.map((band) => {
    const inBand = matches.filter((m) => bandKeyOf(m) === band);
    let introduced = 0;
    let closedWon = 0;
    let dropped = 0;
    let good = 0;
    let bad = 0;
    for (const m of inBand) {
      if (m.status === 'introduced') introduced += 1;
      else if (m.status === 'closed_won') closedWon += 1;
      else if (m.status === 'dropped') dropped += 1;
      for (const f of fbByMatch.get(m.id) ?? []) {
        if (f.verdict === 'good') good += 1;
        else bad += 1;
      }
    }
    const decided = closedWon + dropped;
    const rated = good + bad;
    return {
      band,
      total: inBand.length,
      introduced,
      closedWon,
      dropped,
      good,
      bad,
      winRate: decided > 0 ? closedWon / decided : null,
      goodRate: rated > 0 ? good / rated : null,
    };
  });
}
