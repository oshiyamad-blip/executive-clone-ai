// 外部マッチ: 商流・再委託の条件で、別の会社へ紹介できない案件・要員を外す。
// 迷うときは外す側に倒す（誤って転売不可の人・案件を他社へ紹介するほうが、見送るより損が大きい）。
// 「1社先まで」だけの記載（1段までは可）は外さない。「貴社1社先まで」も同じ

const WHO = '(?:の)?(?:正社員|社員|従業員|所属|プロパー|雇用)?(?:の方|様)?';

const RESTRICTIONS: RegExp[] = [
  // 再委託・再々委託・転売・再提案が不可
  /再[再々]?委託(?:は)?(?:不可|禁止|NG|×|できません|できない|不可能|なし|無し|制限)/,
  /(?:転売|再提案|他社(?:への)?(?:提案|紹介|開示)|二次請け|二次受け|2次請け|2次受け|下請け)(?:は|以降は|以降)?(?:不可|禁止|NG|×|できません)/,
  // 貴社まで・貴社社員まで・貴社正社員まで・貴社所属まで・弊社まで・御社まで
  new RegExp(`(?:貴社|御社)${WHO}(?:まで|のみ|限定|に限り|に限る)`),
  // 弊社・当社は「ご連絡は弊社まで」と区別するため、社員・所属などが付くときだけ
  /(?:弊社|当社|自社)(?:の)?(?:正社員|社員|従業員|所属|プロパー)(?:の方|様)?(?:まで|のみ|限定|に限り|に限る)/,
  // プロパーのみ・自社社員のみ・正社員のみ
  /(?:プロパー|正社員)(?:社員)?(?:の方)?(?:のみ|限定|まで|必須|に限る)/,
  // 1社先まで不可（「1社先まで」だけなら許可の記載なので当たらない）
  /[0-9一二三]社先(?:まで)?(?:は)?(?:不可|NG|禁止|×)/,
  // エンド直のみ
  /エンド(?:直|直接)(?:契約|取引|請け)?(?:のみ|限定|まで|希望)/,
  /直(?:請け|契約|取引)(?:のみ|限定)/,
  // 商流の制限あり（「制限なし」は当たらない）
  /商流(?:に)?制限(?![：:\s]*(?:なし|無し|ありません))/,
];

export function hasResaleRestriction(text: string): boolean {
  const s = (text ?? '').normalize('NFKC');
  if (!s.trim()) return false;
  return RESTRICTIONS.some((re) => re.test(s));
}

export function projectBlocksResale(p: { title?: string; businessFlow?: string; detail?: string }): boolean {
  return hasResaleRestriction([p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n'));
}

export function engineerBlocksResale(e: { businessFlow?: string }, mailText: string): boolean {
  return hasResaleRestriction([e.businessFlow ?? '', mailText].join('\n'));
}
