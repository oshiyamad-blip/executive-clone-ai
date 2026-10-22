// プロパー（スキルシートのDriveフォルダ・管理表「プロパー管理」）へ接続するGoogle認証。
// 既定はメインのサービスアカウント（同じWorkspace内でフォルダと管理表をSAに共有する運用）。
// 別テナントに置く場合は、そのテナントが持つ専用のサービスアカウント（PROPER_GOOGLE_SA_*）を使う。
// 共有できない場合の PROPER_GOOGLE_IMPERSONATE（DWDのなりすまし）は、専用の鍵と組み合わせたときだけ使う
// （メインの鍵で別テナントをDWDさせると、その鍵を持つ者が別テナントの全ユーザーのDriveを読めてしまうため）。
// 専用の鍵がメインの鍵と同じ（同じ client_email・同じ秘密鍵）なら専用とみなさない。
// 管理表をメインのテナントに置く（PROPER_MASTER_IN_MAIN_TENANT=true）場合は、管理表だけメインの鍵で書く
// （別テナントに spreadsheets の委任を与えずに済む）。鍵・アドレスはログに出さない。
import { getServiceAccountAuth } from '../../collectors/googleAuth.js';
import { properImpersonate, properServiceAccountEnvPrefix, properMasterInMainTenant } from '../config.js';
import { dedicatedCredentials, sesMainAuth, type SesGoogleAuth } from '../googleCreds.js';

export function properUsesDedicatedAccount(): boolean {
  const d = dedicatedCredentials(properServiceAccountEnvPrefix());
  return d.creds !== null && !d.sharesMain;
}

// 専用として設定された鍵がメインの鍵と同じか（使わない設定）
export function properKeySharesMain(): boolean {
  return dedicatedCredentials(properServiceAccountEnvPrefix()).sharesMain;
}

// なりすましの指定がメインの鍵と組み合わさっている（使わない設定）か
export function properImpersonationRefused(): boolean {
  return Boolean(properImpersonate()) && !properUsesDedicatedAccount();
}

let warnedRefused = false;

// 設定不足・使えない組み合わせなら null（呼び出し側で縮退）
export function properGoogleAuth(scopes: string[]): SesGoogleAuth | null {
  const d = dedicatedCredentials(properServiceAccountEnvPrefix());
  const dedicated = d.creds && !d.sharesMain ? d.creds : null;
  if (properImpersonate() && !dedicated) {
    if (!warnedRefused) {
      warnedRefused = true;
      console.warn(
        'プロパー: PROPER_GOOGLE_IMPERSONATE はプロパー専用のサービスアカウント（PROPER_GOOGLE_SA_KEY_JSON。メインとは別の鍵）と組み合わせたときだけ使います' +
          '（メインの鍵でのなりすましは行いません）',
      );
    }
    return null;
  }
  if (!dedicated) return sesMainAuth(scopes);
  return getServiceAccountAuth(scopes, properImpersonate() || undefined, dedicated);
}

// 管理表「プロパー管理」の読み書きの認証
export function properMasterAuth(scopes: string[]): SesGoogleAuth | null {
  return properMasterInMainTenant() ? sesMainAuth(scopes) : properGoogleAuth(scopes);
}

// 接続できないときの確認事項（どのアカウントに共有すべきかを、アドレスを出さずに示す）
export function properAccessHint(): string {
  if (properImpersonationRefused()) {
    return 'PROPER_GOOGLE_IMPERSONATE を使う場合は PROPER_GOOGLE_SA_KEY_JSON（そのテナントのサービスアカウント。メインとは別の鍵）も設定してください';
  }
  if (properImpersonate()) return 'PROPER_GOOGLE_IMPERSONATE のユーザーが閲覧・編集でき、DWDでスコープが委任済みかを確認してください';
  const account = properUsesDedicatedAccount() ? 'プロパー用サービスアカウント（PROPER_GOOGLE_SA_*）' : 'メインのサービスアカウント';
  return `${account}のメールアドレス（JSON鍵の client_email）に共有済みかを確認してください`;
}
