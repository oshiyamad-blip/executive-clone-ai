import '../env.js';
// メール量の測定（npm run ses:mail-stats）。本番導入の前に、共有メールボックスに届くメールの量・時間帯・添付の傾向を
// 読み取り専用で集計し、LLM費用の月額を概算する。GitHub Actions（公開リポジトリのログ）で実行する前提のため、
// 表示するのは集計値だけ（件名・アドレス・氏名・本文・ドメイン名は表示しない）。
// Xserver は受信箱を EXAMINE（読み取り専用）で開き、本文・添付は取得しない。既読などのフラグも変えない。
// LLMは使わないため、LLMの鍵が無くても本番のメールボックスを測定する（DEMO_MODE=true のときだけ fixture で集計）。
import { scanMailMetaViaMail, collectMailReady } from './mail/index.js';
import { probeImap } from './mail/xserver.js';
import { currentOwnMailPolicy, addressOf } from './mail/ownMail.js';
import { loadFixtureMails } from './fixtures/mails.js';
import { attachmentKind } from '../collectors/email.js';
import { aggregateMailStats, formatMailStats, DAY_MS } from './mailStatsReport.js';
import { setDemoOverride, demoModeExplicit, isDemo, mailProvider, statsDays, maxMailsPerRun } from './config.js';
import { safeErr } from './redact.js';
import type { SesMailMeta } from '../types/index.js';

function fixtureMetas(): SesMailMeta[] {
  return loadFixtureMails().map((m) => ({
    receivedAt: m.receivedAt,
    subject: m.subject,
    fromAddress: addressOf(m.from),
    sizeBytes: Buffer.byteLength(m.body) + m.attachments.reduce((sum, x) => sum + Math.floor((x.data.length * 3) / 4), 0),
    attachmentKinds: m.attachments.map((x) => attachmentKind(x.filename, x.mimeType)),
  }));
}

async function main(): Promise<void> {
  // LLMを使わない測定のため、LLMの鍵の有無ではなく DEMO_MODE の明示だけで demo を決める
  setDemoOverride(demoModeExplicit());
  const days = statsDays();
  const cap = maxMailsPerRun();
  console.log('=== SESメール量の測定（読み取り専用・集計値のみ表示） ===');

  let metas: SesMailMeta[];
  let until = new Date();
  if (isDemo()) {
    console.log('モード: DEMO（fixtureのメールで集計。外部接続なし）');
    metas = fixtureMetas();
    const latest = Math.max(...metas.map((m) => m.receivedAt.getTime()));
    until = new Date(latest + DAY_MS);
  } else {
    const provider = mailProvider() === 'gmail' ? 'gmail' : 'xserver';
    console.log(`メールプロバイダ: ${provider}（受信箱。本文・添付は取得しません）`);
    if (!collectMailReady()) {
      console.error(
        '❌ メールの接続設定が未完了です（xserver: XSERVER_IMAP_HOST / XSERVER_SHARED_USER / XSERVER_SHARED_PASS、gmail: SES_TARGET_GMAIL とサービスアカウント鍵）',
      );
      process.exitCode = 1;
      return;
    }
    try {
      metas = await scanMailMetaViaMail(new Date(until.getTime() - days * DAY_MS));
    } catch (err) {
      console.error(`❌ メールボックスを読めませんでした: ${safeErr(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  const stats = aggregateMailStats(metas, {
    since: new Date(until.getTime() - days * DAY_MS),
    until,
    policy: currentOwnMailPolicy(),
    cap,
  });
  for (const line of formatMailStats(stats, days, cap)) console.log(line);

  // 本番の下書き作成に使うフォルダ名の確認（フォルダ名だけを表示。初回の本番実行前に直せるように）
  if (!isDemo() && mailProvider() !== 'gmail') {
    console.log('');
    const problem = await probeImap();
    console.log(problem ? `■ 下書きフォルダ: ⚠️ ${problem}` : '■ 下書きフォルダ: ✅ XSERVER_DRAFTS_MAILBOX のフォルダが見つかりました');
  }
  console.log('');
  console.log('=== 測定完了 ===');
}

main().catch((err) => {
  console.error(`メール量の測定: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
