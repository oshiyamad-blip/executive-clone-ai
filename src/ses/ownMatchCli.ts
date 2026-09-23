import '../env.js';
// 自社社員→案件探しのCLIエントリポイント（npm run ses:own-match / ses:own-match:demo）。
import { runOwnMatch } from './ownMatch.js';
import { safeErr } from './redact.js';

runOwnMatch().catch((err) => {
  console.error(`自社社員探し: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
