// SES専用の収集ラッパー。本番=拡張email.tsをSESクエリ+添付付きで呼ぶ、demo=fixture読込。
// 処理済みID除外で未処理のみ返す（二重処理防止）。
import { collectSesRawMail } from '../collectors/email.js';
import { loadFixtureMails } from './fixtures/mails.js';
import { isDemo, sesTargetGmail } from './config.js';
import { loadProcessedMailIds } from './store.js';
import type { SesRawMail } from '../types/index.js';

export async function collectSesMail(): Promise<SesRawMail[]> {
  if (isDemo()) return loadFixtureMails(); // demoは毎回全件処理（処理済みID管理は本番のみ）

  const mails = await collectFromGmail();
  const processed = loadProcessedMailIds();
  const unprocessed = mails.filter((m) => !processed.has(m.id));
  if (unprocessed.length < mails.length) {
    console.log(`SES収集: ${mails.length - unprocessed.length}件は処理済みのためスキップ`);
  }
  return unprocessed;
}

async function collectFromGmail(): Promise<SesRawMail[]> {
  const target = sesTargetGmail();
  const targetClause = target ? ` to:${target}` : '';
  const query = `newer_than:1d -in:drafts -in:spam -in:trash${targetClause}`;
  return collectSesRawMail(query);
}
