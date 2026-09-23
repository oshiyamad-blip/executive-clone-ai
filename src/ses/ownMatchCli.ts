import '../env.js';
// 自社社員→案件探しのCLIエントリポイント（npm run ses:own-match / ses:own-match:demo）。
// 自社社員タブ（DB）の突合に続けて、プロパーのスキルシート連携が設定されていればその候補探しも行う
// （demoは fixture の自社社員で突合と提案文面の作成だけ。件数のみ表示）。
import { runOwnMatch } from './ownMatch.js';
import { runProperFlow } from './proper/index.js';
import { liveConfigError } from './config.js';
import { safeErr } from './redact.js';

async function main(): Promise<void> {
  const configError = liveConfigError();
  if (configError) {
    console.error(`自社社員探し: 🚨 ${configError}`);
    process.exitCode = 1;
    return;
  }
  const { projects } = await runOwnMatch();
  try {
    await runProperFlow(projects);
  } catch (err) {
    console.error(`プロパー候補: 失敗: ${safeErr(err)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`自社社員探し: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
