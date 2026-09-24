import '../env.js';
// GitHub Actions の鍵を持たないビルドのジョブで実行する（node dist/ses/checkMainRuleset.js）。main のルールセットが
// 足りなければ失敗し、needs で続く鍵を持つジョブを動かさない。API に届かないときも失敗にする（確かめられないまま鍵を渡さない）。
import { mainRulesetProblems, MAIN_RULESET_DOC } from './mainRuleset.js';
import { githubRepository, githubApiToken, githubApiUrl } from './config.js';
import { safeErr } from './redact.js';

async function fetchRules(repo: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = githubApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${githubApiUrl()}/repos/${repo}/rules/branches/main`, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastError = safeErr(e);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  const repo = githubRepository();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`❌ GITHUB_REPOSITORY が不正です。GitHub Actions の中で実行してください（${MAIN_RULESET_DOC}）`);
    process.exit(1);
  }
  let rules: unknown;
  try {
    rules = await fetchRules(repo);
  } catch (e) {
    console.error(`❌ main のルールセットを GitHub API で確認できませんでした（${safeErr(e)}）。確かめられないため鍵を渡すジョブを動かしません。時間をおいて再実行してください`);
    process.exit(1);
  }
  const singleMaintainer = process.env.SES_SINGLE_MAINTAINER?.trim().toLowerCase() === 'true';
  const problems = mainRulesetProblems(rules, { singleMaintainer });
  if (problems.length > 0) {
    console.error(`❌ main のルールセットが足りません。main にレビューなしで push できると、次の実行ですべての鍵が持ち出せます（${MAIN_RULESET_DOC}）:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (singleMaintainer) {
    console.log('::warning::SES_SINGLE_MAINTAINER=true のため、PR の承認・コードオーナーのレビューを求めていません。main に書き込めるのがオーナー1人だけのときに限ってください');
    console.log('✅ main のルールセット（PR・force-push と削除の禁止。1人で管理）を確認しました');
  } else {
    console.log('✅ main のルールセット（PR・承認・force-push と削除の禁止）を確認しました');
  }
}

main().catch((e) => {
  console.error(`❌ main のルールセットの確認に失敗しました: ${safeErr(e)}`);
  process.exit(1);
});
