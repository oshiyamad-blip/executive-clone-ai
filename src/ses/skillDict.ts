// スキル正規化（表記ゆれ吸収・分割・バージョン除去）。抽出・DB読出・同義辞書・プロパー取込の全経路が参照する。
// 1つの記載を複数の技術に分ける（1→N）: 'Java(Spring Boot)' → Java, Spring Boot / 'AWS(EC2/RDS)' → AWS, EC2, RDS。
// 辞書に無い語は正規化した表記のまま残す（未知語は skillStats.ts が件数を数え、辞書を育てる材料にする）。
// 含意（Spring Boot ⇒ Java 等）と否定（Java ≠ JavaScript 等）は skillGraph.ts。

export type SkillCategory = 'skill' | 'role' | 'phase' | 'domain';

// 先頭が正規形、残りが別名（大文字小文字は区別しない。空白・ハイフン・下線・ドットを除いた形でも引く）
const SKILLS: string[][] = [
  // 言語
  ['Java', 'ジャバ', 'jdk', 'java se', 'java ee', 'jakarta ee', 'j2ee'],
  ['JavaScript', 'js', 'ecmascript', 'es6', 'es2015', 'ジャバスクリプト'],
  ['TypeScript', 'ts'],
  ['Python', 'py', 'パイソン'],
  ['C#', 'csharp', 'c sharp', 'cシャープ'],
  ['C++', 'cplusplus', 'cpp'],
  ['C', 'c言語'],
  ['PHP'],
  ['Ruby', 'ルビー'],
  ['Go', 'golang', 'go言語'],
  ['Kotlin'],
  ['Swift'],
  ['Objective-C', 'objc', 'obj-c'],
  ['Scala'],
  ['Rust'],
  ['R', 'r言語'],
  ['Perl'],
  ['COBOL', 'コボル'],
  ['VB.NET', 'visual basic .net'],
  ['VB', 'visual basic'],
  ['VBA', 'excel vba', 'access vba', 'エクセルvba', 'excelマクロ'],
  ['Shell', 'shellscript', 'shell script', 'シェル', 'シェルスクリプト', 'bash'],
  ['PowerShell'],
  ['SQL'],
  ['PL/SQL', 'plsql'],
  ['T-SQL', 'transact-sql'],
  ['HTML', 'html5'],
  ['CSS', 'css3', 'scss', 'sass'],
  ['Dart'],
  ['ABAP'],
  ['Apex'],
  ['JCL'],
  ['RPG'],
  ['AS/400', 'ibm i', 'iseries'],
  // フレームワーク・ライブラリ
  ['Spring', 'spring framework', 'spring mvc'],
  ['Spring Boot'],
  ['Struts', 'apache struts'],
  ['MyBatis', 'ibatis'],
  ['Hibernate'],
  ['Laravel'],
  ['CakePHP'],
  ['Symfony'],
  ['CodeIgniter'],
  ['Ruby on Rails', 'rails', 'ror'],
  ['Django'],
  ['Flask'],
  ['FastAPI'],
  ['React', 'react.js', 'リアクト'],
  ['React Native'],
  ['Next.js'],
  ['Vue.js', 'vue'],
  ['Nuxt.js', 'nuxt'],
  ['Angular', 'angularjs'],
  ['Svelte', 'sveltekit'],
  ['jQuery'],
  ['Node.js', 'node'],
  ['Express', 'express.js'],
  ['NestJS', 'nest'],
  ['Flutter'],
  ['SwiftUI'],
  ['ASP.NET', 'asp.net core', 'asp.net mvc'],
  ['.NET', 'dotnet', '.net framework', '.net core'],
  ['Unity', 'unity3d'],
  ['Android'],
  ['iOS'],
  ['TensorFlow'],
  ['PyTorch'],
  ['機械学習', 'machine learning', 'ml', 'deep learning', 'ディープラーニング'],
  ['Selenium'],
  // クラウド・データ基盤
  ['AWS', 'amazon web services'],
  ['EC2', 'amazon ec2'],
  ['RDS', 'amazon rds'],
  ['Lambda', 'aws lambda'],
  ['S3', 'amazon s3'],
  ['EKS', 'amazon eks'],
  ['ECS', 'amazon ecs'],
  ['DynamoDB'],
  ['CloudFormation'],
  ['Redshift', 'amazon redshift'],
  ['GCP', 'google cloud', 'google cloud platform'],
  ['GKE'],
  ['BigQuery'],
  ['Azure', 'microsoft azure'],
  ['AKS'],
  ['Snowflake'],
  ['Databricks'],
  ['Airflow', 'apache airflow'],
  ['Firebase'],
  // DB
  ['MySQL'],
  ['PostgreSQL', 'postgres', 'postgre', 'ポスグレ'],
  ['Oracle', 'oracle database', 'oracle db', 'オラクル'],
  ['SQL Server', 'mssql', 'ms sql server', 'microsoft sql server'],
  ['Db2'],
  ['MariaDB'],
  ['MongoDB', 'mongo'],
  ['Redis'],
  ['Elasticsearch'],
  // インフラ・OS・NW・ツール
  ['Linux'],
  ['RHEL', 'red hat', 'red hat enterprise linux'],
  ['CentOS'],
  ['Ubuntu'],
  ['UNIX', 'solaris', 'aix', 'hp-ux'],
  ['Windows Server', 'winserver'],
  ['Windows'],
  ['Active Directory', 'ad'],
  ['VMware', 'vsphere', 'esxi'],
  ['Docker'],
  ['Kubernetes', 'k8s'],
  ['OpenShift'],
  ['Terraform'],
  ['Ansible'],
  ['Nginx'],
  ['Apache', 'apache http server', 'httpd'],
  ['Tomcat', 'apache tomcat'],
  ['WebLogic'],
  ['JP1'],
  ['HULFT'],
  ['Zabbix'],
  ['Splunk'],
  ['Datadog'],
  ['Jenkins'],
  ['GitLab CI', 'gitlab ci/cd'],
  ['GitHub Actions'],
  ['CI/CD'],
  ['Git'],
  ['TCP/IP'],
  ['Cisco', 'cisco ios'],
  ['UI/UX'],
  ['Figma'],
  ['JIRA'],
  // SaaS・ERP
  ['Salesforce', 'sfdc', 'セールスフォース'],
  ['LWC', 'lightning web components', 'lightning web component'],
  ['Visualforce'],
  ['SAP', 'sap ecc', 'sap erp'],
  ['SAP FI', 'fi'],
  ['SAP CO', 'co'],
  ['SAP MM', 'mm'],
  ['SAP SD', 'sd'],
  ['SAP PP'],
  ['SAP S/4HANA', 's/4hana', 's4hana', 's4 hana'],
  ['ServiceNow'],
  ['kintone', 'キントーン'],
  ['Power Platform'],
  ['Power Apps'],
  ['Power Automate'],
  ['Power BI'],
  ['Dynamics 365', 'dynamics', 'd365'],
  ['SharePoint'],
  ['Microsoft 365', 'm365', 'office365', 'office 365'],
  ['Tableau'],
];

const ROLES: string[][] = [
  ['PM', 'プロジェクトマネージャー', 'プロジェクトマネージャ', 'project manager'],
  ['PL', 'プロジェクトリーダー', 'project leader'],
  ['PMO'],
  ['SE', 'システムエンジニア'],
  ['PG', 'プログラマー', 'プログラマ', 'programmer'],
  ['テスター', 'tester', 'テストエンジニア'],
  ['QA', '品質保証', 'qaエンジニア'],
  ['インフラ', 'インフラエンジニア', 'infra', 'infrastructure'],
  ['NW', 'ネットワーク', 'ネットワークエンジニア', 'nwエンジニア', 'network'],
  ['DBA', 'dbエンジニア', 'データベースエンジニア'],
  ['SRE'],
  ['ヘルプデスク', 'help desk', 'helpdesk'],
];

const PHASES: string[][] = [
  ['要件定義', '要求定義'],
  ['基本設計', '外部設計', '概要設計'],
  ['詳細設計', '内部設計'],
  ['製造', '実装', 'コーディング', 'プログラミング'],
  ['テスト', '単体テスト', '結合テスト', '総合テスト', 'システムテスト', '試験'],
  ['運用保守', '運用', '保守'],
];

const DOMAINS: string[][] = [
  ['金融', '金融系', '銀行', '銀行系', 'バンキング'],
  ['証券', '証券系'],
  ['保険', '保険系', '生保', '損保', '生命保険', '損害保険'],
  ['公共', '公共系', '官公庁', '自治体'],
  ['EC', 'ecサイト', 'eコマース', 'e-commerce', '通販'],
  ['製造業', 'メーカー'],
  ['物流', '物流系', 'ロジスティクス'],
  ['医療', '医療系', 'ヘルスケア', '電子カルテ'],
  ['通信', '通信系'],
  ['流通', '流通系', '小売'],
];

const GROUPS: Array<[SkillCategory, string[][]]> = [
  ['skill', SKILLS],
  ['role', ROLES],
  ['phase', PHASES],
  ['domain', DOMAINS],
];

// 空白・ハイフン・下線・ドットを除いた照合キー（'Spring-Boot' 'springboot' 'Node JS' を同じ語として引く）
function compactKey(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]/g, '');
}

const CANONICAL = new Map<string, { name: string; category: SkillCategory }>(); // 小文字の正規形 → 正規形
const ALIAS = new Map<string, string>(); // 小文字の表記 → 正規形
const ALIAS_COMPACT = new Map<string, string>(); // compactKey → 正規形
const DICTIONARY_ISSUES: string[] = []; // 別の正規形が同じ表記・照合キーになった組（辞書の不備。ses:eval:rules で検出）

for (const [category, entries] of GROUPS) {
  for (const [name, ...aliases] of entries) {
    CANONICAL.set(name.toLowerCase(), { name, category });
    for (const form of [name, ...aliases]) {
      const key = form.normalize('NFKC').toLowerCase();
      const prevAlias = ALIAS.get(key);
      if (prevAlias && prevAlias !== name) DICTIONARY_ISSUES.push(`表記 ${key}: ${prevAlias} / ${name}`);
      else ALIAS.set(key, name);
      const compact = compactKey(key);
      const prevCompact = ALIAS_COMPACT.get(compact);
      if (prevCompact && prevCompact !== name) DICTIONARY_ISSUES.push(`照合キー ${compact}: ${prevCompact} / ${name}`);
      else ALIAS_COMPACT.set(compact, name);
    }
  }
}

// 区切り文字を含む正規形・別名（分割の前に保護する）。'C/C++' は保護せず C と C++ に分ける
const PROTECTED = [...new Set([...ALIAS.keys()].filter((k) => /[\/+&・,;]/.test(k)).concat(['c++', 'notepad++', 'r&d']))].sort(
  (a, b) => b.length - a.length,
);
const PROTECTED_RES = PROTECTED.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));

// 2つの技術をつなげて書く慣用表記（分割の前に区切りを入れる）
const REWRITES: Array<[RegExp, string]> = [[/c#\s*\.net(?![a-z])/gi, 'C#/.NET']];

// 保護語の置き換え先（区切り文字・数字・括弧を含まない私用領域の文字）
const PLACEHOLDER_BASE = 0xe000;

const BRACKET_GROUP = /[(\[{<【〔「『〈《]([^()\[\]{}<>【】〔〕「」『』〈〉《》]*)[)\]}>】〕」』〉》]/;
const STRAY_BRACKET = /[()\[\]{}<>【】〔〕「」『』〈〉《》]/g;
const SEPARATOR = /[\/,;&+・、|~〜\n\r\t]|\s+(?:and|or)\s+|及び|および|並びに|又は|または|もしくは/gi;
const SEP = '\u0001';

// 年数・レベル・経験の語（名前には含めない。年数の構造化は後段の施策で扱う）
const LEVEL_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*[~〜\-]?\s*\d*(?:\.\d+)?\s*(?:年|ヶ月|か月|カ月|ヵ月|箇月)(?:以上|程度|前後|未満|以下|半)?/g,
  /\d+(?:\.\d+)?\s*\+?\s*(?:years?|yrs?)\b/gi,
  /実務|経験者|経験|以上|程度|レベル|上級|中級|初級|を含む|含む|必須|尚可|歓迎|優遇/g,
  /(?:での|の|を用いた|を使った|による)(?:開発|実装|構築)\s*$/,
  /(?:等|など|ほか)\s*$/,
];

// それだけでは技術名にならない語（括弧内の補足等。分割後の要素がこれなら捨てる）
const NOISE = new Set([
  'あり', '有', 'なし', '無', '可', '他', 'その他', '業務', '使用', '利用', '独学', '学習中',
  '読み書き', '少々', '趣味', '個人開発', '年',
]);

// 末尾のバージョン。語幹が辞書にあるときだけ外す（'S3' 'EC2' 'Route53' のように数字まで含めて1つの名前のものを壊さない）
// Python3 C++17 Oracle11g JDK1.8 SQLServer2016（'v' 付きは別に試す。'SQLServer2016' を 'SQLSer'+'ver2016' と読まないため）
const ATTACHED_VERSIONS = [
  /^(.*?[^\d\s.\-_])[\-_]?\d+(?:\.\d+)*(?:\.x)?[a-z]{0,2}\+?$/i,
  /^(.*?[^\d\s.\-_])[\-_]?(?:v|ver\.?)\d+(?:\.\d+)*(?:\.x)?[a-z]{0,2}\+?$/i,
];
const VERSION_WORD = /^(?:(?:v|ver\.?|version)?\d+(?:\.\d+)*(?:\.x)?[a-z]{0,2}\+?|r\d+|sp\d+|update\d+)$/i; // Windows Server 2019 R2
// 語幹が辞書にあるときだけ外す接尾辞（'Java系' 'C++言語' 'テスト工程' 'インフラ構築'）
const DROPPABLE_SUFFIX = /(?:系|言語|工程|業務|構築|開発)$/;

function lookup(token: string): string | null {
  const key = token.toLowerCase();
  return ALIAS.get(key) ?? ALIAS_COMPACT.get(compactKey(key)) ?? null;
}

function lookupWithoutVersion(token: string): string | null {
  const direct = lookup(token);
  if (direct) return direct;
  for (const re of ATTACHED_VERSIONS) {
    const attached = token.match(re);
    const hit = attached ? lookup(attached[1].trim()) : null;
    if (hit) return hit;
  }
  const words = token.split(' ');
  while (words.length > 1 && VERSION_WORD.test(words[words.length - 1])) {
    words.pop();
    const hit = lookup(words.join(' '));
    if (hit) return hit;
  }
  return null;
}

function resolve(token: string): string | null {
  const hit = lookupWithoutVersion(token);
  if (hit) return hit;
  const stem = token.replace(DROPPABLE_SUFFIX, '').trim();
  return stem && stem !== token ? lookupWithoutVersion(stem) : null;
}

function cleanPiece(piece: string): string {
  let s = piece;
  for (const re of LEVEL_PATTERNS) s = s.replace(re, ' ');
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-・:：。*※•●○◆◇■□>]+|[\s\-・:：、。*※]+$/g, '')
    .trim();
}

// 未知語として残す価値があるか（数字・記号だけの語、辞書に無い英字1文字は捨てる。'R' 'C' は辞書にあるので残る）
function keepUnknown(token: string): boolean {
  if (!token || NOISE.has(token.toLowerCase())) return false;
  if (!/\p{L}/u.test(token)) return false;
  return !/^[a-z]$/i.test(token);
}

const tokenCache = new Map<string, string[]>();
const TOKEN_CACHE_MAX = 20_000;

// 1つの記載 → 正規化したスキル名の配列（辞書にあれば正規形、無ければ正規化した表記）
export function tokenizeSkill(raw: string): string[] {
  const cached = tokenCache.get(raw);
  if (cached) return [...cached];
  const result = tokenizeUncached(raw);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(raw, result);
  return [...result];
}

function tokenizeUncached(raw: string): string[] {
  // 丸数字は NFKC で数字になり語に付いてしまうため、先に区切りにする
  const text = raw.replace(/[①-⑳]/g, ' / ').normalize('NFKC').replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];
  const whole = resolve(text);
  if (whole) return [whole];

  const restore: string[] = [];
  let s = REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), text);
  for (const re of PROTECTED_RES) {
    s = s.replace(re, (hit) => {
      restore.push(hit);
      return String.fromCharCode(PLACEHOLDER_BASE + restore.length - 1);
    });
  }

  // 括弧は内側から取り出し、外側（親）も残す
  const parts: string[] = [];
  for (let m = s.match(BRACKET_GROUP); m && m.index !== undefined; m = s.match(BRACKET_GROUP)) {
    parts.push(m[1]);
    s = `${s.slice(0, m.index)}${SEP}${s.slice(m.index + m[0].length)}`;
  }
  parts.unshift(s);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const rawPiece of part.replace(STRAY_BRACKET, SEP).replace(SEPARATOR, SEP).split(SEP)) {
      const restored = rawPiece.replace(/[-]/g, (ch) => restore[ch.charCodeAt(0) - PLACEHOLDER_BASE] ?? '');
      const piece = cleanPiece(restored);
      if (!piece) continue;
      const name = resolve(piece) ?? (keepUnknown(piece) ? piece : null);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

// 1つのスキル名として正規化する（同義辞書の照合キー用）。複数の技術に分かれる記載は分けずに
// NFKC・空白の正規化だけをした表記を返す（1語かどうかは tokenizeSkill で確かめる）
export function normalizeSkill(raw: string): string {
  const tokens = tokenizeSkill(raw);
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 0) return '';
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// スキルの配列を正規化する（各要素を分割・正規化し、大文字小文字を無視して重複を除く。出現順は保つ）
export function normalizeSkills(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    for (const token of tokenizeSkill(item)) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

// 辞書にある正規形か（tokenizeSkill の出力に対して使う）
export function isKnownSkill(token: string): boolean {
  return CANONICAL.has(token.toLowerCase());
}

export function skillCategory(token: string): SkillCategory | null {
  return CANONICAL.get(token.toLowerCase())?.category ?? null;
}

export function canonicalSkillNames(): string[] {
  return [...CANONICAL.values()].map((v) => v.name);
}

export function skillDictionaryIssues(): string[] {
  return [...DICTIONARY_ISSUES];
}

const HONORIFIC = /(様|さん|氏|殿|御中|君)$/;

function nameKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s.・]/g, '');
}

// 未知語の集計から外す語か（表示名・営業元の会社名や担当者名と同じ語、敬称付きの語。人名・社名の混入を数えない）。
// 辞書にある語は人名・社名とみなさない（社名に「インフラ」が含まれても、技術・役割として数える）
export function isNameLikeToken(token: string, names: string[]): boolean {
  if (isKnownSkill(token)) return false;
  if (HONORIFIC.test(token)) return true;
  const key = nameKey(token);
  if (!key) return true;
  return names.some((n) => {
    const nk = nameKey(n);
    return nk.length > 0 && (nk === key || (key.length >= 2 && nk.includes(key)));
  });
}

// 1件分のスキル語の分類（集計用）。counted=数える語、unknown=そのうち辞書に無い語
export function classifySkillTokens(tokens: string[], names: string[]): { counted: string[]; unknown: string[] } {
  const counted = tokens.filter((t) => !isNameLikeToken(t, names));
  return { counted, unknown: counted.filter((t) => !isKnownSkill(t)) };
}
