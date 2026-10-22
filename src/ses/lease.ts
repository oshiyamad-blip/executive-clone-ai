// 同時に動く実行を1つに限る印（スプレッドシート「_状態」タブの batchLease）の共通処理。
// 定時実行（GitHub Actions）と手元の実行が重なると、同じメールの抽出・同じ依頼の下書き・同じ行の追記を二重に行うため、
// Sheets運用では DB に書く本番の実行（バッチ・自社社員探し）はすべてこの印を取ってから動く
import { isDemo, dbProvider, runDeadlineMinutes, sesAllowUnleased } from './config.js';
import { sheetsDbConfigured, acquireBatchLeaseSheets, releaseBatchLeaseSheets } from '../database/sheets.js';
import { safeErr } from './redact.js';

// 実行中の印の期限。ジョブの制限時間（40分）を含む長さにする（打ち切られた実行の印は期限で無効になる）
const LEASE_EXTRA_MINUTES = 30;

// 印を使えない本番（Sheets運用でない）で動いてよいか。だめなら理由（日本語）
export function unleasedLiveProblem(o: { demo: boolean; dbProvider: string; sheetsConfigured: boolean; allowUnleased: boolean }): string | null {
  if (o.demo || (o.dbProvider === 'sheets' && o.sheetsConfigured) || o.allowUnleased) return null;
  return (
    'DB_PROVIDER=sheets（スプレッドシートの実行中の印）以外の本番の実行では、同時に動く別のバッチ（定時実行等）と共有の受信箱・' +
    '下書きを二重に処理してしまうため、この実行では何もしませんでした。定時実行と重ならない単独の運用で意図して使う場合は ' +
    'SES_ALLOW_UNLEASED=true を設定してください'
  );
}

export function currentUnleasedLiveProblem(): string | null {
  return unleasedLiveProblem({ demo: isDemo(), dbProvider: dbProvider(), sheetsConfigured: sheetsDbConfigured(), allowUnleased: sesAllowUnleased() });
}

export type LeaseOutcome = { ok: true; token: string } | { ok: false; reason: string };

// 印を取る。印を使わない実行（demo・Sheets運用でないことを明示した実行）は token ''
export async function acquireRunLease(): Promise<LeaseOutcome> {
  const problem = currentUnleasedLiveProblem();
  if (problem) return { ok: false, reason: problem };
  if (isDemo() || dbProvider() !== 'sheets' || !sheetsDbConfigured()) return { ok: true, token: '' };
  try {
    const r = await acquireBatchLeaseSheets((runDeadlineMinutes() + LEASE_EXTRA_MINUTES) * 60_000);
    if (r.ok) return { ok: true, token: r.token };
    return {
      ok: false,
      reason:
        `別のバッチが実行中のため、この実行では何もしませんでした（その実行の印の期限: ${r.until}）。` +
        '前回の実行が打ち切られた場合は、期限を過ぎれば次の実行から動きます（急ぐ場合はスプレッドシート「_状態」タブの batchLease の行を消してください）',
    };
  } catch (err) {
    console.error(`SES: 実行中の印を確かめられません: ${safeErr(err)}`);
    return { ok: false, reason: '実行中の印（スプレッドシート「_状態」タブ）を確かめられないため、この実行では何もしませんでした（共有・見出しを確認してください）' };
  }
}

export async function releaseRunLease(token: string): Promise<void> {
  if (!token) return;
  try {
    await releaseBatchLeaseSheets(token);
  } catch (err) {
    console.error(`SES: 実行中の印を外せません（期限を過ぎれば次の実行から動きます）: ${safeErr(err)}`);
  }
}
