// 自己修復レイヤーのオフライン自己検証（npm run ses:heal:check）。外部API呼び出しゼロ。
// 円換算・予算メーター・隔離ラウンドトリップ・エラー分類・PIIマスクを検証する。
import { usageCostJpy, jpyPerUsd } from '../../llm/pricing.js';
import { isRetryableLlmError } from './retry.js';
import { maskPii, recordFailure, recordSuccess, listQuarantined } from './quarantine.js';
import { resetHealEvents, recordStat, getStats } from './events.js';
import type { SesRawMail } from '../../types/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function fakeMail(id: string): SesRawMail {
  return {
    id,
    from: 'test@example.jp',
    to: 'sales@example.jp',
    cc: '',
    subject: 'テスト 090-1234-5678',
    body: '',
    messageIdHeader: '',
    references: '',
    receivedAt: new Date(),
    attachments: [],
    sheetLinks: [],
  };
}

function main(): void {
  console.log('=== SES自己修復レイヤー 自己検証 ===');

  // 1. 円換算（Haiku: $1/$5 per MTok）
  const rate = jpyPerUsd();
  const haikuCost = usageCostJpy({ model: 'claude-haiku-4-5', inputTokens: 10000, outputTokens: 2000 });
  check(
    '円換算: Haiku 10K入力+2K出力',
    near(haikuCost, ((10000 * 1 + 2000 * 5) / 1_000_000) * rate),
    `got ${haikuCost}`,
  );
  const sonnetCost = usageCostJpy({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 });
  check('円換算: Sonnet 1MTok入力 = 3USD相当', near(sonnetCost, 3 * rate), `got ${sonnetCost}`);

  // 2. エラー分類（400/401/403/404は再試行しない、429/529/その他は再試行）
  check('分類: 400は再試行しない', !isRetryableLlmError({ status: 400 }));
  check('分類: 401は再試行しない', !isRetryableLlmError({ status: 401 }));
  check('分類: 429は再試行する', isRetryableLlmError({ status: 429 }));
  check('分類: 529は再試行する', isRetryableLlmError({ status: 529 }));
  check('分類: ネットワーク例外は再試行する', isRetryableLlmError(new Error('ECONNRESET')));

  // 3. PIIマスク
  const masked = maskPii('連絡先: taro.suzuki+ses@example.co.jp / 090-1234-5678');
  check('PIIマスク: メールアドレス', !masked.includes('@example.co.jp') && masked.includes('<メールアドレス>'));
  check('PIIマスク: 電話番号', !masked.includes('090-1234-5678') && masked.includes('<電話番号>'));

  // 4. 隔離ラウンドトリップ（SES_HEAL_DATA_DIR は呼び出し側でscratchに向ける）
  const mail = fakeMail(`selftest_${process.pid}`);
  recordFailure(mail, new Error('test1'));
  recordFailure(mail, new Error('test2'));
  const third = recordFailure(mail, new Error('test3 to quarantine taro@example.jp'));
  check('隔離: 3回目の失敗で隔離される（既定 SES_HEAL_MAX_ATTEMPTS=3）', third.quarantined && third.attempts === 3);
  const q = listQuarantined().find((e) => e.mailId === mail.id);
  check('隔離: エラー文中のメールアドレスがマスクされる', Boolean(q) && !q!.lastError.includes('taro@example.jp'));
  check('隔離: 件名の電話番号がマスクされる', Boolean(q) && !q!.subject.includes('090-1234-5678'));
  recordSuccess(mail.id);
  check('隔離: 成功で履歴が消える', !listQuarantined().some((e) => e.mailId === mail.id));

  // 5. 過半数失敗ガード（countTowardQuarantine=false ならカウントが増えない）
  const mail2 = fakeMail(`selftest2_${process.pid}`);
  const r = recordFailure(mail2, new Error('mass'), { countTowardQuarantine: false });
  check('過半数失敗ガード: カウント保留', r.attempts === 0 && !r.quarantined);
  recordSuccess(mail2.id);

  // 6. 統計カウンタ
  resetHealEvents();
  recordStat('collected', 5);
  recordStat('extractFailures', 2);
  check('統計: 加算が反映される', getStats().collected === 5 && getStats().extractFailures === 2);

  console.log('');
  if (failures > 0) {
    console.log(`❌ ${failures}件の検証に失敗しました`);
    process.exitCode = 1;
  } else {
    console.log('✅ すべての自己検証を通過しました');
  }
}

main();
