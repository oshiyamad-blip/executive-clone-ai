// SES専用の収集ラッパー。本番=メールプロバイダ(MAIL_PROVIDER: xserver|gmail)で共有メーリスを取得、
// demo=fixture読込。処理済みID除外で未処理のみ返す（二重処理防止）。
// 自分たちが出したメール（サマリ・自社ドメインからの紹介メール等）は取り込まない（自己ループ防止）。
// 1回に本文を取得する件数には上限（SES_MAX_FETCH_PER_RUN）を設ける。LLM で抽出する件数の上限は、再送・要員メールを
// 除いた後に index.ts で掛ける（超過分は次回以降。窓を外れて処理できなくなる分は異常終了として知らせる）。
import { collectMail, collectMailReady } from './mail/index.js';
import { splitOwnMails, messageIdMailId, currentOwnMailPolicy } from './mail/ownMail.js';
import { loadFixtureMails } from './fixtures/mails.js';
import { isDemo, requireLive, maxFetchPerRun, collectDays } from './config.js';
import { loadProcessedMailIds } from './store.js';
import { recordHealEvent, recordFatal } from './heal/events.js';
import { orderForRun, isLastChance } from './schedule.js';
import { SafeLogError } from './redact.js';
import type { SesRawMail } from '../types/index.js';

export interface CollectResult {
  mails: SesRawMail[]; // 今回抽出する未処理メール（処理する順・上限内）
  excludedMailIds: string[]; // 自分たちのメールとして除外した分（処理済み「除外」として記録する）
  unparsableMailIds?: string[]; // 原文を解析できなかった分（処理済み「解析不可」として記録する。毎回解析し直さない）
  deferred: number; // 上限超過で次回以降に回した件数
}

export async function collectSesMail(now = new Date()): Promise<CollectResult> {
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
  const limit = maxFetchPerRun();
  const fetched = await collectMail((id) => processed.has(id), { limit, now });
  const unprocessed = fetched.mails.filter((m) => !processed.has(m.id));

  // 取り込み済み（処理済み）のメールへの社内からの返信を References で見分ける（Xserver 経路のIDは Message-ID から作るため）
  const own = splitOwnMails(unprocessed, currentOwnMailPolicy(), (mid) => {
    const id = messageIdMailId(mid);
    return id !== '' && processed.has(id);
  });
  const excludedTotal = own.excluded.length;
  if (excludedTotal > 0) {
    console.log(
      `SES収集: 自分たちのメール${excludedTotal}件を除外（送信元が本バッチ${own.counts.self}件・サマリ/修復レポート${own.counts.report}件・自社ドメイン${own.counts.ownDomain}件・社内からの返信${own.counts.ownReply}件）`,
    );
  }

  const deferred = fetched.deferred.length;
  if (deferred > 0) {
    recordHealEvent(
      'warn',
      `未処理メールが1回の取得の上限（SES_MAX_FETCH_PER_RUN=${limit}）を超えたため、${deferred}件を次回以降に回しました`,
    );
    const lost = fetched.deferred.filter((receivedAt) => isLastChance(receivedAt, collectDays(), now)).length;
    if (lost > 0) {
      recordFatal(
        `上限を超えて次回以降に回したメールのうち${lost}件は、次回の実行時には収集期間（SES_COLLECT_DAYS）を外れて処理されません` +
          '（SES_MAX_FETCH_PER_RUN を上げるか、SES_COLLECT_DAYS をそのメールが収まる日数まで広げて手動で再実行してください）',
      );
    }
  }
  return {
    mails: orderForRun(own.kept, collectDays(), now),
    excludedMailIds: own.excluded.map((m) => m.id),
    unparsableMailIds: (fetched.unparsable ?? []).filter((id) => !processed.has(id)),
    deferred,
  };
}
