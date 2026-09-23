import '../env.js';
// 修正パッチ案生成の手動エントリポイント（npm run ses:repair）。
// SES_REPAIR_ENABLED の設定に関わらず、明示実行なら常に動く（demoはスタブ生成）。
import { runRepair } from './heal/repair.js';
import { safeErr } from './redact.js';

runRepair(false).catch((err) => {
  console.error(`SES修復: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
