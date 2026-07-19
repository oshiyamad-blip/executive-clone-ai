import '../env.js';
// 修正パッチ案生成の手動エントリポイント（npm run ses:repair）。
// SES_REPAIR_ENABLED の設定に関わらず、明示実行なら常に動く（demoはスタブ生成）。
import { runRepair } from './heal/repair.js';

runRepair(false).catch(console.error);
