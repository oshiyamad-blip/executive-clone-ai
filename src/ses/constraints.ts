// 案件の商流メモ・条件の文から、参画条件（外国籍・所属の深さ・個人事業主）を読む（LLM を使わない）。
// 実メールでは案件の約9割にこれらの条件が書かれている。判定の確認事項と、パートナー要員の即NG判定に使う
export type ForeignerRule = 'ok' | 'ng' | 'conditional' | 'unknown';
export type SoleRule = 'ok' | 'ng' | 'unknown';

export interface FlowConstraints {
  foreigner: ForeignerRule;
  // 自社から見て何社先の所属まで受け入れるか（貴社社員まで=0、貴社1社先まで=1、不問・不明=null）
  maxHops: number | null;
  soleProprietor: SoleRule;
}

export function flowConstraints(text: string): FlowConstraints {
  const s = text.normalize('NFKC').slice(0, 4000);
  let foreigner: ForeignerRule = 'unknown';
  if (/外国籍[\s】\]:：]*(?:不可|NG|ng|×|お断り)|日本国籍(?:のみ|限定|の方)|国籍[\s】\]:：]*日本|日本人(?:のみ|限定)/.test(s)) foreigner = 'ng';
  else if (/外国籍[^\n]{0,20}(?:N1|N2|ネイティブ|日本語[^\n]{0,6}(?:流暢|ビジネス))|外国籍[\s】\]:：]*(?:可|OK|ok)[^\n]{0,4}[（(][^）)]{0,20}(?:N1|N2|日本語)/.test(s)) foreigner = 'conditional';
  else if (/外国籍[\s】\]:：]*(?:可|OK|ok|○|歓迎)/.test(s)) foreigner = 'ok';

  let maxHops: number | null = null;
  if (/商流(?:制限)?[\s:：]*不問/.test(s)) maxHops = null;
  else if (/(?:貴社|御社)[のの]?\s*(?:1|一)\s*社(?:先|下)/.test(s)) maxHops = 1;
  else if (/(?:貴社|御社)\s*(?:正?社員|所属|プロパー)\s*(?:まで|のみ|限定)/.test(s)) maxHops = 0;

  let soleProprietor: SoleRule = 'unknown';
  if (/(?:個人事業主|フリーランス)[\s:：]*(?:不可|NG|ng|×|お断り)/.test(s)) soleProprietor = 'ng';
  else if (/(?:個人事業主|フリーランス)[\s:：]*(?:可|OK|ok|○)/.test(s)) soleProprietor = 'ok';

  return { foreigner, maxHops, soleProprietor };
}

// 要員の所属の深さ（自社から見て何社先か）。自社社員（プロパー）は0、パートナーの社員は1
export function hopsOf(affiliation: 'proper' | 'partner' | undefined): number {
  return affiliation === 'partner' ? 1 : 0;
}

// 商流の条件に反するか（true=即NG）。所属が分からない要員は判定しない
export function violatesHops(c: FlowConstraints, affiliation: 'proper' | 'partner' | undefined): boolean {
  return c.maxHops !== null && hopsOf(affiliation) > c.maxHops;
}
