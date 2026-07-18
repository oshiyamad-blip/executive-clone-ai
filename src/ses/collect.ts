// SES専用の収集ラッパー。本番=メールプロバイダ(MAIL_PROVIDER: xserver|gmail)で共有メーリスを取得、
// demo=fixture読込。処理済みID除外で未処理のみ返す（二重処理防止）。
import { collectMail } from './mail/index.js';
import { loadFixtureMails } from './fixtures/mails.js';
import { isDemo } from './config.js';
import { loadProcessedMailIds } from './store.js';
import type { SesRawMail } from '../types/index.js';

export async function collectSesMail(): Promise<SesRawMail[]> {
  if (isDemo()) return loadFixtureMails(); // demoは毎回全件処理（処理済みID管理は本番のみ）

  const mails = await collectMail();
  const processed = loadProcessedMailIds();
  const unprocessed = mails.filter((m) => !processed.has(m.id));
  if (unprocessed.length < mails.length) {
    console.log(`SES収集: ${mails.length - unprocessed.length}件は処理済みのためスキップ`);
  }
  return unprocessed;
}
