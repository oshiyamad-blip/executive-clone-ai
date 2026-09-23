import '../env.js';
// 修正パッチ案生成の手動エントリポイント（npm run ses:repair）。
// SES_REPAIR_ENABLED の設定に関わらず、明示実行なら常に動く（demoはスタブ生成）。
import { runRepair } from './heal/repair.js';
import { liveConfigError } from './config.js';
import { safeErr } from './redact.js';

const configError = liveConfigError();
if (configError) {
  console.error(`SES修復: 🚨 ${configError}`);
  process.exitCode = 1;
} else {
  runRepair(false).catch((err) => {
    console.error(`SES修復: 予期しないエラーで終了しました: ${safeErr(err)}`);
    process.exitCode = 1;
  });
}
