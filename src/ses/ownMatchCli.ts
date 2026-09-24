import '../env.js';
// 自社社員→案件探しのCLIエントリポイント（npm run ses:own-match / ses:own-match:demo）。
// 自社社員タブ（DB）の突合に続けて、プロパーのスキルシート連携が設定されていればその候補探しも行う
// （demoは fixture の自社社員で突合と提案文面の作成だけ。件数のみ表示）。
import { runOwnMatch } from './ownMatch.js';
import { runProperFlow } from './proper/index.js';
import { liveConfigError, isDemo, dbProvider } from './config.js';
import { safeErr } from './redact.js';
import { acquireRunLease, releaseRunLease } from './lease.js';

async function main(): Promise<void> {
  const configError = liveConfigError();
  if (configError) {
    console.error(`自社社員探し: 🚨 ${configError}`);
    process.exitCode = 1;
    return;
  }
  // Sheets運用の本番は、定時のバッチ（同じプロパー管理表・プロパー候補タブに書く）と重ならないよう同じ実行中の印を取る
  let lease = '';
  if (!isDemo() && dbProvider() === 'sheets') {
    const r = await acquireRunLease();
    if (!r.ok) {
      console.error(`自社社員探し: 🚨 ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    lease = r.token;
  }
  try {
    const { projects } = await runOwnMatch();
    try {
      await runProperFlow(projects);
    } catch (err) {
      console.error(`プロパー候補: 失敗: ${safeErr(err)}`);
      process.exitCode = 1;
    }
  } finally {
    await releaseRunLease(lease);
  }
}

main().catch((err) => {
  console.error(`自社社員探し: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
