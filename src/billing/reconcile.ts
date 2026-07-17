import type {
  Assignment,
  ExtractedDocument,
  InspectionStatus,
  InvoiceChecklistItem,
  Member,
  RateTerms,
  ReconciliationResult,
  Rounding,
} from '../types/engagements.js';

// 検収の計算ロジック（純関数のみ）。I/O・LLM呼び出しは行わない。
// ドライラン出力の calculationNote / checklist で計算過程を目視検証できるようにする。

const TAX_RATE = 0.1;
const TIMESHEET_HOURS_PER_100_PERCENT = 200; // 稼働率100%あたりの月間上限時間の目安

export function applyRounding(value: number, rounding: Rounding): number {
  switch (rounding) {
    case 'ceil':
      return Math.ceil(value);
    case 'round':
      return Math.round(value);
    case 'floor':
    default:
      return Math.floor(value);
  }
}

function rangeLabel(terms: RateTerms): string {
  if (terms.lowerHours !== undefined && terms.upperHours !== undefined) {
    return `精算幅${terms.lowerHours}-${terms.upperHours}h`;
  }
  if (terms.upperHours !== undefined) return `上限${terms.upperHours}h`;
  if (terms.lowerHours !== undefined) return `下限${terms.lowerHours}h`;
  return '精算幅なし';
}

// 精算幅（月額+精算幅）または時給×実稼働で金額を計算する。note に計算根拠を必ず残す。
export function calcSettlement(
  terms: RateTerms,
  hours: number,
  rounding: Rounding,
): { amount: number; note: string } {
  if (terms.rateType === 'hourly') {
    if (terms.hourlyRate === undefined) {
      return { amount: 0, note: '請求時給単価が未設定のため金額を計算できません' };
    }
    const amount = applyRounding(terms.hourlyRate * hours, rounding);
    return {
      amount,
      note: `時給単価${terms.hourlyRate.toLocaleString()}円 × 実稼働${hours.toFixed(1)}h = ${amount.toLocaleString()}円`,
    };
  }

  if (terms.monthlyRate === undefined) {
    return { amount: 0, note: '月額単価が未設定のため金額を計算できません' };
  }
  const monthlyRate = terms.monthlyRate;
  const label = rangeLabel(terms);

  let amount = monthlyRate;
  let note: string;

  if (terms.upperHours !== undefined && hours > terms.upperHours) {
    const overRate = applyRounding(terms.overtimeRate ?? monthlyRate / terms.upperHours, rounding);
    const overHours = hours - terms.upperHours;
    const overAmount = overHours * overRate;
    amount += overAmount;
    note = `${label}、稼働${hours.toFixed(1)}hのため超過${overHours.toFixed(1)}h×${overRate.toLocaleString()}円=${Math.round(overAmount).toLocaleString()}円を加算`;
  } else if (terms.lowerHours !== undefined && hours < terms.lowerHours) {
    const deductionRate = applyRounding(terms.deductionRate ?? monthlyRate / terms.lowerHours, rounding);
    const shortHours = terms.lowerHours - hours;
    const deductionAmount = shortHours * deductionRate;
    amount -= deductionAmount;
    note = `${label}、稼働${hours.toFixed(1)}hのため控除${shortHours.toFixed(1)}h×${deductionRate.toLocaleString()}円=${Math.round(deductionAmount).toLocaleString()}円を控除`;
  } else {
    note = `${label}内の稼働${hours.toFixed(1)}hのため基本月額${monthlyRate.toLocaleString()}円のまま`;
  }

  amount = applyRounding(amount, rounding);
  return { amount, note: `${note}（精算後${amount.toLocaleString()}円）` };
}

// 請求書の記載事項6要件+マスタ照合2件のチェックリストを組み立てる
function buildChecklist(extracted: ExtractedDocument, member: Member): InvoiceChecklistItem[] {
  const items: InvoiceChecklistItem[] = [];

  items.push({
    label: '発行者名の記載',
    ok: Boolean(extracted.issuerName),
    detail: extracted.issuerName ? `発行者名: ${extracted.issuerName}` : '発行者名の記載なし',
  });
  items.push({
    label: '取引年月日の記載',
    ok: Boolean(extracted.issueDate),
    detail: extracted.issueDate ? `取引年月日: ${extracted.issueDate}` : '取引年月日の記載なし',
  });
  items.push({
    label: '対象月の記載',
    ok: Boolean(extracted.targetMonth),
    detail: extracted.targetMonth ? `対象月: ${extracted.targetMonth}` : '対象月の記載なし',
  });
  items.push({
    label: '税率区分ごとの記載',
    ok: extracted.hasTaxRateBreakdown,
    detail: extracted.hasTaxRateBreakdown ? '税率区分ごとの対象額・消費税額の記載あり' : '税率区分ごとの記載なし',
  });
  items.push({
    label: '消費税額の記載',
    ok: extracted.taxAmount !== null,
    detail: extracted.taxAmount !== null ? `消費税額: ${extracted.taxAmount.toLocaleString()}円` : '消費税額の記載なし',
  });
  items.push({
    label: '宛名の記載',
    ok: Boolean(extracted.recipientName),
    detail: extracted.recipientName ? `宛名: ${extracted.recipientName}` : '宛名の記載なし',
  });

  const masterInvoiceNo = member.invoiceRegistrationNumber?.trim();
  if (!masterInvoiceNo) {
    items.push({ label: 'インボイス登録番号の一致', ok: true, detail: '免税事業者 — 経過措置対象' });
  } else {
    const matched = extracted.invoiceRegistrationNumber === masterInvoiceNo;
    items.push({
      label: 'インボイス登録番号の一致',
      ok: matched,
      detail: matched
        ? `登録番号一致: ${masterInvoiceNo}`
        : `登録番号不一致（マスタ: ${masterInvoiceNo} / 記載: ${extracted.invoiceRegistrationNumber ?? '記載なし'}）`,
    });
  }

  const masterBank = member.bankAccount?.replace(/\s+/g, '');
  if (!masterBank) {
    items.push({ label: '振込先の一致', ok: true, detail: 'マスタ未登録のため照合不可' });
  } else {
    const extractedBank = extracted.bankAccount?.replace(/\s+/g, '') ?? '';
    const matched = extractedBank !== '' && (extractedBank.includes(masterBank) || masterBank.includes(extractedBank));
    items.push({
      label: '振込先の一致',
      ok: matched,
      detail: matched
        ? `振込先一致: ${member.bankAccount}`
        : `振込先不一致（マスタ: ${member.bankAccount} / 記載: ${extracted.bankAccount ?? '記載なし'}）`,
    });
  }

  return items;
}

// 請求書の検収: 支払条件×稼働時間から期待額を算出し、記載の請求額と突合する
export function reconcile(assignment: Assignment, extracted: ExtractedDocument, member: Member): ReconciliationResult {
  const checklist = buildChecklist(extracted, member);

  if (!assignment.payment || extracted.workedHours === null || extracted.totalAmount === null) {
    const reasons: string[] = [];
    if (!assignment.payment) reasons.push('アサインに支払条件が未設定');
    if (extracted.workedHours === null) reasons.push('稼働時間を抽出できず');
    if (extracted.totalAmount === null) reasons.push('請求金額を抽出できず');
    return {
      status: '要確認',
      expectedSubtotal: 0,
      expectedTax: 0,
      expectedTotal: 0,
      diff: 0,
      calculationNote: `検収不能: ${reasons.join('・')}`,
      checklist,
    };
  }

  const { amount: expectedSubtotal, note } = calcSettlement(assignment.payment, extracted.workedHours, assignment.rounding);
  const expectedTax = applyRounding(expectedSubtotal * TAX_RATE, assignment.rounding);
  const expectedTotal = expectedSubtotal + expectedTax;
  const diff = extracted.totalAmount - expectedTotal;
  const status: InspectionStatus = Math.abs(diff) <= 1 ? '検収OK' : '差異あり';

  return {
    status,
    expectedSubtotal,
    expectedTax,
    expectedTotal,
    diff,
    calculationNote: `${note}。税抜期待額${expectedSubtotal.toLocaleString()}円+消費税${expectedTax.toLocaleString()}円=期待税込${expectedTotal.toLocaleString()}円。請求額${extracted.totalAmount.toLocaleString()}円との差額${diff.toLocaleString()}円`,
    checklist,
  };
}

// 勤表の検収: 金額突合はせず、稼働時間・対象月が読めていれば検収OKとする
export function acceptTimesheet(assignment: Assignment, extracted: ExtractedDocument): ReconciliationResult {
  const empty = { expectedSubtotal: 0, expectedTax: 0, expectedTotal: 0, diff: 0, checklist: [] as InvoiceChecklistItem[] };

  if (extracted.workedHours === null) {
    return { status: '要確認', ...empty, calculationNote: '稼働時間を抽出できなかったため要確認' };
  }

  const upperLimit = (assignment.allocationPercent / 100) * TIMESHEET_HOURS_PER_100_PERCENT;
  if (extracted.workedHours > upperLimit) {
    return {
      status: '要確認',
      ...empty,
      calculationNote: `稼働${extracted.workedHours.toFixed(1)}hが稼働率${assignment.allocationPercent}%相当の目安上限${upperLimit.toFixed(1)}hを超えているため要確認`,
    };
  }

  if (!extracted.targetMonth) {
    return { status: '要確認', ...empty, calculationNote: '対象月を抽出できなかったため要確認' };
  }

  return {
    status: '検収OK',
    ...empty,
    calculationNote: `勤表: 対象月${extracted.targetMonth}・稼働${extracted.workedHours.toFixed(1)}hを確定`,
  };
}
