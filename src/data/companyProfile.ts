// 自社マスタ（手動登録） — 案件元への請求書発行フローで使う自社情報の単一の真実の源。
//
// executiveProfile.ts の前例に従い、コード内の定数として管理する
// （Notion側に置くと請求書PDF・メール文面の生成のたびに参照が必要になり、
//  かつ機微度が高いため、環境変数で上書きしつつコードに手動登録する方式を踏襲）。
//
// ⚠️ ここはサンプル値です。実際の自社情報（インボイス登録番号・振込先等）に置き換えてください。
export interface CompanyProfile {
  companyName: string;
  address: string;
  invoiceRegistrationNumber: string; // 自社の適格請求書発行事業者登録番号（T+13桁）
  bankAccount: string; // 振込先の説明文字列（銀行名・支店名・口座種別・口座番号・口座名義）
  emailSubjectTemplate: string; // {company}{month} 等のプレースホルダを含む
  emailBodyTemplate: string; // {contact}{company}{month} 等のプレースホルダを含む
  taxRate: number; // 消費税率（10% = 0.10）
  defaultEmployeeCostFactor: number; // 正社員コストの既定係数（法定福利費等見込み）。Member.costFactor 未設定時に使用
}

export const COMPANY_PROFILE: CompanyProfile = {
  companyName: process.env.COMPANY_NAME ?? '株式会社サンプル',
  address: process.env.COMPANY_ADDRESS ?? '東京都千代田区丸の内1-1-1 サンプルビル10F',
  invoiceRegistrationNumber: process.env.COMPANY_INVOICE_REGISTRATION_NUMBER ?? 'T1234567890123',
  bankAccount:
    process.env.COMPANY_BANK_ACCOUNT ??
    'サンプル銀行 東京支店 普通 1234567 カ）サンプル',

  emailSubjectTemplate: '【{company}】{month}月分請求書のご送付',

  emailBodyTemplate: `{contact} 様

平素より大変お世話になっております。
{company}でございます。

{month}月分の請求書を作成いたしましたので、添付にてお送りいたします。
ご査収のほど、何卒よろしくお願い申し上げます。

ご不明な点がございましたら、お気軽にお問い合わせください。
今後ともよろしくお願いいたします。

--
{company}
{address}`,

  taxRate: 0.1,
  defaultEmployeeCostFactor: 1.15,
};

// テンプレート文字列内の {key} を vars[key] に置換する。未知のプレースホルダはそのまま残す。
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}
