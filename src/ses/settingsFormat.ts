// 設定値の書式の検査（純関数）。事前確認（npm run ses:preflight）・診断（npm run doctor）・担当者メールの検証で共有する。
// 値そのものはどこにも表示しない前提で、結果は「形式OKか」と固定文言の理由だけを返す。

// 表示名付き・複数アドレス・空白や改行を含む値は受け付けない（メールヘッダへの混入を防ぐため厳しめ）
const PLAIN_EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isPlainEmailAddress(email: string): boolean {
  return email.length <= 254 && PLAIN_EMAIL_RE.test(email);
}

const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?:${HOST_LABEL}\\.)+[A-Za-z]{2,63}$`);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// ドメイン名（例: example.co.jp）
export function looksLikeDomain(s: string): boolean {
  return s.length <= 253 && DOMAIN_RE.test(s);
}

// 接続先ホスト名（例: svXXXX.xserver.jp）。https:// やポート番号・パスを含む値は不可
export function looksLikeHostname(s: string): boolean {
  return looksLikeDomain(s) || IPV4_RE.test(s);
}

// Google ドライブのファイル・フォルダID（config 側でURLからIDを取り出した後の値。共有ドライブのIDは19文字前後）
export function looksLikeGoogleId(s: string): boolean {
  return /^[A-Za-z0-9_-]{15,}$/.test(s);
}

// Notion のデータベースID（32桁の16進。ハイフン区切りも可）
export function looksLikeNotionId(s: string): boolean {
  return /^[0-9a-f]{32}$/i.test(s.replace(/-/g, ''));
}

// カンマ区切りの宛先（"表示名 <addr>" も可）のうち、メールアドレスとして解釈できないものの件数
export function invalidAddressCount(list: string): { total: number; invalid: number } {
  const items = list
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const invalid = items.filter((x) => !isPlainEmailAddress((x.match(/<([^>]+)>/)?.[1] ?? x).trim())).length;
  return { total: items.length, invalid };
}

export interface ServiceAccountInspection {
  clientEmail: string; // 解釈できたときのみ（表示するかは呼び出し側がログ秘匿設定で決める）
  problems: string[]; // これがあると認証できない
  notes: string[]; // 認証はできる見込みだが確認を勧める点
}

// サービスアカウントのJSON鍵（GCPでダウンロードした .json の中身）を検査する
export function inspectServiceAccountJson(raw: string): ServiceAccountInspection {
  const result: ServiceAccountInspection = { clientEmail: '', problems: [], notes: [] };
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    o = parsed as Record<string, unknown>;
  } catch {
    const t = raw.trim();
    result.problems.push(
      /^[A-Za-z0-9+/=\s]+$/.test(t)
        ? 'JSONとして読めません（base64などに変換せず、.json ファイルの中身をそのまま貼り付けてください）'
        : t.startsWith('{')
          ? 'JSONとして読めません（途中で切れていないか、{ から } まで全体をコピーしたか確認してください）'
          : 'JSONとして読めません（.json ファイルの中身をそのまま貼り付けてください）',
    );
    return result;
  }
  const email = typeof o.client_email === 'string' ? o.client_email.trim() : '';
  const key = typeof o.private_key === 'string' ? o.private_key : '';
  if (!email) result.problems.push('client_email がありません');
  else if (!isPlainEmailAddress(email)) result.problems.push('client_email がメールアドレスの形式ではありません');
  else result.clientEmail = email;
  if (!key) result.problems.push('private_key がありません');
  else if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
    result.problems.push('private_key の形式が正しくありません（-----BEGIN PRIVATE KEY----- から始まる鍵全体が必要です）');
  }
  if (o.type !== 'service_account') {
    result.notes.push('type が service_account ではありません（OAuthクライアントではなく、サービスアカウントの鍵を使ってください）');
  }
  if (result.clientEmail && !result.clientEmail.endsWith('.gserviceaccount.com')) {
    result.notes.push('client_email がサービスアカウントのアドレス（…gserviceaccount.com）ではありません');
  }
  return result;
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

function isInternalDomain(domain: string, internalDomains: string[]): boolean {
  return internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// サマリの宛先（SES_NOTIFY_TO）を社内のドメインのものと社外のものに分ける（純関数）。
// 社外（個人のGmail・打ち間違えたドメイン等）には、allowExternal のときだけ送る
export function splitNotifyRecipients(list: string, internalDomains: string[], allowExternal: boolean): { recipients: string[]; external: number } {
  const addresses = list
    .split(',')
    .map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase())
    .filter((x) => isPlainEmailAddress(x));
  const external = addresses.filter((a) => !isInternalDomain(domainOfAddress(a), internalDomains));
  return { recipients: allowExternal ? addresses : addresses.filter((a) => !external.includes(a)), external: external.length };
}

export interface PricingPolicyCheckInput {
  onActions: boolean;
  production: boolean; // 本番の保存先（DB_PROVIDER=sheets）で動かす
  jsonSet: boolean;
  problems: string[];
  nonceOk: boolean;
  legacyPresent: string[]; // 値のある個別の設定の名前
  marginConfigured: boolean;
  negotiationEnabled: boolean;
  negotiationConfigured: boolean;
}

// 価格の方針（粗利下限・交渉幅）の設定の問題（純関数。値を含まない固定の文言）。1件でもあれば本番を止める
export function pricingPolicyProblems(o: PricingPolicyCheckInput): string[] {
  const out = [...o.problems];
  if (o.onActions && o.legacyPresent.length > 0) {
    out.push(
      `価格の方針が個別の設定（${o.legacyPresent.join('・')}）で渡されています。短い数値の Secret は公開ログ全体で伏せ字になり、` +
        '伏せ字の位置から値が分かるため、SES_PRICING_POLICY_JSON の1つにまとめ、個別の Secrets は削除してください',
    );
  }
  if (o.onActions && o.jsonSet && !o.nonceOk) {
    out.push('SES_PRICING_POLICY_JSON に推測できない乱数の項目 "n"（16文字以上）を含めてください（伏せ字から値を当てられないように）');
  }
  if (o.production && !o.marginConfigured) {
    out.push('粗利下限が未設定です（公開されている既定値のまま動かさないよう、SES_PRICING_POLICY_JSON の minGrossMarginMan を登録してください）');
  }
  if (o.production && o.negotiationEnabled && !o.negotiationConfigured) {
    out.push(
      '交渉幅（projectRaiseMaxMan・engineerCutMaxMan）が未設定です（公開されている既定値のまま動かさないよう登録するか、ENABLE_NEGOTIATION=false にしてください）',
    );
  }
  return out;
}

// Gemini を Google AI Studio の API キーで本番に使うときの問題（純関数）。無料枠は送った内容（メール本文・スキルシート）が
// 品質改善・人による確認に使われ得るため、課金を有効にしてデータの利用条件を確認したことの明示を求める
export function geminiDataUseProblem(o: { provider: string; vertex: boolean; acknowledged: boolean; production: boolean }): string | null {
  if (o.provider !== 'gemini' || o.vertex || o.acknowledged || !o.production) return null;
  return (
    'LLM_PROVIDER=gemini（Google AI Studio の API キー）では、メール本文・添付・社員のスキルシートを送ります。' +
    '課金を有効にしたプロジェクトでデータの利用条件を確認したうえで SES_ALLOW_GEMINI_API=paid を設定してください（無料枠では使いません）'
  );
}
