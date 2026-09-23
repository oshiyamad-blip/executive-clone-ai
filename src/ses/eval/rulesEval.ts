// 決定的ルール（LLM不使用）の表駆動の回帰確認（npm run ses:eval:rules）。外部呼び出しゼロ・API キー不要。
// スキル正規化（分割・バージョン除去・辞書）・含意・否定リスト・被覆判定・一次選抜への反映・未知語の集計、
// 日付の解決（受信日基準）・抽出値の妥当性検証・リモート条件・同一営業元・並び順・双方向の上限・鮮度・除外理由の集計を検証する。
// 後続の施策のルールもここに表を足していく。失敗が1件でもあれば exit 1
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
import {
  primarySelect,
  primarySelectDetailed,
  comparePairs,
  isSameAgent,
  emailDomain,
  formatPrimaryStats,
  buildHeuristicResult,
  buildMatchPrompt,
  heuristicScore,
  matchIdOf,
} from '../match.js';
import { evaluateOwnMatch, matchOwnEngineersToProjects } from '../ownMatch.js';
import { mergeUnknownSkillTokens } from '../skillStats.js';
import { resolveDateText, sanitizeIsoDate, resolveItemDate, jstDateOf } from '../dates.js';
import {
  verifiedRate,
  sourceNumbers,
  orderedRates,
  numberInRange,
  buildProject,
  buildEngineer,
  extractionUserMessage,
  type RawProject,
  type RawEngineer,
} from '../extract.js';
import { freshnessOf, allocateWithCaps } from '../ranking.js';
import { joinList, splitList } from '../../database/mapping.js';
import type { Project, Engineer, OwnEngineer, SkillEquivalence, SesRawMail, MatchPair } from '../../types/index.js';

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


// ===== 6. 日付の解決（受信日基準・決定的） =====

const RECEIVED = new Date('2026-09-23T10:00:00+09:00');

const DATE_TEXT_CASES: Array<[string, string | null]> = [
  ['即日', '2026-09-23'],
  ['即日〜', '2026-09-23'],
  ['随時', '2026-09-23'],
  ['即稼働可', '2026-09-23'],
  ['10月〜', '2026-10-01'],
  ['10月から', '2026-10-01'],
  ['１０月〜', '2026-10-01'],
  ['10月上旬', '2026-10-01'],
  ['10月中旬〜', '2026-10-11'],
  ['10月下旬', '2026-10-21'],
  ['10月末', '2026-10-31'],
  ['2月末', '2027-02-28'],
  ['1月〜', '2027-01-01'],
  ['8月〜', '2026-08-01'], // 受信日の60日前以降 → 今年（再送の案件。既に開始可）
  ['7月〜', '2027-07-01'], // それより前 → 翌年
  ['12/1〜', '2026-12-01'],
  ['10/1(木)〜', '2026-10-01'],
  ['11月15日〜', '2026-11-15'],
  ['2026年12月1日', '2026-12-01'],
  ['2026/11/01〜', '2026-11-01'],
  ['2027年1月〜', '2027-01-01'],
  ['2026年11月中旬', '2026-11-11'],
  ['2026年7月〜', '2026-07-01'], // 年の記載があれば補正しない
  ['来月から', '2026-10-01'],
  ['翌月中旬', '2026-10-11'],
  ['再来月', '2026-11-01'],
  ['今月中', '2026-09-23'],
  ['今月末', '2026-09-30'],
  ['即日（11月〜も可）', '2026-09-23'],
  ['11月〜（即日も相談可）', '2026-11-01'],
  ['要相談', null],
  ['未定', null],
  ['長期', null],
  ['6ヶ月', null],
  ['3か月後', null],
  ['すぐには難しい', null], // 「すぐ」だけでは即日とみなさない
  ['', null],
];

const ISO_CASES: Array<[string | null, string | null, string]> = [
  ['2026-10-01', '2026-10-01', 'そのまま'],
  ['2026-09-01', '2026-09-01', '受信日の60日前以降はそのまま'],
  ['2025-10-01', '2026-10-01', '年の取り違え → 1年後ろ'],
  ['2026-07-01', '2027-07-01', '受信日の60日より前 → 1年後ろ'],
  ['2024-01-01', null, '1年ずらしても前 → 読み違い'],
  ['2029-01-01', null, '2年より先 → 読み違い'],
  ['2026-10', null, '日付でない'],
  [null, null, '未記載'],
];

function dateChecks(): void {
  section('日付の解決: 原文の表記（受信日 2026-09-23 基準）');
  for (const [text, want] of DATE_TEXT_CASES) {
    const got = resolveDateText(text, RECEIVED);
    check(`${show(text)} → ${want ?? '決まらない'}`, got === want, `実際: ${got}`);
  }
  check('年の無い月は受信日の60日前以降で最も早い年（受信 2026-01-10 の「12月」→ 2025-12-01）', resolveDateText('12月〜', new Date('2026-01-10T10:00:00+09:00')) === '2025-12-01');
  check('受信 2026-12-10 の「1月」→ 2027-01-01', resolveDateText('1月', new Date('2026-12-10T10:00:00+09:00')) === '2027-01-01');
  check('受信日は日本時間の日付（UTC 15:30 は翌日）', jstDateOf(new Date('2026-09-22T15:30:00Z')) === '2026-09-23');

  section('日付の解決: LLM が返した日付の補正（表記から決まらないとき）');
  for (const [iso, want, label] of ISO_CASES) {
    const got = sanitizeIsoDate(iso, RECEIVED);
    check(`${show(iso)} → ${want ?? 'null'}（${label}）`, got === want, `実際: ${got}`);
  }
  check('原文の表記から決まればLLMの日付より優先（即日 × LLM 2025-09-23 → 2026-09-23）', resolveItemDate('即日', '2025-09-23', RECEIVED) === '2026-09-23');
  check('表記から決まらなければLLMの日付を補正して使う', resolveItemDate('プロジェクト開始時', '2026-10-01', RECEIVED) === '2026-10-01' && resolveItemDate('未定', '2025-11-01', RECEIVED) === '2026-11-01');

  const mail = rawMail();
  const user = extractionUserMessage(mail);
  check('抽出の入力に受信日（日本時間）を <untrusted_mail> の外に渡す', user.startsWith('受信日: 2026-09-23\n') && user.indexOf('受信日') < user.indexOf('<untrusted_mail>'));
  const p = buildProject(rawProject({ startPeriod: '10月中旬〜', startDateIso: '2025-10-15' }), mail, 0, null);
  check('案件: 開始日は原文の表記から決める（10月中旬〜 → 2026-10-11）', p.startDate === '2026-10-11', `実際: ${p.startDate}`);
  const e = buildEngineer(rawEngineer({ availableDate: '即日', availableFromIso: null }), mail, 0, null);
  check('要員: 稼働可能日「即日」は受信日', e.availableFrom === '2026-09-23', `実際: ${e.availableFrom}`);
}

// ===== 7. 抽出値の妥当性検証（単金の単位の取り違え・年齢・経験年数・下限と上限） =====

function rawMail(): SesRawMail {
  return {
    id: 'sesmail_eval', from: 'a@a.example', to: 'sales@ourco.example', cc: '', subject: '【案件】評価', body: '本文',
    messageIdHeader: '<eval@a.example>', references: '', receivedAt: RECEIVED, attachments: [], sheetLinks: [],
  };
}

function rawProject(over: Partial<RawProject> = {}): RawProject {
  return {
    title: '評価案件', requiredSkills: ['Java'], preferredSkills: [], rateMin: 60, rateMax: 70, rateUnit: 'manYenPerMonth',
    location: '東京都', remote: 'partial', startPeriod: '', startDateIso: null, duration: '', businessFlow: '', agentCompany: 'A社',
    agentContact: '', agentEmail: 'a@a.example', ...over,
  };
}

function rawEngineer(over: Partial<RawEngineer> = {}): RawEngineer {
  return {
    displayName: 'K.S.', age: 30, skills: ['Java'], experienceYears: 5, desiredRate: 60, desiredRateUnit: 'manYenPerMonth',
    residence: '東京都', nearestStation: '', availableDate: '', availableFromIso: null, utilization: '', remoteWish: 'partial',
    agentCompany: 'B社', agentContact: '', agentEmail: 'b@b.example', ...over,
  };
}

const RATE_CASES: Array<[number, 'manYenPerMonth' | 'yenPerHour' | 'yenPerMonth', number | null, string]> = [
  [65, 'manYenPerMonth', 65, '万円/月'],
  [600000, 'manYenPerMonth', 60, '円の金額を万円と表示 → /10000'],
  [60, 'yenPerMonth', 60, '万円の金額を円/月と表示 → 万円'],
  [800000, 'yenPerMonth', 80, '円/月'],
  [4500, 'yenPerHour', 72, '時給（160時間換算）'],
  [800000, 'yenPerHour', 80, '円/月の金額を時給と表示 → /10000'],
  [60, 'yenPerHour', null, '時給60円は補正しない（単位を決められない）'],
  [6000, 'manYenPerMonth', null, '6000万円は補正しない'],
  [30000, 'manYenPerMonth', null, '3万円は範囲外'],
  [350, 'manYenPerMonth', null, '300万円超は範囲外'],
];

function sanityChecks(): void {
  section('単金: 単位の取り違えの決定的な補正と範囲（5〜300万円/月）');
  for (const [raw, unit, want, label] of RATE_CASES) {
    const got = verifiedRate(raw, unit, null);
    check(`${raw} ${unit} → ${want ?? 'null'}（${label}）`, got === want, `実際: ${got}`);
  }
  check('補正しても原文に無い数値は通さない', verifiedRate(600000, 'manYenPerMonth', sourceNumbers('希望: 60万円')) === null);
  check('原文の「600,000円」は照合できる', verifiedRate(600000, 'manYenPerMonth', sourceNumbers('希望: 600,000円')) === 60);

  section('年齢・経験年数・単金の下限と上限');
  const orderOk =
    show(orderedRates(80, 60)) === show({ rateMin: 60, rateMax: 80 }) &&
    show(orderedRates(60, 80)) === show({ rateMin: 60, rateMax: 80 }) &&
    show(orderedRates(60, null)) === show({ rateMin: 60, rateMax: null });
  check('単金の下限>上限は入れ替える', orderOk);
  const ranges: Array<[number | null, number, number, boolean, number | null]> = [
    [17, 18, 75, true, null], [18, 18, 75, true, 18], [75, 18, 75, true, 75], [76, 18, 75, true, null], [32.4, 18, 75, true, 32],
    [-1, 0, 50, false, null], [0, 0, 50, false, 0], [7.5, 0, 50, false, 7.5], [51, 0, 50, false, null], [null, 0, 50, false, null],
  ];
  const rangeNg = ranges.filter(([v, lo, hi, int, want]) => numberInRange(v, lo, hi, int) !== want).map(([v, lo, hi]) => `${v}(${lo}〜${hi})`);
  check('年齢 18〜75歳・経験年数 0〜50年の範囲外は null', rangeNg.length === 0, rangeNg.join(', '));
  const mail = rawMail();
  const e = buildEngineer(rawEngineer({ age: 150, experienceYears: 60, desiredRate: 650000 }), mail, 0, null);
  check('要員: 年齢150・経験60年は null、希望単金 650000（万円表示）は65万円', e.age === null && e.experienceYears === null && e.desiredRate === 65, show([e.age, e.experienceYears, e.desiredRate]));
  const p = buildProject(rawProject({ rateMin: 80, rateMax: 60 }), mail, 0, null);
  check('案件: 単金の下限と上限が逆なら入れ替える', p.rateMin === 60 && p.rateMax === 80, show([p.rateMin, p.rateMax]));
  const unknown = buildProject(rawProject({ rateMin: 6000, rateMax: 6000 }), mail, 0, null);
  const pair = primarySelect([{ ...unknown, receivedAt: NOW }], [engineer(['Java'], { receivedAt: NOW })], undefined, { now: NOW })[0];
  check('範囲外の単金は null になり、組は「単金不明」の要確認で残る', unknown.rateMax === null && pair?.needsReview === true && pair.reviewReasons.includes('単金不明'));
}

// ===== 8. リモート条件・同一営業元・除外理由の集計 =====

const NOW = new Date('2026-09-23T01:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const REMOTE_CASES: Array<['full' | 'partial' | 'none' | 'unknown', 'full' | 'partial' | 'none' | 'unknown', boolean]> = [
  ['none', 'full', false],
  ['none', 'partial', true],
  ['none', 'none', true],
  ['none', 'unknown', true],
  ['partial', 'full', true],
  ['full', 'full', true],
  ['unknown', 'full', true],
];

const SAME_AGENT_CASES: Array<[string, string, boolean, string]> = [
  ['a@alpha.co.jp', 'b@alpha.co.jp', true, '同じドメイン'],
  ['A@Alpha.CO.JP', 'b@alpha.co.jp', true, '大文字小文字は無視'],
  ['田中 <a@alpha.co.jp>', 'b@alpha.co.jp', true, '表示名つきの表記'],
  ['a@alpha.co.jp', 'b@beta.co.jp', false, '別の会社'],
  ['a@sales.alpha.co.jp', 'b@alpha.co.jp', false, 'サブドメインは寄せない（共用ドメインの誤判定を避ける）'],
  ['a@gmail.com', 'b@gmail.com', false, 'フリーメール'],
  ['a@yahoo.co.jp', 'b@yahoo.co.jp', false, 'フリーメール'],
  ['a@outlook.jp', 'b@outlook.jp', false, 'フリーメール'],
  ['a@icloud.com', 'b@icloud.com', false, 'フリーメール'],
  ['', '', false, 'アドレス不明'],
  ['a@ourco.example', 'b@ourco.example', false, '自社ドメイン（社内の営業が共有した案件・要員）'],
];

function hardRuleChecks(): void {
  section('リモート条件: 常駐のみの案件 × フルリモート希望は除外（理由コード remote）');
  for (const [remote, wish, pass] of REMOTE_CASES) {
    const r = primarySelectDetailed([project({ remote, receivedAt: NOW })], [engineer(['Java'], { remoteWish: wish, receivedAt: NOW })], undefined, { now: NOW });
    const ok = pass ? r.pairs.length === 1 : r.pairs.length === 0 && r.stats.reasons.remote === 1;
    check(`案件 ${remote} × 要員の希望 ${wish} → ${pass ? '通過' : '除外'}`, ok, show(r.stats.reasons));
  }
  const partial = primarySelect([project({ remote: 'partial', receivedAt: NOW })], [engineer(['Java'], { remoteWish: 'full', receivedAt: NOW })], undefined, { now: NOW })[0];
  check('一部出社の案件 × フルリモート希望は注意を付けて通す', Boolean(partial?.cautions.some((c) => c.includes('フルリモート希望'))));

  section('同一営業元: 案件と要員のメールドメインが同じなら除外（理由コード sameAgent）');
  for (const [a, b, want, label] of SAME_AGENT_CASES) {
    check(`${a || '(空)'} × ${b || '(空)'} → ${want ? '除外' : '組む'}（${label}）`, isSameAgent(a, b, ['ourco.example']) === want);
  }
  check('ドメインの取り出し（表示名つき・大文字）', emailDomain('Taro <taro@Alpha.CO.JP>') === 'alpha.co.jp' && emailDomain('no-at-mark') === '');
  const same = primarySelectDetailed(
    [project({ agentEmail: 'a@alpha.co.jp', receivedAt: NOW })],
    [engineer(['Java'], { agentEmail: 'b@alpha.co.jp', receivedAt: NOW })],
    undefined,
    { now: NOW },
  );
  check('一次選抜: 同じ営業元の組は除外して sameAgent に数える', same.pairs.length === 0 && same.stats.reasons.sameAgent === 1);

  section('除外理由の集計（理由コードごとの件数・人名を含まない1行）');
  const p = project({ requiredSkills: ['Java'], remote: 'none', startDate: '2026-10-01', rateMax: 80, agentEmail: 'a@alpha.co.jp', receivedAt: daysAgo(1) });
  const e = (id: string, over: Partial<Engineer>) => engineer(['Java'], { id, receivedAt: daysAgo(1), availableFrom: '2026-10-01', ...over });
  const r = primarySelectDetailed(
    [p],
    [
      e('e_skill', { skills: ['COBOL'] }),
      e('e_loc', { prefecture: '福岡県', residence: '福岡県' }),
      e('e_timing', { availableFrom: '2027-03-01' }),
      e('e_rate', { desiredRate: 90 }),
      e('e_remote', { remoteWish: 'full' }),
      e('e_same', { agentEmail: 'x@alpha.co.jp' }),
      e('e_stale', { receivedAt: daysAgo(50) }),
      e('e_ok', {}),
    ],
    undefined,
    { now: NOW },
  );
  const want = { skill: 1, location: 1, timing: 1, rate: 1, remote: 1, sameAgent: 1, stale: 1 };
  const pastStart = primarySelect(
    [project({ startDate: '2026-07-01', receivedAt: daysAgo(10) })],
    [engineer(['Java'], { availableFrom: '2026-10-10', receivedAt: daysAgo(1) })],
    undefined,
    { now: NOW },
  );
  check('時期: 開始日が過ぎた募集中の案件は今日からとして判定（7/1開始 × 10/10〜稼働可 → 今日9/23+30日以内で通過）', pastStart.length === 1 && pastStart[0].timingOk);
  const future = primarySelect(
    [project({ startDate: '2026-10-01', receivedAt: daysAgo(1) })],
    [engineer(['Java'], { availableFrom: '2026-11-15', receivedAt: daysAgo(1) })],
    undefined,
    { now: NOW },
  );
  check('時期: 開始日が先の案件は開始日+猶予30日で判定（10/1開始 × 11/15〜 → 除外）', future.length === 0);
  check('スキル・勤務地・時期・単金・リモート・同一営業元の除外と鮮度の降格を1件ずつ数える', show(r.stats.reasons) === show(want) && r.stats.evaluated === 8 && r.stats.passed === 2, show(r.stats));
  const line = formatPrimaryStats(r.stats);
  check('集計の1行は件数だけ（案件名・表示名・アドレスを含まない）', line.includes('同一営業元1') && line.includes('リモート条件1') && !line.includes('K.S.') && !line.includes('alpha') && !line.includes('テスト案件'), line);
}

// ===== 9. 並び順（区分 → バンド → スキル適合度 → 完全一致の割合 → 尚可 → 粗利 → 受信の新しい順 → ID） =====

function rankingChecks(): void {
  section('並び順（合う順・決定的）');
  const p = project({ id: 'p_rank', requiredSkills: ['Java', 'Spring Boot', 'Oracle'], preferredSkills: ['AWS', 'Docker'], rateMax: 80, receivedAt: daysAgo(1) });
  const full = ['Java', 'Spring Boot', 'Oracle'];
  const e = (id: string, skills: string[], over: Partial<Engineer> = {}) => engineer(skills, { id, receivedAt: daysAgo(1), ...over });
  const engineers = [
    e('e_R', full, { desiredRate: null }), // 要員の単金不明 → 要確認
    e('e_F2', ['Spring Boot', 'MyBatis']), // 67%（一致1・推定1）参考提案
    e('e_F1', ['Java', 'Spring Boot']), // 67%（一致2）参考提案
    e('e_S', full, { receivedAt: daysAgo(50) }), // 受信50日 → 参考提案・適合度90
    e('e_G', ['Spring Boot', 'Oracle']), // 100%（Java は推定）→ 参考提案・適合度100
    e('e_E', full, { desiredRate: 75 }), // 粗利5万 → 交渉提案
    e('e_D', [...full, 'AWS', 'Docker'], { receivedAt: daysAgo(20) }), // 受信20日 → 適合度95
    e('e_Tb', full, { receivedAt: daysAgo(5) }),
    e('e_Ta', full, { receivedAt: daysAgo(5) }), // 同条件は ID 順
    e('e_N0', full, { receivedAt: daysAgo(3) }),
    e('e_N1', full, { receivedAt: daysAgo(1) }), // 同条件は受信の新しい順
    e('e_B', [...full, 'AWS'], { desiredRate: 60 }), // 尚可1/2・粗利20万
    e('e_C', [...full, 'Docker'], { desiredRate: 55 }), // 尚可1/2・粗利25万
    e('e_A', [...full, 'AWS', 'Docker']), // 尚可2/2
  ];
  const pairs = engineers.map((x) => primarySelect([p], [x], undefined, { now: NOW })[0]).filter((x): x is MatchPair => Boolean(x));
  const order = [...pairs].sort(comparePairs).map((x) => x.engineer.id.replace('e_', ''));
  const want = ['A', 'C', 'B', 'N1', 'N0', 'Ta', 'Tb', 'D', 'E', 'G', 'S', 'F1', 'F2', 'R'];
  check(
    '成立（尚可→粗利→受信→ID・受信14日超は後ろ）→ 交渉 → 参考（適合度→完全一致の割合）→ 要確認',
    pairs.length === engineers.length && same(order, want),
    `実際: ${order.join(',')}`,
  );
  const shuffled = [...pairs].reverse().sort(comparePairs).map((x) => x.engineer.id);
  check('入力の順に依らず同じ並び', same(shuffled, [...pairs].sort(comparePairs).map((x) => x.engineer.id)));
  process.env.MAX_CANDIDATES_PER_ITEM = '20';
  const selected = primarySelect([p], [...engineers].reverse(), undefined, { now: NOW }).map((x) => x.engineer.id.replace('e_', ''));
  delete process.env.MAX_CANDIDATES_PER_ITEM;
  check('一次選抜の結果もこの並び', same(selected, want), `実際: ${selected.join(',')}`);
  check('粗利の大きい参考提案が成立候補より前に来ない', order.indexOf('G') > order.indexOf('B'));
}

// ===== 10. 双方向の上限つき割り当て（案件ごと MAX_CANDIDATES_PER_ITEM・要員ごと MAX_PROJECTS_PER_ENGINEER） =====

function allocationChecks(): void {
  section('双方向の上限つき割り当て');
  check(
    '割り当て器: 上から採り、どちらかの上限に達した組は飛ばして次点で埋める',
    same(
      allocateWithCaps(['a1', 'a2', 'b1', 'a3', 'b2', 'c1'], [{ key: (x: string) => x[0], max: 2 }, { key: (x: string) => x[1], max: 2 }]),
      ['a1', 'a2', 'b1', 'b2'],
    ),
  );
  const projects = [1, 2, 3, 4, 5].map((i) => project({ id: `p${i}`, receivedAt: daysAgo(i) }));
  const cheap = engineer(['Java'], { id: 'e_cheap', desiredRate: 50, receivedAt: daysAgo(1) });
  const others = ['e_y', 'e_z'].map((id) => engineer(['Java'], { id, desiredRate: 60, receivedAt: daysAgo(1) }));
  const pairs = primarySelect(projects, [cheap, ...others], undefined, { now: NOW });
  const perEngineer = (id: string) => pairs.filter((x) => x.engineer.id === id).map((x) => x.project.id);
  check('単金の安い1名は最大3案件（新しい案件から）', same(perEngineer('e_cheap'), ['p1', 'p2', 'p3']), show(perEngineer('e_cheap')));
  check('要員ごとの上限3件を超えない', ['e_cheap', 'e_y', 'e_z'].every((id) => perEngineer(id).length <= 3));
  process.env.MAX_CANDIDATES_PER_ITEM = '1';
  const top1 = primarySelect(projects, [cheap, ...others], undefined, { now: NOW }).map((x) => `${x.project.id}:${x.engineer.id}`);
  delete process.env.MAX_CANDIDATES_PER_ITEM;
  check(
    '上限であふれた案件（p4・p5）の枠は次点の要員で埋まる（案件ごと1件のとき）',
    same(top1, ['p1:e_cheap', 'p2:e_cheap', 'p3:e_cheap', 'p4:e_y', 'p5:e_y']),
    top1.join(','),
  );

  const many = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map((id, i) => engineer(['Java'], { id, desiredRate: 50 + i, receivedAt: daysAgo(1) }));
  const one = primarySelect([project({ id: 'p_one', receivedAt: daysAgo(1) })], many, undefined, { now: NOW });
  check('案件ごとの上限5件（粗利の大きい順）', same(one.map((x) => x.engineer.id), ['e1', 'e2', 'e3', 'e4', 'e5']));
  process.env.MAX_PROJECTS_PER_ENGINEER = '1';
  const capped = primarySelect(projects.slice(0, 2), [cheap, ...others], undefined, { now: NOW });
  delete process.env.MAX_PROJECTS_PER_ENGINEER;
  check('MAX_PROJECTS_PER_ENGINEER=1 なら1名1案件', capped.every((x, i, all) => all.findIndex((y) => y.engineer.id === x.engineer.id) === i) && capped.length === 3);

  const judged = primarySelect([project({ id: 'p_one', receivedAt: daysAgo(1) })], many, {
    newProjectIds: new Set(['p_one']),
    newEngineerIds: new Set(),
    judgedMatchIds: new Set([matchIdOf('p_one', 'e1')]),
  }, { now: NOW });
  check('判定済みの組も枠に数えてから除く（続きの回で順位の低い組へ繰り下がらない）', same(judged.map((x) => x.engineer.id), ['e2', 'e3', 'e4', 'e5']));
  const reversed = primarySelect([...projects].reverse(), [...others, cheap].reverse(), undefined, { now: NOW }).map((x) => matchIdOf(x.project.id, x.engineer.id));
  check('入力の順に依らず同じ割り当て', same(reversed, pairs.map((x) => matchIdOf(x.project.id, x.engineer.id))));
}

// ===== 11. 鮮度（受信14日超は並びを少し下げ、SES_STALE_DAYS 超は強マッチにしない） =====

function freshnessChecks(): void {
  section('鮮度');
  const levels: Array<[number, string]> = [[0, 'fresh'], [14, 'fresh'], [15, 'aging'], [45, 'aging'], [46, 'stale']];
  const ng = levels.filter(([d, want]) => freshnessOf(daysAgo(d), NOW).level !== want).map(([d]) => d);
  check('受信0〜14日=fresh・15〜45日=aging・46日〜=stale（既定 SES_STALE_DAYS=45）', ng.length === 0, ng.join(','));
  const pick = (d: number, side: 'p' | 'e') =>
    primarySelectDetailed([project({ receivedAt: side === 'p' ? daysAgo(d) : daysAgo(1) })], [engineer(['Java'], { receivedAt: side === 'e' ? daysAgo(d) : daysAgo(1) })], undefined, { now: NOW });
  const fresh = pick(1, 'p').pairs[0];
  const aging = pick(20, 'p').pairs[0];
  const staleProject = pick(50, 'p');
  const staleEngineer = pick(50, 'e');
  check('鮮度はヒューリスティックの適合スコアにも効く（100 → 95 → 90）', heuristicScore(fresh) === 100 && heuristicScore(aging) === 95 && heuristicScore(staleProject.pairs[0]) === 90);
  check('受信20日: 強マッチのまま（並びだけ下げる）', aging.band === 'strong' && aging.breakdown.freshness.level === 'aging');
  check(
    '案件の受信50日: 参考提案に下げ「要再確認（受信から45日超）」を付ける',
    staleProject.pairs[0].band === 'tentative' && staleProject.pairs[0].cautions.some((c) => c.includes('案件は要再確認（受信から45日超）')) &&
      staleProject.stats.reasons.stale === 1,
  );
  check('要員の受信50日でも同じ', staleEngineer.pairs[0].band === 'tentative' && staleEngineer.pairs[0].cautions.some((c) => c.startsWith('要員は要再確認')));
  process.env.SES_STALE_DAYS = '30';
  const custom = pick(31, 'p').pairs[0];
  delete process.env.SES_STALE_DAYS;
  check('SES_STALE_DAYS=30 なら受信31日で要再確認', custom.band === 'tentative' && custom.cautions.some((c) => c.includes('受信から30日超')));
}

// ===== 12. 内訳の表記（判定根拠・最終判定の入力） =====

function breakdownChecks(): void {
  section('一次選抜の内訳の表記');
  const p = project({ requiredSkills: ['Java', 'Spring Boot'], preferredSkills: ['AWS'], rateMax: 80, receivedAt: daysAgo(1) });
  const strong = primarySelect([p], [engineer(['Java', 'Spring Boot', 'AWS'], { receivedAt: daysAgo(1) })], undefined, { now: NOW })[0];
  const r = buildHeuristicResult(strong);
  check(
    '成立候補の根拠: スキル・尚可・勤務地・時期・粗利・受信日数',
    r.reason.includes('スキル100%（一致2/2）・尚可1/1・勤務地 同一都道府県・時期 不明・粗利20万円・受信1日前'),
    r.reason,
  );
  const implied = primarySelect([p], [engineer(['Spring Boot'], { receivedAt: daysAgo(1) })], undefined, { now: NOW })[0];
  check('含意で満たした必須は「推定」と表記', buildHeuristicResult(implied).reason.includes('スキル100%（2/2: 一致1・推定1）'), buildHeuristicResult(implied).reason);
  const review = primarySelect([p], [engineer(['Java', 'Spring Boot'], { desiredRate: null, receivedAt: daysAgo(1) })], undefined, { now: NOW })[0];
  check('要確認の根拠にも内訳（単金 不明）', buildHeuristicResult(review).reason.includes('単金 不明'));
  const nego = primarySelect([p], [engineer(['Java', 'Spring Boot'], { desiredRate: 75, receivedAt: daysAgo(1) })], undefined, { now: NOW })[0];
  check('交渉提案の根拠に交渉後の粗利', buildHeuristicResult(nego).reason.includes('粗利5万円（交渉で10万円）'), buildHeuristicResult(nego).reason);
  const prompt = buildMatchPrompt(strong);
  check('最終判定の入力に内訳・尚可の一致・受信からの経過を渡す', prompt.includes('内訳: スキル100%') && prompt.includes('尚可スキル一致: 1/1') && prompt.includes('受信からの経過'));
}

// ===== 13. 自社社員（プロパー）→ 案件: 同じ割り当て器（適合が先・単価差は後） =====

function ownMatchChecks(): void {
  section('自社社員 → 案件の並びと上限');
  const own = (id: string, over: Partial<OwnEngineer> = {}): OwnEngineer => ({
    id, displayName: 'A', skills: ['Java', 'Spring Boot', 'Oracle', 'AWS'], experienceYears: 5, requiredProjectRate: 60, residence: '東京都',
    prefecture: '東京都', availableDate: '', availableFrom: null, remoteWish: 'partial', status: 'available', ...over,
  });
  const exact = project({ id: 'p_exact', requiredSkills: ['Java', 'Spring Boot'], rateMax: 60, receivedAt: daysAgo(1) });
  const richer = project({ id: 'p_rich', requiredSkills: ['Java', 'Spring Boot', 'Oracle', 'AWS', 'Docker'], rateMax: 80, receivedAt: daysAgo(1) });
  const partialFit = project({ id: 'p_tent', requiredSkills: ['Java', 'Spring Boot', 'Kotlin'], rateMax: 90, receivedAt: daysAgo(1) });
  const ranked = matchOwnEngineersToProjects([own('o1')], [partialFit, richer, exact], NOW).map((m) => m.projectId);
  check('強マッチの中はスキル適合が先（100%・単価差0 → 80%・単価差20）、参考提案は後', same(ranked, ['p_exact', 'p_rich', 'p_tent']), ranked.join(','));
  const six = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map((id) => own(id));
  const perProject = matchOwnEngineersToProjects(six, [exact], NOW);
  check('案件ごとにも上限（5名）', perProject.length === 5);
  const projects = [1, 2, 3, 4, 5, 6].map((i) => project({ id: `p${i}`, rateMax: 70, receivedAt: daysAgo(i) }));
  check('社員ごとの上限（5件）は従来どおり', matchOwnEngineersToProjects([own('o1', { skills: ['Java'] })], projects, NOW).length === 5);
  check('常駐のみの案件 × フルリモート希望の社員は除外', evaluateOwnMatch(own('o1', { remoteWish: 'full' }), project({ remote: 'none', receivedAt: daysAgo(1) }), NOW) === null);
  const stale = evaluateOwnMatch(own('o1'), project({ requiredSkills: ['Java'], rateMax: 70, receivedAt: daysAgo(50) }), NOW);
  check('受信から45日超の案件は参考提案・要再確認', stale?.band === 'tentative' && stale.reason.includes('要再確認'), stale?.reason);
}

// 手元の .env 等で変えたしきい値に結果が左右されないよう、判定ルールの設定は既定値で検証する
const RULE_ENV_PREFIXES = [
  'SKILL_', 'MATCH_', 'MIN_GROSS_', 'MAX_CANDIDATES', 'MAX_PROJECTS_PER_ENGINEER', 'NEGOTIATION_', 'ENABLE_NEGOTIATION', 'HOURLY_',
  'SES_STALE_DAYS', 'SES_OWN_DOMAINS',
];

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
    dateChecks();
    sanityChecks();
    hardRuleChecks();
    rankingChecks();
    allocationChecks();
    freshnessChecks();
    breakdownChecks();
    ownMatchChecks();
  } finally {
    setDemoOverride(null);
  }
  console.log(`\n=== 結果: ${passed + failed}件中 成功${passed}件・失敗${failed}件 ===`);
  if (failed > 0) process.exitCode = 1;
}

main();
