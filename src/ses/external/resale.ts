// 外部マッチ: 商流・再委託の条件で、別の会社へ紹介できない案件・要員を外す。
// 迷うときは外す側に倒す（誤って転売不可の人・案件を他社へ紹介するほうが、見送るより損が大きい）。
// 「1社先まで」だけの記載（1段までは可）は外さない。「貴社1社先まで」も同じ

const WHO = '(?:の)?(?:(?:正社員|社員|従業員|所属|プロパー|雇用|要員|人材|技術者|エンジニア)(?:の)?){0,2}(?:の方|様)?';

// 社員などのあとに付く短いかっこ書き（「貴社社員（契約社員可）まで」）。NFKC のあとは半角になるが、念のため全角も許す
const NOTE = '(?:[（(][^\\n）)]{0,12}[）)])?';

const RESTRICTIONS: RegExp[] = [
  // 再委託・再々委託・転売・再提案が不可
  /再[再々]?委託(?:は)?(?:不可|禁止|NG|×|できません|できない|不可能|なし|無し|制限)/,
  /(?:転売|再提案|他社(?:への)?(?:提案|紹介|開示)|二次請け|二次受け|2次請け|2次受け|下請け)(?:は|以降は|以降)?(?:不可|禁止|NG|×|できません)/,
  // 貴社まで・貴社社員まで・貴社正社員まで・貴社所属まで・弊社まで・御社まで
  new RegExp(`(?:貴社|御社)${WHO}${NOTE}(?:まで|のみ|限定|に限り|に限る)`),
  // 貴社社員・個人事業主まで（社員の後ろに並べ書きが続くとき）
  new RegExp(`(?:貴社|御社)${WHO}${NOTE}(?:(?:や|、|・|,|及び|および|と)(?:正社員|社員|契約社員|個人事業主|フリーランス)${NOTE})+(?:まで|のみ|限定|に限り|に限る)`),
  // 弊社・当社は「ご連絡は弊社まで」と区別するため、社員・所属などが付くときだけ
  new RegExp(`(?:弊社|当社|自社)(?:の)?(?:正社員|社員|従業員|所属|プロパー)(?:の方|様)?${NOTE}(?:まで|のみ|限定|に限り|に限る)`),
  // プロパーのみ・自社社員のみ・正社員のみ
  /(?:プロパー|正社員)(?:社員)?(?:の方)?(?:のみ|限定|まで|必須|に限る)/,
  // 1社先まで不可（「1社先まで」だけなら許可の記載なので当たらない）
  /[0-9一二三]社先(?:まで)?(?:は)?(?:不可|NG|禁止|×)/,
  // エンド直のみ
  /エンド(?:直|直接)(?:契約|取引|請け)?(?:のみ|限定|まで|希望)/,
  /直(?:請け|契約|取引)(?:のみ|限定)/,
  // 貴社雇用の方のみ（こちらが雇用する人だけ。他社の要員は出せない）。「所属：御社雇用の方」「貴社雇用者に限る」「御社雇用の方」
  /(?:御社|貴社)(?:の)?(?:直接)?雇用(?:の方|者|の人)/,
  /(?:所属|商流|制限|条件)[：:\s]*(?:御社|貴社)(?:の)?(?:直接)?雇用(?:のみ|限定|に限る|まで)/,
  // 商流の制限あり（「制限なし」は当たらない）
  /商流(?:に)?制限(?![】\]）)：:\s]*(?:なし|無し|ありません|特になし))/,
];

// 派遣の契約形態（他社の要員を派遣で出すと二重派遣になる）。「派遣ではありません」「派遣不可」「派遣元」「人材派遣会社様」など否定・業種の語は当てない
const DISPATCH: RegExp[] = [
  /契約形態\s*[：:]?\s*(?:労働者)?派遣/,
  /派遣契約(?!\s*(?:は|も)?\s*(?:不可|NG|なし|無し|ではあ|ではな|ありません))/,
  /紹介予定派遣/,
  /派遣(?:案件|求人|募集|形態)(?!\s*(?:は|も)?\s*(?:ではあ|ではな|不可|NG|なし|無し|ありません))/,
  /派遣前提/,
  /派遣\s*[(](?:労使協定|労働者派遣)/,
];

export function projectIsDispatch(p: { title?: string; businessFlow?: string; detail?: string }): boolean {
  const s = [p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n').normalize('NFKC');
  return DISPATCH.some((re) => re.test(s));
}

export function hasResaleRestriction(text: string): boolean {
  const s = (text ?? '').normalize('NFKC');
  if (!s.trim()) return false;
  return RESTRICTIONS.some((re) => re.test(s));
}

export function projectBlocksResale(p: { title?: string; businessFlow?: string; detail?: string }): boolean {
  return projectIsDispatch(p) || hasResaleRestriction([p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n'));
}

export function engineerBlocksResale(e: { businessFlow?: string }, mailText: string): boolean {
  return hasResaleRestriction([e.businessFlow ?? '', mailText].join('\n'));
}

// 商流の段数（こちらから見た段数。提携先の社員・個人事業主は1段、提携先の協力会社の要員は2段、「2社先」は3段）。読めなければ null
const DEPTH_NUM = '[1一]';

// 案件が許す段数。「貴社1社先まで」→1、「2社先まで」→2。「BPの場合は支援費を相談」のように相談で可とあるときは読まない
export function projectAllowedDepth(p: { title?: string; businessFlow?: string; detail?: string }): number | null {
  const s = [p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n').normalize('NFKC');
  if (/支援費|(?:BP|協力会社|[1-3一二三]社先)[^\n。]{0,12}相談/i.test(s)) return null;
  if (/[1-3一二三]社先(?:まで)?(?:は)?(?:不可|NG|禁止|×)/.test(s)) return 0;
  if (/[2二]社先まで/.test(s)) return 2;
  if (EMPLOYEE_ONLY_1.test(s)) return 1;
  if (new RegExp(`(?:(?:貴社|御社)\\s*)?${DEPTH_NUM}社先まで`).test(s)) return 1;
  return null;
}

// 「貴社1社先の社員(または貴社直個人)まで」: 1社先まで、ただし1社先は社員だけ（他社が抱える個人事業主は出せない）
const EMPLOYEE_ONLY_1 = /[1一]社先の(?:正)?社員(?:\s*(?:まで|のみ)|[^\n。]{0,20}まで)/;

export function projectAllowsOnlyEmployeeAtDepth1(p: { title?: string; businessFlow?: string; detail?: string }): boolean {
  const s = [p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n').normalize('NFKC');
  return EMPLOYEE_ONLY_1.test(s);
}

// 要員が個人事業主・フリーランス・個人（所属の文）か
export function engineerIsIndividual(e: { businessFlow?: string }, mailText: string): boolean {
  const s = [e.businessFlow ?? '', mailText ?? ''].join('\n').normalize('NFKC');
  return /(?:所属|身分|雇用形態|契約形態|区分)[^\n]{0,10}(?:個人事業主|フリーランス|個人)|(?:弊社|自社|当社)(?:直|登録|契約)?(?:の)?(?:個人事業主|フリーランス)|^\s*(?:個人事業主|フリーランス)\s*$/m.test(s);
}

export function engineerDepth(e: { businessFlow?: string }, mailText: string): number | null {
  const s = [e.businessFlow ?? '', mailText ?? ''].join('\n').normalize('NFKC');
  if (/[2二]社先/.test(s)) return 3;
  if (new RegExp(`${DEPTH_NUM}社先|(?<![A-Za-z])BP(?![A-Za-z])|(?:協力会社|パートナー(?:企業|会社)?)(?:の|所属)?(?:社員|個人事業主|要員|エンジニア|技術者)`, 'i').test(s)) return 2;
  if (/(?:弊社|自社|当社)(?:の)?(?:正)?社員|弊社(?:プロパー|所属|個人事業主)|(?:弊社|自社|当社)(?:直|登録|契約)(?:の)?(?:個人事業主|フリーランス)/.test(s)) return 1;
  return null;
}
