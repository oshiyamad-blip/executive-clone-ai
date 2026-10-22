// 試運転で抽出担当が手で写す本文の先頭（bodyHead）のずれを測る（PHASE=score）。
// Gmail の取得結果が会話に直接返るため、写しが途中で切れる・写し間違える。本番は Xserver から直接読むので影響しない
export interface GapRow {
  messageId: string;
  kind?: string;
  extraction?: { projects?: unknown[] };
  bodyHead?: string;
  attachmentText?: string;
}

export interface GapJudgment {
  projectId: string;
  judgment: { requirements: Array<{ quote?: string }> };
}

export const BODY_HEAD_SHORT_CHARS = 1000;

// 空白・改行・全角半角の違いを無視して比べる
const squash = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '');

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// 案件メール（kind=project で案件が1件以上）のうち、bodyHead が 1000 文字未満の割合
export function bodyHeadShortPct(rows: GapRow[]): number | null {
  const mails = rows.filter((r) => r.kind === 'project' && (r.extraction?.projects?.length ?? 0) >= 1);
  return pct(mails.filter((r) => (r.bodyHead ?? '').length < BODY_HEAD_SHORT_CHARS).length, mails.length);
}

// 判定の requirements の quote（メール本文のままの決まり）のうち、その案件のメールの bodyHead（＋attachmentText）に含まれない割合。
// quote が空のもの・案件のメールが分からないものは数えない
export function quoteMissingPct(rows: GapRow[], judgments: GapJudgment[], mailIdOfProject: Map<string, string>): number | null {
  const material = new Map<string, string>();
  for (const r of rows) material.set(`sesmail_${r.messageId}`, squash(`${r.bodyHead ?? ''}${r.attachmentText ?? ''}`));
  let total = 0;
  let missing = 0;
  for (const j of judgments) {
    const hay = material.get(mailIdOfProject.get(j.projectId) ?? '');
    if (hay === undefined) continue;
    for (const req of j.judgment.requirements) {
      const q = squash(req.quote ?? '');
      if (!q) continue;
      total += 1;
      if (!hay.includes(q)) missing += 1;
    }
  }
  return pct(missing, total);
}
