// Anthropic が公表しているモデルの退役予定（事前確認・診断で知らせるため。2026-09-23 に公式ドキュメントで確認）。
// 日付は「この日より前には退役しない」の意味。モデルを追加・更新したらここに1行足す
export interface ModelRetirement {
  match: string;
  notBefore: string; // YYYY-MM-DD
}

const RETIREMENTS: ModelRetirement[] = [
  { match: 'haiku-4-5', notBefore: '2026-10-15' },
  { match: 'opus-4-8', notBefore: '2027-05-28' },
];

// この日数を切ったら事前確認で注意にする
export const RETIREMENT_WARN_DAYS = 45;

export interface RetirementNotice {
  notBefore: string;
  daysLeft: number; // 負 = 予定日を過ぎた
  soon: boolean; // RETIREMENT_WARN_DAYS 以内、または過ぎた
}

export function retirementNotice(model: string, now = new Date()): RetirementNotice | null {
  const hit = RETIREMENTS.find((r) => model.includes(r.match));
  if (!hit) return null;
  const today = Date.parse(`${new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00Z`);
  const daysLeft = Math.round((Date.parse(`${hit.notBefore}T00:00:00Z`) - today) / 86_400_000);
  return { notBefore: hit.notBefore, daysLeft, soon: daysLeft <= RETIREMENT_WARN_DAYS };
}
