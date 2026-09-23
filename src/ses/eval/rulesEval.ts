// 決定的ルール（LLM不使用）の表駆動の回帰確認（npm run ses:eval:rules）。外部呼び出しゼロ・API キー不要。
// スキル正規化（分割・バージョン除去・辞書）・含意・否定リスト・被覆判定・一次選抜への反映・未知語の集計を検証する。
// 後続の施策（勤務地・時期・単金・ハード条件・ランキング等）のルールもここに表を足していく。失敗が1件でもあれば exit 1
import { setDemoOverride } from '../config.js';
import {
  tokenizeSkill,
  normalizeSkills,
  normalizeSkill,
  canonicalSkillNames,
  skillDictionaryIssues,
  skillCategory,
  isKnownSkill,
  classifySkillTokens,
} from '../skillDict.js';
import { impliesSkill, isNotEquivalent, skillGraphTerms, IMPLIES_MAX_DEPTH } from '../skillGraph.js';
import { skillCoverage, setSkillEquivalencesForTest, equivalenceRejection, type SkillCoverage } from '../skillEquiv.js';
import { skillMatch, assessSkills } from '../pricing.js';
import { primarySelect } from '../match.js';
import { evaluateOwnMatch } from '../ownMatch.js';
import { mergeUnknownSkillTokens } from '../skillStats.js';
import { joinList, splitList } from '../../database/mapping.js';
import type { Project, Engineer, OwnEngineer, SkillEquivalence } from '../../types/index.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n■ ${title}`);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const show = (a: unknown) => JSON.stringify(a);

// ===== 1. 分割・正規化（1→N） =====

const TOKENIZE_CASES: Array<[string, string[]]> = [
  // 括弧の展開（親も残す）
  ['Java(Spring Boot)', ['Java', 'Spring Boot']],
  ['AWS(EC2/RDS/Lambda)', ['AWS', 'EC2', 'RDS', 'Lambda']],
  ['Salesforce(Apex, LWC)', ['Salesforce', 'Apex', 'LWC']],
  ['Java(Spring/MyBatis)', ['Java', 'Spring', 'MyBatis']],
  ['Oracle(PL/SQL)', ['Oracle', 'PL/SQL']],
  ['SAP(FI/CO)', ['SAP', 'SAP FI', 'SAP CO']],
  ['Linux(RHEL)', ['Linux', 'RHEL']],
  ['Java・Spring Boot（3年以上）', ['Java', 'Spring Boot']],
  ['【必須】Java', ['Java']],
  ['Java（実務3年）', ['Java']],
  ['Python(独学)', ['Python']],
  // 区切り
  ['C/C++', ['C', 'C++']],
  ['C / C++', ['C', 'C++']],
  ['JavaScript/TypeScript', ['JavaScript', 'TypeScript']],
  ['C#/.NET', ['C#', '.NET']],
  ['C#.NET', ['C#', '.NET']],
  ['Visual Basic .NET', ['VB.NET']],
  ['Java、PHP', ['Java', 'PHP']],
  ['Java;PHP', ['Java', 'PHP']],
  ['Java&PHP', ['Java', 'PHP']],
  ['Java or C#', ['Java', 'C#']],
  ['Java and Python', ['Java', 'Python']],
  ['Java及びPHP', ['Java', 'PHP']],
  ['①Java②PHP', ['Java', 'PHP']],
  ['HTML5/CSS3', ['HTML', 'CSS']],
  ['FI/CO', ['SAP FI', 'SAP CO']],
  ['運用・保守', ['運用保守']],
  ['要件定義〜基本設計', ['要件定義', '基本設計']],
  // 区切りを含む1語（分けない）
  ['PL/SQL', ['PL/SQL']],
  ['TCP/IP', ['TCP/IP']],
  ['CI/CD', ['CI/CD']],
  ['AS/400', ['AS/400']],
  ['SAP S/4HANA', ['SAP S/4HANA']],
  ['GitHub Actions', ['GitHub Actions']],
  ['React Native', ['React Native']],
  ['Google Cloud', ['GCP']],
  // バージョン除去（語幹が辞書にあるときだけ）
  ['Python3', ['Python']],
  ['Vue3', ['Vue.js']],
  ['PHP8', ['PHP']],
  ['Python 3.10', ['Python']],
  ['Vue 3.x', ['Vue.js']],
  ['Oracle 19c', ['Oracle']],
  ['Oracle11g', ['Oracle']],
  ['Windows Server 2019 R2', ['Windows Server']],
  ['SQL Server 2019', ['SQL Server']],
  ['SQLServer2016', ['SQL Server']],
  ['.NET Framework 4.8', ['.NET']],
  ['C++17', ['C++']],
  ['JDK1.8', ['Java']],
  ['Java SE 17', ['Java']],
  ['Angular2+', ['Angular']],
  ['Spring Boot 3', ['Spring Boot']],
  ['Laravel10', ['Laravel']],
  ['Rails7', ['Ruby on Rails']],
  ['COBOL85', ['COBOL']],
  ['VB6', ['VB']],
  // 数字まで含めて1つの名前（壊さない）
  ['S3', ['S3']],
  ['EC2', ['EC2']],
  ['Route53', ['Route53']],
  ['Db2', ['Db2']],
  ['K8s', ['Kubernetes']],
  ['Dynamics 365', ['Dynamics 365']],
  ['Office365', ['Microsoft 365']],
  ['JP1', ['JP1']],
  ['Web3', ['Web3']],
  // 1文字・2文字の言語を残す
  ['R', ['R']],
  ['Go', ['Go']],
  ['C', ['C']],
  ['Go言語', ['Go']],
  ['C言語', ['C']],
  ['C++言語', ['C++']],
  // 年数・レベル語の除去
  ['Java 5年以上', ['Java']],
  ['Java経験3年', ['Java']],
  ['詳細設計以上', ['詳細設計']],
  ['PM経験', ['PM']],
  ['Javaでの開発', ['Java']],
  ['Javaの開発経験', ['Java']],
  ['AWS・GCP等', ['AWS', 'GCP']],
  ['AWS等', ['AWS']],
  ['3年以上', []],
  ['', []],
  // 表記ゆれ・全角・別名
  ['ＪＡＶＡ', ['Java']],
  ['Ｃ＃', ['C#']],
  ['Ｃ＋＋', ['C++']],
  ['SpringBoot', ['Spring Boot']],
  ['Spring-Boot', ['Spring Boot']],
  ['React.js', ['React']],
  ['Nuxt', ['Nuxt.js']],
  ['es6', ['JavaScript']],
  ['TS', ['TypeScript']],
  ['Excel VBA', ['VBA']],
  ['bash', ['Shell']],
  ['AD', ['Active Directory']],
  ['Unity3D', ['Unity']],
  // 役割・工程・業種
  ['プロジェクトリーダー', ['PL']],
  ['テスト工程', ['テスト']],
  ['結合テスト', ['テスト']],
  ['インフラ構築', ['インフラ']],
  ['ネットワーク', ['NW']],
  ['金融系', ['金融']],
  ['官公庁', ['公共']],
  ['ECサイト', ['EC']],
  // 辞書に無い語は正規化した表記のまま
  ['Redux', ['Redux']],
  ['Recoil(React)', ['Recoil', 'React']],
  ['サーバー構築', ['サーバー構築']],
  ['Java/A', ['Java']],
  ['R&D', ['R&D']],
  ['尚可: AWS', ['AWS']],
  ['Java経験者歓迎', ['Java']],
];

function tokenizeChecks(): void {
  section('スキルの分割・正規化（tokenizeSkill）');
  for (const [input, want] of TOKENIZE_CASES) {
    const got = tokenizeSkill(input);
    check(`${show(input)} → ${show(want)}`, same(got, want), `実際: ${show(got)}`);
  }

  section('配列の正規化・冪等性・辞書の整合');
  check(
    '配列: 各要素を分割し、大文字小文字を無視して重複を除く（出現順を保つ）',
    same(normalizeSkills(['Java(Spring Boot)', 'java', 'SpringBoot', 'Oracle 19c']), ['Java', 'Spring Boot', 'Oracle']),
    show(normalizeSkills(['Java(Spring Boot)', 'java', 'SpringBoot', 'Oracle 19c'])),
  );
  const notIdempotent = canonicalSkillNames().filter((c) => !same(tokenizeSkill(c), [c]));
  check(`正規形${canonicalSkillNames().length}語はすべて自分自身に正規化される（冪等）`, notIdempotent.length === 0, notIdempotent.join(', '));
  check('辞書: 正規形は150語前後（言語・FW・クラウド・DB・インフラ・SaaS・役割・工程・業種）', canonicalSkillNames().length >= 140);
  check('辞書: 別の正規形が同じ表記・照合キーを取り合っていない', skillDictionaryIssues().length === 0, skillDictionaryIssues().join(' / '));
  const unknownGraphTerms = skillGraphTerms().filter((t) => !isKnownSkill(t) || !same(tokenizeSkill(t), [t]));
  check('含意表・否定リストの語はすべて辞書の正規形', unknownGraphTerms.length === 0, unknownGraphTerms.join(', '));
  const stored = normalizeSkills(['Java(Spring, MyBatis)', 'C/C++', 'PL/SQL', 'Vue3']);
  const roundTrip = normalizeSkills(splitList(joinList(stored)));
  check('保存→読み戻し（カンマ区切りのセル）で要素が変わらない', same(stored, roundTrip), `${show(stored)} → ${show(roundTrip)}`);
  const legacyRow = normalizeSkills(splitList('Java(SpringBoot), Oracle 11g, Python3'));
  check('既存行の救済: 旧形式のセルも読出時に分割・正規化される', same(legacyRow, ['Java', 'Spring Boot', 'Oracle', 'Python']), show(legacyRow));
  check('1語の正規化: 別名は正規形・複数に分かれる記載は分けずに返す', normalizeSkill('vue') === 'Vue.js' && normalizeSkill('Java(Spring)') === 'Java(Spring)');
  check(
    '分類: 技術・役割・工程・業種',
    skillCategory('Java') === 'skill' && skillCategory('PMO') === 'role' && skillCategory('詳細設計') === 'phase' &&
      skillCategory('金融') === 'domain' && skillCategory('Redux') === null,
  );
}

// ===== 2. 含意（子→親・有向・深さ≤3） =====

const IMPLIES_CASES: Array<[string, string, boolean]> = [
  ['Spring Boot', 'Spring', true],
  ['Spring Boot', 'Java', true],
  ['Spring', 'Java', true],
  ['Java', 'Spring Boot', false],
  ['Laravel', 'PHP', true],
  ['CakePHP', 'PHP', true],
  ['Ruby on Rails', 'Ruby', true],
  ['FastAPI', 'Python', true],
  ['Next.js', 'React', true],
  ['Next.js', 'JavaScript', true],
  ['React', 'Next.js', false],
  ['Nuxt.js', 'JavaScript', true],
  ['TypeScript', 'JavaScript', true],
  ['JavaScript', 'TypeScript', false],
  ['NestJS', 'Node.js', true],
  ['EKS', 'Kubernetes', true],
  ['EKS', 'AWS', true],
  ['Lambda', 'AWS', true],
  ['GKE', 'GCP', true],
  ['AKS', 'Azure', true],
  ['Kubernetes', 'AWS', false],
  ['Apex', 'Salesforce', true],
  ['LWC', 'Salesforce', true],
  ['SAP FI', 'SAP', true],
  ['ABAP', 'SAP', true],
  ['Unity', 'C#', true],
  ['ASP.NET', 'C#', true],
  ['VB.NET', '.NET', true],
  ['React Native', 'React', true],
  ['PL/SQL', 'SQL', true],
  ['MySQL', 'SQL', true],
  ['Java', 'JavaScript', false],
  ['Spring Boot', 'Spring Boot', false],
];

function impliesChecks(): void {
  section(`含意（子の経験 ⇒ 親の必須。深さ${IMPLIES_MAX_DEPTH}まで・逆向きは不可）`);
  for (const [child, parent, want] of IMPLIES_CASES) {
    check(`${child} ${want ? '⇒' : '⇏'} ${parent}`, impliesSkill(child, parent) === want);
  }
}

// ===== 3. 被覆判定（完全一致・同義・含意。親だけでは子を満たさない。否定リストは同義より優先） =====

const EQUIVALENCES: SkillEquivalence[] = [
  { a: 'CakePHP', b: 'Laravel', addedBy: 't', at: '' },
  { a: 'PostgreSQL', b: 'MySQL', addedBy: 't', at: '' },
  { a: 'Java', b: 'JavaScript', addedBy: 't', at: '' }, // 否定リストと矛盾 → 効かせない
  { a: 'SQL Server', b: 'MySQL', addedBy: 't', at: '' }, // 否定リストと矛盾 → 効かせない
  { a: 'React', b: 'Next.js', addedBy: 't', at: '' }, // 含意の親子 → 効かせない（React だけで Next.js 必須を満たさない）
  { a: 'PHP', b: 'Laravel', addedBy: 't', at: '' }, // 含意の親子 → 効かせない
  { a: 'Java(Spring)', b: 'Kotlin', addedBy: 't', at: '' }, // 1語でない → 効かせない
];

const COVERAGE_CASES: Array<[string, string[], SkillCoverage | null]> = [
  ['Java', ['Java'], 'exact'],
  ['Java', ['Spring Boot', 'MyBatis'], 'implied'],
  ['Java', ['Struts'], 'implied'],
  ['Spring Boot', ['Java'], null],
  ['Next.js', ['React'], null],
  ['React', ['Next.js'], 'implied'],
  ['JavaScript', ['TypeScript'], 'implied'],
  ['TypeScript', ['JavaScript'], null],
  ['AWS', ['EC2', 'Lambda'], 'implied'],
  ['EC2', ['AWS'], null],
  ['Kubernetes', ['EKS'], 'implied'],
  ['Salesforce', ['Apex'], 'implied'],
  ['SAP', ['SAP MM'], 'implied'],
  ['Laravel', ['CakePHP'], 'equiv'],
  ['MySQL', ['PostgreSQL'], 'equiv'],
  ['Laravel', ['PHP'], null],
  ['JavaScript', ['Java'], null],
  ['Java', ['JavaScript'], null],
  ['Java', ['Kotlin'], null],
  ['C', ['C++'], null],
  ['C#', ['C'], null],
  ['GCP', ['Go'], null],
  ['MySQL', ['SQL Server'], null],
  ['SQL', ['MySQL'], 'implied'],
  ['Vue.js', ['Nuxt.js'], 'implied'],
  ['Go', ['Go'], 'exact'],
];

function coverageChecks(): void {
  section('同義登録の検査（否定リスト・含意の親子・1語でない登録は効かせない）');
  const load = setSkillEquivalencesForTest(EQUIVALENCES);
  check(
    `読み込み: 有効2件・否定リストと矛盾2件・含意の親子2件・1語でない1件`,
    load.linked === 2 && load.notEquivalent === 2 && load.implied === 2 && load.invalid === 1,
    show(load),
  );
  check('否定リスト: Java≠JavaScript・Java≠Kotlin・C≠C#・C≠C++・Go≠GCP・SQL Server≠MySQL', [
    ['Java', 'JavaScript'], ['Java', 'Kotlin'], ['C', 'C#'], ['C', 'C++'], ['Go', 'GCP'], ['SQL Server', 'MySQL'],
  ].every(([a, b]) => isNotEquivalent(a, b) && isNotEquivalent(b, a)));
  check('否定リストに無い組は同義として登録できる（CakePHP≈Laravel）', equivalenceRejection('CakePHP', 'Laravel') === null);
  check('登録の拒否理由: 否定リスト／含意の親子／1語でない', equivalenceRejection('java', 'JS') === 'not_equivalent' &&
    equivalenceRejection('Laravel', 'PHP') === 'implied' && equivalenceRejection('Java(Spring)', 'Kotlin') === 'invalid' &&
    equivalenceRejection('vue', 'Vue.js') === 'invalid');

  section('被覆判定（必須スキル × 要員スキル）');
  for (const [required, have, want] of COVERAGE_CASES) {
    const got = skillCoverage(required, new Set(have.map((h) => h.toLowerCase())))?.kind ?? null;
    check(`必須 ${required} × 要員 [${have.join(', ')}] → ${want ?? '満たさない'}`, got === want, `実際: ${got}`);
  }
  setSkillEquivalencesForTest([]);
}

// ===== 4. 一致率の内訳と一次選抜への反映 =====

const baseProject: Project = {
  id: 'p', title: 'テスト案件', requiredSkills: ['Java'], preferredSkills: [], rateMin: null, rateMax: 80, location: '東京都',
  prefecture: '東京都', remote: 'partial', startPeriod: '', startDate: null, duration: '', businessFlow: '', agentCompany: 'A社',
  agentContact: '', agentEmail: 'a@a.example', sourceMailId: 'mp', receivedAt: new Date(), status: 'open',
};
const project = (over: Partial<Project>): Project => ({ ...baseProject, ...over });
const engineer = (skills: string[], over: Partial<Engineer> = {}): Engineer => ({
  id: `e_${skills.join('_')}`, displayName: 'K.S.', age: 30, skills, experienceYears: 5, desiredRate: 60, residence: '東京都',
  prefecture: '東京都', nearestStation: '', availableDate: '', availableFrom: null, utilization: '', remoteWish: 'partial',
  agentCompany: 'B社', agentContact: '', agentEmail: 'b@b.example', sourceMailId: 'me', receivedAt: new Date(), status: 'available',
  ...over,
});

function assessmentChecks(): void {
  section('一致率の内訳（exact / implied / equiv / missing）と尚可の一致数');
  const m = skillMatch(['Java', 'Spring Boot', 'Oracle'], normalizeSkills(['Spring Boot', 'MyBatis']));
  check(
    '必須 [Java, Spring Boot, Oracle] × 要員 [Spring Boot, MyBatis] → 一致 Spring Boot・含意 Java・不足 Oracle',
    Boolean(m) && same(m!.breakdown.exact, ['Spring Boot']) && same(m!.breakdown.implied, ['Java']) &&
      same(m!.breakdown.missing, ['Oracle']) && m!.breakdown.via.Java === 'Spring Boot' && Math.abs(m!.rate - 2 / 3) < 1e-9,
    show(m),
  );
  check('必須スキルが空なら一致率は判定不能（null）', skillMatch([], ['Java']) === null);
  const a = assessSkills({ title: 'x', requiredSkills: ['Java'], preferredSkills: ['AWS', 'Docker', 'Oracle'] }, ['Java', 'EC2', 'Docker']);
  check('尚可 [AWS, Docker, Oracle] × 要員 [Java, EC2, Docker] → 尚可一致 2/3（EC2 ⇒ AWS を含む）', a.preferred.matched === 2 && a.preferred.total === 3, show(a.preferred));
  const none = assessSkills({ title: 'x', requiredSkills: ['Java'], preferredSkills: [] }, ['Java']);
  check('尚可の記載なし → 0/0', none.preferred.matched === 0 && none.preferred.total === 0);

  section('一次選抜への反映（含意だけで満たした必須は強マッチにしない）');
  const one = (p: Project, e: Engineer) => primarySelect([p], [e])[0];
  const exact = one(project({ requiredSkills: ['Java', 'Spring Boot'] }), engineer(['Java', 'Spring Boot', 'Oracle']));
  check('必須 [Java, Spring Boot] × 要員 [Java, Spring Boot] → 強マッチ・注意なし', exact?.band === 'strong' && exact.cautions.length === 0, show(exact?.cautions));
  const implied = one(project({ requiredSkills: ['Java'] }), engineer(['Spring Boot', 'MyBatis']));
  check(
    '必須 [Java] × 要員 [Spring Boot, MyBatis] → 除外せず参考提案に一段下げ、推定の注意を付ける',
    implied?.band === 'tentative' && implied.skillMatchRate === 1 && implied.cautions.some((c) => c.includes('Spring Boot')),
    show(implied?.cautions),
  );
  check('必須 [Spring Boot] × 要員 [Java] → 除外（親だけでは子を満たさない）', one(project({ requiredSkills: ['Spring Boot'] }), engineer(['Java'])) === undefined);
  check('必須 [Next.js] × 要員 [React] → 除外', one(project({ requiredSkills: ['Next.js'] }), engineer(['React'])) === undefined);
  check('必須 [JavaScript] × 要員 [Java] → 除外（名前が似ているだけ）', one(project({ requiredSkills: ['JavaScript'] }), engineer(['Java'])) === undefined);
  const legacy = one(project({ requiredSkills: normalizeSkills(['Java', 'Spring Boot']) }), engineer(normalizeSkills(['Java(SpringBoot)', 'Oracle'])));
  check('必須 [Java, Spring Boot] × 要員 ["Java(SpringBoot)", Oracle] → 分割して強マッチ（以前は0%で除外）', legacy?.band === 'strong' && legacy.skillMatchRate === 1);
  const aws = one(project({ requiredSkills: ['AWS', 'Python'] }), engineer(['Python3', 'Lambda'].flatMap(tokenizeSkill)));
  check('必須 [AWS, Python] × 要員 [Python3, Lambda] → 100%・参考提案（Lambda ⇒ AWS の推定）', aws?.skillMatchRate === 1 && aws.band === 'tentative');
  check('一次選抜の結果に内訳と尚可の一致数を持たせる', Boolean(implied?.skillBreakdown) && implied!.preferredMatch?.total === 0);

  const own: OwnEngineer = {
    id: 'own', displayName: 'A', skills: ['Spring Boot'], experienceYears: 5, requiredProjectRate: 60, residence: '東京都',
    prefecture: '東京都', availableDate: '', availableFrom: null, remoteWish: 'partial', status: 'available',
  };
  const ownMatch = evaluateOwnMatch(own, project({ requiredSkills: ['Java'] }));
  check('自社社員: 含意だけで満たした必須は参考提案・理由に推定を明記', ownMatch?.band === 'tentative' && ownMatch.reason.includes('推定'), ownMatch?.reason);
}

// ===== 5. 未知語の集計（人名・社名は数えない・保存は上位だけ） =====

function unknownTokenChecks(): void {
  section('未知語の集計');
  const r = classifySkillTokens(['Java', 'Redux', 'K.S.', 'Tanaka様', 'テックス', 'Recoil'], ['K.S.', '株式会社テックス', '田中']);
  check(
    '表示名・社名・敬称付きの語は数えず、辞書に無い語だけを未知語にする',
    same(r.counted, ['Java', 'Redux', 'Recoil']) && same(r.unknown, ['Redux', 'Recoil']),
    show(r),
  );
  check('辞書にある語は社名に含まれても数える（「インフラ」）', classifySkillTokens(['インフラ'], ['インフラ株式会社']).counted.length === 1);
  const merged = mergeUnknownSkillTokens(
    [{ t: 'Redux', n: 3, first: '2026-09-01', last: '2026-09-10' }, { t: 'Old', n: 1, first: '2026-08-01', last: '2026-08-01' }],
    [{ t: 'redux', n: 2 }, { t: 'Recoil', n: 1 }],
    '2026-09-23',
    2,
  );
  check(
    '保存: 大文字小文字を無視して累計し、出現数の多い順（同数は直近）に上位だけ残す',
    merged.length === 2 && merged[0].t === 'Redux' && merged[0].n === 5 && merged[0].first === '2026-09-01' &&
      merged[0].last === '2026-09-23' && merged[1].t === 'Recoil',
    show(merged),
  );
}

// 手元の .env 等で変えたしきい値に結果が左右されないよう、判定ルールの設定は既定値で検証する
const RULE_ENV_PREFIXES = ['SKILL_', 'MATCH_', 'MIN_GROSS_', 'MAX_CANDIDATES', 'NEGOTIATION_', 'ENABLE_NEGOTIATION', 'HOURLY_'];

function main(): void {
  for (const k of Object.keys(process.env)) if (RULE_ENV_PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];
  setDemoOverride(true); // 設定の読み出しで本番の鍵・保存先を参照しない
  console.log('=== SES 決定的ルールの回帰確認（ses:eval:rules） ===');
  try {
    tokenizeChecks();
    impliesChecks();
    coverageChecks();
    assessmentChecks();
    unknownTokenChecks();
  } finally {
    setDemoOverride(null);
  }
  console.log(`\n=== 結果: ${passed + failed}件中 成功${passed}件・失敗${failed}件 ===`);
  if (failed > 0) process.exitCode = 1;
}

main();
