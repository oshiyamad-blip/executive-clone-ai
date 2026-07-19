import type { Assignment, ContractorAvailability, Member } from '../types/engagements.js';
import { formatMonth, overlapsMonth } from '../engagements/month.js';

// 稼働スケジュール導出（純関数のみ・I/O禁止）。
// 要員×月の空き% = 100 − その月に期間が重なる「契約中」アサインの稼働率合計（下限0）。

// fromDate を含む月から months ヶ月分の 'YYYY-MM' 配列を返す
export function monthRange(from: Date, months: number): string[] {
  const result: string[] = [];
  const year = from.getFullYear();
  const month = from.getMonth(); // 0-indexed
  for (let i = 0; i < months; i++) {
    result.push(formatMonth(new Date(year, month + i, 1)));
  }
  return result;
}

export function deriveAvailability(
  members: Member[],
  assignments: Assignment[],
  fromMonth: Date,
  months: number,
): ContractorAvailability[] {
  const targetMonths = monthRange(fromMonth, months);

  return members
    // ドラフト = leads が自動登録した未確認要員。人が昇格させるまで提案・稼働率計算の対象外
    .filter((member) => member.status !== '取引終了' && member.status !== 'ドラフト')
    .map((member) => {
      const memberAssignments = assignments.filter(
        (a) => a.memberId === member.id && a.status === '契約中',
      );
      const monthEntries = targetMonths.map((month) => {
        const allocated = memberAssignments
          .filter((a) => overlapsMonth(a.period, month))
          .reduce((sum, a) => sum + a.allocationPercent, 0);
        const freePercent = Math.max(0, 100 - allocated);
        return { month, freePercent };
      });
      return {
        memberId: member.id,
        memberName: member.name,
        kind: member.kind,
        months: monthEntries,
        nextAvailableDate: member.nextAvailableDate,
        availabilityNote: member.availabilityNote,
      };
    });
}
