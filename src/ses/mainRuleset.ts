// main のルールセットの確認（純粋関数）。Environment「production」は main の実行にだけ鍵を渡すため、main に
// レビューなしで push できると、次の定時実行ですべての鍵が持ち出せる。鍵を持つジョブの前（鍵の無いビルドのジョブ）で
// GitHub API の GET /repos/{repo}/rules/branches/main の結果を調べ、足りない規則があれば鍵を持つジョブを動かさない。

export const MAIN_RULESET_DOC = '手順書 docs/ses-deploy-github-actions.md の 2-4 の 5';

interface Rule {
  type?: unknown;
  parameters?: Record<string, unknown> | null;
}

export interface MainRulesetOptions {
  // 1人で管理するリポジトリ（書き込みできるのがオーナーだけ）。自分の PR を自分では承認できないため、承認・コードオーナーの
  // レビュー・最後の push 以外の人の承認を求めない（PR を経ること・force-push と削除の禁止は求める）。変数 SES_SINGLE_MAINTAINER=true
  singleMaintainer?: boolean;
}

// 返り値は足りない規則の説明（空なら十分）
export function mainRulesetProblems(rules: unknown, opts: MainRulesetOptions = {}): string[] {
  if (!Array.isArray(rules)) return ['GitHub API の応答がルールの一覧ではありません'];
  const list = rules.filter((r): r is Rule => typeof r === 'object' && r !== null);
  const has = (type: string): boolean => list.some((r) => r.type === type);
  const problems: string[] = [];
  const prs = list.filter((r) => r.type === 'pull_request').map((r) => r.parameters ?? {});
  const ok = (pred: (p: Record<string, unknown>) => boolean): boolean => prs.some(pred);
  if (prs.length === 0) {
    problems.push('「Require a pull request before merging」が無い（main に直接 push できる）');
  } else if (!opts.singleMaintainer) {
    if (!ok((p) => typeof p.required_approving_review_count === 'number' && p.required_approving_review_count >= 1)) {
      problems.push('承認の必要数が 1 以上になっていない');
    }
    if (!ok((p) => p.require_last_push_approval === true)) {
      problems.push('「Require approval of the most recent reviewable push」（最後に push した人以外の承認）が無効');
    }
    if (!ok((p) => p.dismiss_stale_reviews_on_push === true)) {
      problems.push('「Dismiss stale pull request approvals when new commits are pushed」が無効');
    }
    if (!ok((p) => p.require_code_owner_review === true)) {
      problems.push('「Require review from Code Owners」が無効');
    }
  }
  if (!has('non_fast_forward')) problems.push('「Block force pushes」が無効');
  if (!has('deletion')) problems.push('「Restrict deletions」が無効');
  return problems;
}

// SES_SINGLE_MAINTAINER=true の宣言を確かめる。GET /repos/{repo}/collaborators?affiliation=all の結果から、書き込み
// （push・maintain・admin）できる人がリポジトリのオーナーだけか（組織のリポジトリなら1人だけか）を調べる。
// 宣言したまま共同作業者を足すと、その人が承認なしの PR で main を書き換え、次の定時実行で鍵を持ち出せるため。
// 返り値は問題の説明（空なら十分）
export function singleMaintainerProblems(collaborators: unknown, repo: string): string[] {
  if (!Array.isArray(collaborators)) return ['GitHub API の応答が共同作業者の一覧ではありません'];
  const owner = (repo.split('/')[0] ?? '').toLowerCase();
  const writers = collaborators
    .filter((c): c is { login?: unknown; permissions?: Record<string, unknown> | null } => typeof c === 'object' && c !== null)
    .filter((c) => {
      const p = c.permissions ?? {};
      return p.push === true || p.maintain === true || p.admin === true;
    })
    .map((c) => (typeof c.login === 'string' ? c.login.toLowerCase() : '?'));
  const others = writers.filter((l) => l !== owner);
  const allowed = writers.includes(owner) ? 0 : 1;
  if (others.length > allowed) {
    return [
      `SES_SINGLE_MAINTAINER=true ですが、main に書き込めるのがオーナーのほかに${others.length}人います（Actions のログは公開のため名前は出しません）。` +
        '変数を消して承認を求めるルールセットに戻すか、共同作業者の書き込み権限を外してください',
    ];
  }
  return [];
}
