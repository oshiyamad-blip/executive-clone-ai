// SES専用の収集ラッパー。本番=メールプロバイダ(MAIL_PROVIDER: xserver|gmail)で共有メーリスを取得、
// demo=fixture読込。処理済みID除外で未処理のみ返す（二重処理防止）。
// 自分たちが出したメール（サマリ・自社ドメインからの紹介メール等）は取り込まない（自己ループ防止）。
// 1回に抽出する件数には上限を設け、新しい順に処理する（超過分は次回以降。収集期間内なら取りこぼさない）。
import { collectMail, collectMailReady } from './mail/index.js';
import { splitOwnMails } from './mail/ownMail.js';
import { loadFixtureMails } from './fixtures/mails.js';
import { isDemo, requireLive, maxMailsPerRun } from './config.js';
import { loadProcessedMailIds } from './store.js';
import { recordHealEvent } from './heal/events.js';
import { SafeLogError } from './redact.js';
import type { SesRawMail } from '../types/index.js';

export interface CollectResult {
  mails: SesRawMail[]; // 今回抽出する未処理メール（新しい順・上限内）
  excludedMailIds: string[]; // 自分たちのメールとして除外した分（処理済み「除外」として記録する）
  deferred: number; // 上限超過で次回以降に回した件数
}

export async function collectSesMail(): Promise<CollectResult> {
  // demoは毎回fixture全件を処理（処理済みID管理・自己メール除外は本番のみ）
  if (isDemo()) return { mails: loadFixtureMails(), excludedMailIds: [], deferred: 0 };

  if (!collectMailReady()) {
    const message = 'メール収集の設定（MAIL_PROVIDER に応じた XSERVER_* または SES_TARGET_GMAIL と Google認証）が未完了です';
    // スケジュール実行で設定漏れのまま「0件で正常終了」を繰り返さないよう、CIでは収集失敗として扱う
    if (requireLive()) throw new SafeLogError(`SES収集: ${message}`);
    console.warn(`SES収集: ${message} — 収集をスキップします`);
    return { mails: [], excludedMailIds: [], deferred: 0 };
  }

  // 処理済みIDの読み込み失敗は例外のまま（空集合で続行すると収集期間の全メールを再抽出してしまうため）
  const processed = await loadProcessedMailIds();
  const fetched = await collectMail((id) => processed.has(id));
  const unprocessed = fetched.filter((m) => !processed.has(m.id));

  const own = splitOwnMails(unprocessed);
  const excludedTotal = own.excluded.length;
  if (excludedTotal > 0) {
    console.log(
      `SES収集: 自分たちのメール${excludedTotal}件を除外（送信元が本バッチ${own.counts.self}件・サマリ/修復レポート${own.counts.report}件・自社ドメイン${own.counts.ownDomain}件）`,
    );
  }

  const sorted = [...own.kept].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const limit = maxMailsPerRun();
  const deferred = Math.max(0, sorted.length - limit);
  if (deferred > 0) {
    recordHealEvent(
      'warn',
      `未処理メールが${sorted.length}件あり、1回の上限（SES_MAX_MAILS_PER_RUN=${limit}）を超えた古い${deferred}件を次回以降に回しました`,
    );
  }
  return { mails: sorted.slice(0, limit), excludedMailIds: own.excluded.map((m) => m.id), deferred };
}
