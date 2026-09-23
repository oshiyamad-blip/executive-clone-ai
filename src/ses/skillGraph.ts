// スキルの含意（有向・子→親）と否定リスト。skillDict.ts の正規形で書く。
// 含意: 子の経験があれば親の必須を満たす（Spring Boot の経験 → Java 必須を満たす）。逆（親だけで子の必須）は満たさない。
// 含意だけで満たした必須はスキル一致の確度を一段下げる（pricing.ts / match.ts）。
// 否定: 名前が似ていても別技術の組。人が登録した同義（skillEquiv.ts）より優先し、その組の同義は効かせない。

const IMPLIES: Record<string, string[]> = {
  'Spring Boot': ['Spring'],
  Spring: ['Java'],
  Struts: ['Java'],
  MyBatis: ['Java'],
  Hibernate: ['Java'],
  Laravel: ['PHP'],
  CakePHP: ['PHP'],
  Symfony: ['PHP'],
  CodeIgniter: ['PHP'],
  'Ruby on Rails': ['Ruby'],
  Django: ['Python'],
  Flask: ['Python'],
  FastAPI: ['Python'],
  'Next.js': ['React'],
  'React Native': ['React'],
  React: ['JavaScript'],
  'Nuxt.js': ['Vue.js'],
  'Vue.js': ['JavaScript'],
  Angular: ['JavaScript'],
  Svelte: ['JavaScript'],
  jQuery: ['JavaScript'],
  TypeScript: ['JavaScript'],
  Express: ['Node.js'],
  NestJS: ['Node.js'],
  'Node.js': ['JavaScript'],
  EKS: ['Kubernetes', 'AWS'],
  ECS: ['AWS'],
  EC2: ['AWS'],
  RDS: ['AWS'],
  Lambda: ['AWS'],
  S3: ['AWS'],
  DynamoDB: ['AWS'],
  CloudFormation: ['AWS'],
  Redshift: ['AWS'],
  GKE: ['Kubernetes', 'GCP'],
  BigQuery: ['GCP'],
  AKS: ['Kubernetes', 'Azure'],
  OpenShift: ['Kubernetes'],
  Apex: ['Salesforce'],
  LWC: ['Salesforce'],
  Visualforce: ['Salesforce'],
  ABAP: ['SAP'],
  'SAP FI': ['SAP'],
  'SAP CO': ['SAP'],
  'SAP MM': ['SAP'],
  'SAP SD': ['SAP'],
  'SAP PP': ['SAP'],
  'SAP S/4HANA': ['SAP'],
  Unity: ['C#'],
  'ASP.NET': ['C#', '.NET'],
  'VB.NET': ['.NET'],
  SwiftUI: ['Swift'],
  Flutter: ['Dart'],
  'Power Apps': ['Power Platform'],
  'Power Automate': ['Power Platform'],
  'Power BI': ['Power Platform'],
  RHEL: ['Linux'],
  CentOS: ['Linux'],
  Ubuntu: ['Linux'],
  'PL/SQL': ['Oracle', 'SQL'],
  'T-SQL': ['SQL Server', 'SQL'],
  MySQL: ['SQL'],
  MariaDB: ['MySQL', 'SQL'],
  PostgreSQL: ['SQL'],
  Oracle: ['SQL'],
  'SQL Server': ['SQL'],
  Db2: ['SQL'],
  Jenkins: ['CI/CD'],
  'GitLab CI': ['CI/CD'],
  'GitHub Actions': ['CI/CD'],
};

// 含意をたどる深さの上限（Spring Boot ⇒ Spring ⇒ Java のような連鎖を拾いつつ、遠い関係で満たさない）
export const IMPLIES_MAX_DEPTH = 3;

const NOT_EQUIVALENT: Array<[string, string]> = [
  ['Java', 'JavaScript'],
  ['Java', 'Kotlin'],
  ['C', 'C#'],
  ['C', 'C++'],
  ['C#', 'C++'],
  ['Go', 'GCP'],
  ['SQL Server', 'MySQL'],
];

const key = (s: string) => s.toLowerCase();

// 小文字の正規形 → 含意される親（小文字）。深さ IMPLIES_MAX_DEPTH まで
const ANCESTORS = new Map<string, Set<string>>();
// 小文字の正規形 → その親を含意する子孫（小文字）
const DESCENDANTS = new Map<string, Set<string>>();

for (const child of Object.keys(IMPLIES)) {
  const found = new Set<string>();
  let frontier = [child];
  for (let depth = 0; depth < IMPLIES_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const parent of IMPLIES[node] ?? []) {
        if (key(parent) === key(child) || found.has(key(parent))) continue;
        found.add(key(parent));
        next.push(parent);
      }
    }
    frontier = next;
  }
  ANCESTORS.set(key(child), found);
  for (const parent of found) {
    if (!DESCENDANTS.has(parent)) DESCENDANTS.set(parent, new Set());
    DESCENDANTS.get(parent)!.add(key(child));
  }
}

const NOT_EQUIVALENT_KEYS = new Set(NOT_EQUIVALENT.flatMap(([a, b]) => [`${key(a)}\u0000${key(b)}`, `${key(b)}\u0000${key(a)}`]));

// child の経験が parent を含意するか（子→親の向きだけ。同じ語は false）
export function impliesSkill(child: string, parent: string): boolean {
  return ANCESTORS.get(key(child))?.has(key(parent)) ?? false;
}

// skill を含意する子孫スキル（小文字の正規形）
export function descendantKeysOf(skill: string): ReadonlySet<string> {
  return DESCENDANTS.get(key(skill)) ?? new Set();
}

// skill から含意される親スキル（小文字の正規形）
export function ancestorKeysOf(skill: string): ReadonlySet<string> {
  return ANCESTORS.get(key(skill)) ?? new Set();
}

// 否定リストの組か（同義として扱ってはいけない）
export function isNotEquivalent(a: string, b: string): boolean {
  return NOT_EQUIVALENT_KEYS.has(`${key(a)}\u0000${key(b)}`);
}

// 含意表・否定リストに書いた語（辞書に正規形があるかを ses:eval:rules で確かめる）
export function skillGraphTerms(): string[] {
  return [...new Set([...Object.keys(IMPLIES), ...Object.values(IMPLIES).flat(), ...NOT_EQUIVALENT.flat()])];
}
