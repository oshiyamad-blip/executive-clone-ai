// 案件・請求管理（engagements / billing / matching）ドメインの型定義
// 既存の types/index.ts（クローンAI側）とは独立して管理する

// 端数処理（契約ごとに指定。既定は切り捨て）
export type Rounding = 'floor' | 'round' | 'ceil';

// 精算条件。月額+精算幅（例: 140-180h）と時給×実稼働の2方式に対応する
export interface RateTerms {
  rateType: 'monthly' | 'hourly';
  // monthly 方式
  monthlyRate?: number; // 月額単価（税抜・円）
  lowerHours?: number; // 精算幅下限（例: 140）。未設定なら控除なしの固定
  upperHours?: number; // 精算幅上限（例: 180）。未設定なら超過なしの固定
  overtimeRate?: number; // 超過単価（円/h）。省略時は monthlyRate ÷ upperHours
  deductionRate?: number; // 控除単価（円/h）。省略時は monthlyRate ÷ lowerHours
  // hourly 方式
  hourlyRate?: number; // 時給単価（税抜・円）
}

// 案件元（クライアント）
export interface Client {
  id: string;
  name: string;
  contactPerson: string;
  billingEmail: string; // 請求書下書きの宛先
  closingDay: string; // 締め日（月末/15日/20日）
  paymentTerms: string; // 支払サイト（翌月末/翌々月末 等）
  status: string;
  note: string;
}

// 要員の区分。業務委託（法人/個人事業主）と自社正社員を1つのDBで扱う
export type MemberKind = 'contractor_corp' | 'contractor_individual' | 'employee';

// 要員（業務委託先または自社正社員）
export interface Member {
  id: string;
  name: string;
  kind: MemberKind;
  email: string; // 請求書・勤表メールの From 照合キー
  skills: string[];
  nextAvailableDate?: Date; // 手動入力の空き予定
  availabilityNote: string;
  status: string;
  // 業務委託のみ
  invoiceRegistrationNumber?: string; // T+13桁。空=免税事業者
  bankAccount?: string;
  monthlyRateHint?: number; // 単価目安（マッチング用）
  // 正社員のみ
  monthlySalary?: number; // 月額給与（円）
  costFactor?: number; // 法定福利費等の係数。空なら companyProfile の既定値
}

// 案件
export interface Project {
  id: string;
  name: string;
  clientId?: string;
  status: string; // 提案中/募集中/進行中/終了/失注
  period: { start?: Date; end?: Date };
  requiredSkills: string[];
  rateRange: { min?: number; max?: number }; // 月額・円
  headcount?: number;
  note: string;
}

// 契約形態。正社員は準委任（SES）または派遣でアサインする
export type ContractType = 'outsourcing' | 'quasi_mandate' | 'dispatch';

// アサイン（コスト側と請求側の契約条件を1レコードで持つ）
export interface Assignment {
  id: string;
  name: string;
  projectId?: string;
  memberId?: string;
  contractType: ContractType;
  period: { start?: Date; end?: Date };
  allocationPercent: number; // 稼働率（%）。掛け持ち対応。既定100
  payment?: RateTerms; // 委託先への支払条件（業務委託のみ。正社員は給与×係数がコスト）
  billing: RateTerms; // 案件元への請求条件
  rounding: Rounding;
  status: string; // 契約中/終了/更新待ち
}

// メールで届くPDFの種別。請求書（業務委託）と勤表（正社員）をLLMが判定する
export type ReceivedDocType = 'invoice' | 'timesheet';

// PDF から LLM で抽出した書類データ
export interface ExtractedDocument {
  docType: ReceivedDocType;
  issuerName: string | null; // 発行者名（請求書）または氏名（勤表）
  targetMonth: string | null; // YYYY-MM
  workedHours: number | null;
  // 請求書のみ
  invoiceNumber: string | null;
  issueDate: string | null; // YYYY-MM-DD
  subtotal: number | null; // 税抜
  taxAmount: number | null;
  totalAmount: number | null; // 税込
  invoiceRegistrationNumber: string | null; // T+13桁
  bankAccount: string | null;
  paymentDueDate: string | null; // YYYY-MM-DD
  hasTaxRateBreakdown: boolean; // 税率区分ごとの記載があるか（適格請求書要件）
  recipientName: string | null; // 宛名
}

// 検収チェックリストの1項目
export interface InvoiceChecklistItem {
  label: string;
  ok: boolean;
  detail: string;
}

export type InspectionStatus = '検収OK' | '差異あり' | '要確認';

// 検収（金額突合+記載チェック）の結果
export interface ReconciliationResult {
  status: InspectionStatus;
  expectedSubtotal: number; // 期待税抜額（契約から計算）
  expectedTax: number;
  expectedTotal: number; // 期待税込額
  diff: number; // 請求額（税込）− 検収額（税込）
  calculationNote: string; // 「140-180h、192hのため超過12h×3,888円」等の根拠
  checklist: InvoiceChecklistItem[];
}

// 稼働実績（受領請求書または勤表の検収結果）
export interface WorkRecord {
  id: string;
  title: string;
  assignmentId?: string;
  docType: ReceivedDocType;
  targetMonth: string; // YYYY-MM
  workedHours?: number;
  billedSubtotal?: number;
  billedTax?: number;
  billedTotal?: number;
  acceptedTotal?: number; // 検収金額（税込）
  status: InspectionStatus | '未検収';
  diffNote: string;
  checklistNote: string;
  invoiceNumberMatched: boolean;
  bankAccountMatched: boolean;
  paymentDueDate?: Date;
  gmailMessageId: string; // 再取込防止キー
  notionPageId?: string;
}

// 発行請求書の明細行
export interface InvoiceLine {
  description: string; // 品目（案件名 + 要員名 + 対象月）
  hours?: number;
  amount: number; // 税抜・円
  note: string; // 計算根拠
  grossProfit?: number; // 粗利（レポート用。PDFには載せない）
}

// 発行請求書のドラフト
export interface IssuedInvoiceDraft {
  invoiceNumber: string; // INV-YYYYMM-NN
  clientId: string;
  clientName: string;
  targetMonth: string; // YYYY-MM
  lines: InvoiceLine[];
  subtotal: number;
  tax: number;
  total: number;
  paymentDueDate: Date;
}

// 発行請求書のステータス遷移: 承認待ち → 承認済み → 下書き作成済 → 送付済 → 入金確認済
export type IssuedInvoiceStatus = '承認待ち' | '承認済み' | '下書き作成済' | '送付済' | '入金確認済';

// マッチング提案
export interface MatchProposal {
  memberName: string;
  projectName: string;
  direction: 'member_to_project' | 'project_to_member';
  score: number; // 1〜10
  rationale: string;
  concerns: string[];
}

// 要員×月の空き稼働（アサインから導出）
export interface ContractorAvailability {
  memberId: string;
  memberName: string;
  kind: MemberKind;
  months: Array<{ month: string; freePercent: number }>; // month: YYYY-MM
  nextAvailableDate?: Date;
  availabilityNote: string;
}

// 契約書の種別。業務委託基本契約書・個別契約書（注文書/発注書含む）・労働者派遣個別契約書
export type ContractKind = 'basic' | 'individual' | 'dispatch_individual' | 'other';

// PDFから LLM で抽出した契約書データ。アサインDBの現在値との突合原本になる
export interface ExtractedContract {
  contractKind: ContractKind;
  title: string | null; // 契約書の表題
  partyName: string | null; // 相手方の名称（自社以外）
  personName: string | null; // 対象要員名（個別契約に記載があれば）
  projectName: string | null; // 案件・業務内容の名称
  periodStart: string | null; // YYYY-MM-DD
  periodEnd: string | null;
  autoRenewal: boolean; // 自動更新条項の有無
  monthlyRate: number | null; // 月額単価（税抜・円）
  lowerHours: number | null;
  upperHours: number | null;
  overtimeRate: number | null;
  deductionRate: number | null;
  hourlyRate: number | null;
  paymentTermsNote: string | null; // 支払条件の記載（例: 翌月末払い）
  notes: string | null; // その他特記事項（再委託禁止等）
}

// 契約書とアサインDB現在値の突合ステータス
export type ContractMatchStatus = '一致' | '差異あり' | '照合不可';
