// プロパー（スキルシートのDriveフォルダ・管理表「プロパー管理」）へ接続するGoogle認証。
// 既定はメインのサービスアカウント（同じWorkspace内でフォルダと管理表をSAに共有する運用）。
// 別テナントに置く場合は PROPER_GOOGLE_SA_* で専用の鍵を、共有できない場合は PROPER_GOOGLE_IMPERSONATE で
// DWDのなりすまし先を指定する。鍵・アドレスはログに出さない。
import { getServiceAccountAuth, loadServiceAccountCredentials } from '../../collectors/googleAuth.js';
import { properImpersonate, properServiceAccountEnvPrefix } from '../config.js';

export function properUsesDedicatedAccount(): boolean {
  return loadServiceAccountCredentials(properServiceAccountEnvPrefix()) !== null;
}

// 設定不足なら null（呼び出し側で縮退）
export function properGoogleAuth(scopes: string[]): ReturnType<typeof getServiceAccountAuth> {
  const dedicated = loadServiceAccountCredentials(properServiceAccountEnvPrefix());
  return getServiceAccountAuth(scopes, properImpersonate() || undefined, dedicated ?? undefined);
}

// 接続できないときの確認事項（どのアカウントに共有すべきかを、アドレスを出さずに示す）
export function properAccessHint(): string {
  if (properImpersonate()) return 'PROPER_GOOGLE_IMPERSONATE のユーザーが閲覧・編集でき、DWDでスコープが委任済みかを確認してください';
  const account = properUsesDedicatedAccount() ? 'プロパー用サービスアカウント（PROPER_GOOGLE_SA_*）' : 'メインのサービスアカウント';
  return `${account}のメールアドレス（JSON鍵の client_email）に共有済みかを確認してください`;
}
