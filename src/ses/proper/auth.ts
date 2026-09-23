// プロパー（スキルシートのDriveフォルダ・管理表「プロパー管理」）へ接続するGoogle認証。
// 既定はメインのサービスアカウント（同じWorkspace内でフォルダと管理表をSAに共有する運用）。
// 別テナントに置く場合は、そのテナントが持つ専用のサービスアカウント（PROPER_GOOGLE_SA_*）を使う。
// 共有できない場合の PROPER_GOOGLE_IMPERSONATE（DWDのなりすまし）は、専用の鍵と組み合わせたときだけ使う
// （メインの鍵で別テナントをDWDさせると、その鍵を持つ者が別テナントの全ユーザーのDriveを読めてしまうため）。
// 鍵・アドレスはログに出さない。
import { getServiceAccountAuth, loadServiceAccountCredentials } from '../../collectors/googleAuth.js';
import { properImpersonate, properServiceAccountEnvPrefix } from '../config.js';

export function properUsesDedicatedAccount(): boolean {
  return loadServiceAccountCredentials(properServiceAccountEnvPrefix()) !== null;
}

// なりすましの指定がメインの鍵と組み合わさっている（使わない設定）か
export function properImpersonationRefused(): boolean {
  return Boolean(properImpersonate()) && !properUsesDedicatedAccount();
}

let warnedRefused = false;

// 設定不足・使えない組み合わせなら null（呼び出し側で縮退）
export function properGoogleAuth(scopes: string[]): ReturnType<typeof getServiceAccountAuth> {
  const dedicated = loadServiceAccountCredentials(properServiceAccountEnvPrefix());
  if (properImpersonate() && !dedicated) {
    if (!warnedRefused) {
      warnedRefused = true;
      console.warn(
        'プロパー: PROPER_GOOGLE_IMPERSONATE はプロパー専用のサービスアカウント（PROPER_GOOGLE_SA_KEY_JSON）と組み合わせたときだけ使います' +
          '（メインの鍵でのなりすましは行いません）',
      );
    }
    return null;
  }
  return getServiceAccountAuth(scopes, properImpersonate() || undefined, dedicated ?? undefined);
}

// 接続できないときの確認事項（どのアカウントに共有すべきかを、アドレスを出さずに示す）
export function properAccessHint(): string {
  if (properImpersonationRefused()) {
    return 'PROPER_GOOGLE_IMPERSONATE を使う場合は PROPER_GOOGLE_SA_KEY_JSON（そのテナントのサービスアカウント）も設定してください';
  }
  if (properImpersonate()) return 'PROPER_GOOGLE_IMPERSONATE のユーザーが閲覧・編集でき、DWDでスコープが委任済みかを確認してください';
  const account = properUsesDedicatedAccount() ? 'プロパー用サービスアカウント（PROPER_GOOGLE_SA_*）' : 'メインのサービスアカウント';
  return `${account}のメールアドレス（JSON鍵の client_email）に共有済みかを確認してください`;
}
