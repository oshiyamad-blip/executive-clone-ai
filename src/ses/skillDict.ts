// スキル正規化（表記ゆれ吸収・分割・バージョン除去）。抽出・DB読出・同義辞書・プロパー取込の全経路が参照する。
// 1つの記載を複数の技術に分ける（1→N）: 'Java(Spring Boot)' → Java, Spring Boot / 'AWS(EC2/RDS)' → AWS, EC2, RDS。
// 辞書に無い語は正規化した表記のまま残す（未知語は skillStats.ts が件数を数え、辞書を育てる材料にする）。
// 含意（Spring Boot ⇒ Java 等）と否定（Java ≠ JavaScript 等）は skillGraph.ts。
import { impliesSkill } from './skillGraph.js';

export type SkillCategory = 'skill' | 'role' | 'phase' | 'domain';

// 先頭が正規形、残りが別名（大文字小文字は区別しない。空白・ハイフン・下線・ドットを除いた形でも引く）
const SKILLS: string[][] = [
  // 言語
  ['Java', 'ジャバ', 'jdk', 'java se', 'java ee', 'jakarta ee', 'j2ee'],
  ['JavaScript', 'js', 'ecmascript', 'es6', 'es2015', 'ジャバスクリプト'],
  ['TypeScript', 'ts'],
  ['Python', 'py', 'パイソン'],
  ['C#', 'csharp', 'c sharp', 'cシャープ'],
  ['C++', 'cplusplus', 'cpp', 'vc++', 'visual c++'],
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
  ['Windows Server', 'winserver', 'windowsサーバ', 'windowsサーバー'],
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
  ['PL', 'プロジェクトリーダー', 'project leader', 'リーダー', 'チームリーダー', 'team leader', 'tl'],
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
  ['上流工程', '上流'],
  ['要件定義', '要求定義'],
  ['基本設計', '外部設計', '概要設計'],
  ['詳細設計', '内部設計'],
  ['製造', '実装', 'コーディング', 'プログラミング'],
  ['テスト', '単体テスト', '結合テスト', '総合テスト', 'システムテスト', '試験'],
  ['運用保守', '運用', '保守', '保守運用'],
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

// 保護語・括弧の置き換え先（区切り文字・数字・括弧を含まない私用領域の文字）
const PLACEHOLDER_BASE = 0xe000;
const BRACKET_BASE = 0xe800;
const PLACEHOLDER_CHAR = /[\uE000-\uE7FF]/g;
const BRACKET_CHAR = /[\uE800-\uEFFF]/g;

const BRACKET_GROUP = /[(\[{<【〔「『〈《]([^()\[\]{}<>【】〔〕「」『』〈〉《》]*)[)\]}>】〕」』〉》]/;
const STRAY_BRACKET = /[()\[\]{}<>【】〔〕「」『』〈〉《》]/g;
// 必須の並び（すべて満たす）を分ける区切り。extract は読点・カンマを ';' にして渡す
const CLAUSE_SEP = /[;,、，\n\r]|\s+and\s+|及び|および|並びに/gi;
// 1つの並びの中の技術を分ける区切り（選択肢の語もここで分ける。「いずれか」かどうかは OR_MARK で決める）
const PIECE_SEP = /[\/・|&+~〜\t]|\s+or\s+|又は|または|もしくは|ないし/gi;
// 選択肢（どれか1つで足りる）の印。「Java or C#」「AWS/GCP/Azureのいずれか」
const OR_MARK = /(?:^|[^a-z])or(?:$|[^a-z])|又は|または|もしくは|ないし|いずれか|どれか|どちらか|のうち/i;
// 「等」「など」は例示でもあり、必須の並び（'Java、Spring Boot、AWS等を用いた開発'）の末尾にも付く。
// 互いに代わりになる技術（クラウド・RDB・フロントのFW）だけが並ぶときに限り選択肢とみなす（'AWS・GCP等'）
const WEAK_OR_MARK = /等|など/;
const INTERCHANGEABLE_GROUPS: string[][] = [
  ['AWS', 'GCP', 'Azure'],
  ['Oracle', 'PostgreSQL', 'MySQL', 'SQL Server', 'Db2', 'MariaDB'],
  ['React', 'Vue.js', 'Angular', 'Svelte', 'Next.js', 'Nuxt.js'],
];
// 括弧の中で親の代わりを認める印（'Kotlin(Javaも可)' は Kotlin か Java のどちらか）
const ALT_MARK = /(?:でも|も)(?:可|ok|構いません|よい|良い)/i;
// 尚可（必須ではない）の印。必須スキルの欄に紛れた「AWS（尚可）」を尚可スキルへ移す
const PREFERRED_MARK = /尚可|なお可|歓迎|優遇|望ましい|あれば/;
const REQUIRED_MARK = /必須/;

// 年数・レベル・経験の語（名前には含めない。年数の構造化は後段の施策で扱う）
const LEVEL_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*[~〜\-]?\s*\d*(?:\.\d+)?\s*(?:年|ヶ月|か月|カ月|ヵ月|箇月)(?:以上|程度|前後|未満|以下|半)?/g,
  /\d+(?:\.\d+)?\s*\+?\s*(?:years?|yrs?)\b/gi,
  /(?:等|など|ほか)(?:[のをでがに].*)?$/, // 'PostgreSQL等のDB' 'AWS等を用いた開発' → 'PostgreSQL' 'AWS'
  /(?:でも|も)(?:可|ok|構いません|よい|良い)$/i, // 'Javaも可' → 'Java'
  /(?:の)?(?:いずれか|どれか|どちらか|のうち)(?:の|で|が)?/g,
  /実務|経験者|経験|以上|程度|レベル|上級|中級|初級|を含む|含む|必須|尚可|なお可|歓迎|優遇|が望ましい|望ましい|あれば/g,
  /(?:での|の|を用いた|を使った|による)(?:開発|実装|構築)\s*$/,
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
// 技術名に続く作業の名詞（'AWS環境構築' 'Linuxサーバ構築' 'AWSでのインフラ構築'）。語幹が辞書にあるときだけ外す
const WORK_NOUN = /(?:での|の|で)?(?:環境|基盤|インフラ|サーバー?)$/;
const TRAILING_PARTICLE = /(?:での|の|で)$/;
// 'SE8' 'SE 11' は Java SE（役割の SE と読まない）
const JAVA_SE_VERSION = /^se\s?\d+(?:\.\d+)*$/i;

function lookup(token: string): string | null {
  const key = token.toLowerCase();
  return ALIAS.get(key) ?? ALIAS_COMPACT.get(compactKey(key)) ?? null;
}

// バージョンを外した語幹は技術のときだけ採る（'SE8' を役割の SE にしない）
function versionStem(stem: string): string | null {
  const hit = lookup(stem);
  return hit && CANONICAL.get(hit.toLowerCase())?.category === 'skill' ? hit : null;
}

function lookupWithoutVersion(token: string): string | null {
  const direct = lookup(token);
  if (direct) return direct;
  if (JAVA_SE_VERSION.test(token)) return 'Java';
  for (const re of ATTACHED_VERSIONS) {
    const attached = token.match(re);
    const hit = attached ? versionStem(attached[1].trim()) : null;
    if (hit) return hit;
  }
  const words = token.split(' ');
  while (words.length > 1 && VERSION_WORD.test(words[words.length - 1])) {
    words.pop();
    const hit = versionStem(words.join(' '));
    if (hit) return hit;
  }
  return null;
}

// 接尾辞・作業の名詞・助詞を1つずつ外し、語幹が辞書にあればその語（'Linuxサーバ構築' → Linux）
function resolve(token: string): string | null {
  const hit = lookupWithoutVersion(token);
  if (hit) return hit;
  let stem = token;
  for (let i = 0; i < 4; i++) {
    let next = stem;
    for (const re of [DROPPABLE_SUFFIX, WORK_NOUN, TRAILING_PARTICLE]) {
      const cut = stem.replace(re, '').trim();
      if (cut && cut !== stem) {
        next = cut;
        break;
      }
    }
    if (next === stem) return null;
    stem = next;
    const found = lookupWithoutVersion(stem);
    if (found) return found;
  }
  return null;
}

function cleanPiece(piece: string): string {
  let s = piece;
  for (const re of LEVEL_PATTERNS) s = s.replace(re, ' ');
  return s
    .replace(/(?:での|の|が|を|で|\s)+$/, '')
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


// 必須・尚可スキルの1要件。members のどれか1つを満たせばその要件を満たす（単一の技術なら1つ）。
// 括弧の補足は、親の具体例（'AWS(EC2/RDS)' 'Oracle(PL/SQL)'。子の経験が親を含意する）か親が辞書に無い総称（'RDB(Oracle/MySQL)'）
// のときだけ親か子のどれかを満たせばよい1要件にする。それ以外の子（'Laravel(PHP)' 'Kotlin(Android)'）は別の要件、
// 業種・役割・工程の補足（'Java(金融系)'）と括弧の中の尚可（'Java(AWS尚可)'）は尚可の要件にする。辞書に無い子（'Java(Stream)'）は
// qualifiers として表記に残すだけで、満たす手段には数えない。選択肢（'Java or C#' 'いずれか'）も1要件にする。
// label は保存・表示する表記で、読み戻して解析し直しても同じ要件になる（'AWS(EC2/RDS)' 'Java / C#（いずれか）'）
export interface SkillRequirement {
  label: string;
  members: string[];
  qualifiers: string[]; // 表記に残す補足（辞書に無い語。満たす手段には数えない）
  preferred: boolean; // 尚可・歓迎の印があった（必須スキルの欄に紛れた尚可を尚可スキルへ移す）
}

// ラムダ式（Java・C# 等の言語機能）を AWS Lambda と読まない言語
const LAMBDA_EXPRESSION_LANGS = new Set(['java', 'kotlin', 'scala', 'c#', 'c++', 'vb.net']);
const LAMBDA_EXPRESSION = 'Lambda式';

interface ParseContext {
  restore: string[];
  brackets: string[];
  lambdaExpression: boolean;
}

function restoreText(s: string, ctx: ParseContext): string {
  return s.replace(PLACEHOLDER_CHAR, (ch) => ctx.restore[ch.charCodeAt(0) - PLACEHOLDER_BASE] ?? '');
}

function bracketContent(ch: string, ctx: ParseContext): string {
  return ctx.brackets[ch.charCodeAt(0) - BRACKET_BASE] ?? '';
}

// 括弧の中の原文（入れ子の括弧も展開する。括弧の中の印を調べる用）
function bracketText(content: string, ctx: ParseContext): string {
  return restoreText(content.replace(BRACKET_CHAR, (ch) => ` ${bracketText(bracketContent(ch, ctx), ctx)} `), ctx);
}

function resolveOne(piece: string, ctx: ParseContext): string | null {
  const name = resolve(piece) ?? (keepUnknown(piece) ? piece : null);
  if (name === 'Lambda' && ctx.lambdaExpression && !/aws|amazon/i.test(piece)) return LAMBDA_EXPRESSION;
  return name;
}

// 1区切りの記載 → 技術名。全体が辞書に無く、空白で分けた各語がすべて辞書にあれば分ける（'Java SpringBoot' 'Oracle PL/SQL'）
function resolveNames(segment: string, ctx: ParseContext): string[] {
  const piece = cleanPiece(restoreText(segment, ctx));
  if (!piece) return [];
  if (resolve(piece) === null && piece.includes(' ')) {
    const words = piece.split(' ').map((w) => resolve(w));
    if (words.length > 1 && words.every((w): w is string => w !== null)) {
      return words.map((w) => (w === 'Lambda' && ctx.lambdaExpression ? LAMBDA_EXPRESSION : w));
    }
  }
  const one = resolveOne(piece, ctx);
  return one ? [one] : [];
}

// 括弧・区切りを含む文字列の技術名をすべて取り出す（括弧の中も。順序を保ち重複を除く）
function flatNames(s: string, ctx: ParseContext): string[] {
  const out: string[] = [];
  for (const raw of s.replace(STRAY_BRACKET, ';').split(CLAUSE_SEP)) {
    for (const piece of raw.split(PIECE_SEP)) {
      out.push(
        ...piece.split(BRACKET_CHAR).flatMap((seg) => resolveNames(seg, ctx)),
        ...[...piece.matchAll(BRACKET_CHAR)].flatMap((m) => flatNames(bracketContent(m[0], ctx), ctx)),
      );
    }
  }
  return uniqueCi(out);
}

// 1つの技術の記載（括弧の印を含む）の読み取り結果
interface PieceParts {
  parents: string[]; // 括弧の外の名前
  alts: string[]; // 親の代わりに満たせる子（親が無いときは括弧の中の名前すべて）
  qualifiers: string[]; // 表記に残すだけの子
  orWithParent: boolean; // 「も可」: 親と子のどれか
  required: string[]; // 別の必須要件にする子
  preferred: string[]; // 尚可の要件にする子
}

function classifyChild(parent: string, child: string, forceRequired: boolean, out: PieceParts): void {
  const parentCat = skillCategory(parent);
  const childCat = skillCategory(child);
  if (parentCat === null) out.alts.push(child); // 総称の親（'RDB(Oracle/MySQL)'）の例示
  else if (childCat === null) out.qualifiers.push(child);
  else if (forceRequired) out.required.push(child);
  else if (impliesSkill(child, parent)) out.alts.push(child); // 親の具体例（'AWS(EC2)'）
  else if (impliesSkill(parent, child)) return; // 親から明らか（'Laravel(PHP)' の PHP）
  else if (childCat !== parentCat && childCat !== 'skill') out.preferred.push(child); // 'Java(金融系)' 'PM(金融系)'
  else out.required.push(child); // 'Kotlin(Android)' 'Unity(C#)' '基本設計(Java)'
}

function pieceOf(piece: string, ctx: ParseContext): PieceParts {
  const parents = uniqueCi(piece.split(BRACKET_CHAR).flatMap((seg) => resolveNames(seg, ctx)));
  const parent = parents[0] ?? null;
  const out: PieceParts = { parents, alts: [], qualifiers: [], orWithParent: false, required: [], preferred: [] };
  for (const m of piece.matchAll(BRACKET_CHAR)) {
    const content = bracketContent(m[0], ctx);
    const names = flatNames(content, ctx).filter((n) => !parents.some((p) => p.toLowerCase() === n.toLowerCase()));
    if (names.length === 0) continue;
    const note = bracketText(content, ctx);
    if (PREFERRED_MARK.test(note)) out.preferred.push(...names);
    else if (!parent) out.alts.push(...names);
    else if (ALT_MARK.test(note)) {
      out.alts.push(...names);
      out.orWithParent = true;
    } else for (const n of names) classifyChild(parent, n, REQUIRED_MARK.test(note), out);
  }
  return {
    ...out,
    alts: uniqueCi(out.alts),
    qualifiers: uniqueCi(out.qualifiers),
    required: uniqueCi(out.required),
    preferred: uniqueCi(out.preferred),
  };
}

// 印の判定に使う本文（括弧の中は「（尚可）」「（いずれか）」のように技術名を含まない注記だけを含める。
// 'Java(AWS尚可)' の尚可を Java に掛けないため。括弧の中の尚可は pieceOf が子だけに掛ける）
function markText(s: string, ctx: ParseContext): string {
  return restoreText(
    s.replace(BRACKET_CHAR, (ch) => {
      const content = bracketContent(ch, ctx);
      return flatNames(content, ctx).length === 0 ? ` ${markText(content, ctx)} ` : ' ';
    }),
    ctx,
  );
}

function uniqueCi(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function singleReq(name: string, preferred: boolean): SkillRequirement {
  return { label: name, members: [name], qualifiers: [], preferred };
}

function parentReq(parent: string, parts: PieceParts, preferred: boolean): SkillRequirement {
  if (parts.orWithParent) return anyOfReq([parent, ...parts.alts].map((n) => singleReq(n, preferred)), preferred);
  const kids = uniqueCi([...parts.alts, ...parts.qualifiers]).filter((c) => c.toLowerCase() !== parent.toLowerCase());
  if (kids.length === 0) return singleReq(parent, preferred);
  return { label: `${parent}(${kids.join('/')})`, members: uniqueCi([parent, ...parts.alts]), qualifiers: [...parts.qualifiers], preferred };
}

function anyOfReq(reqs: SkillRequirement[], preferred: boolean): SkillRequirement {
  const members = uniqueCi(reqs.flatMap((r) => r.members));
  if (reqs.length === 1) return { ...reqs[0], preferred };
  if (members.length === 1) return singleReq(members[0], preferred);
  return {
    label: `${reqs.map((r) => r.label).join(' / ')}（いずれか）`,
    members,
    qualifiers: uniqueCi(reqs.flatMap((r) => r.qualifiers)),
    preferred,
  };
}

function uniqueReqs(reqs: SkillRequirement[]): SkillRequirement[] {
  const seen = new Set<string>();
  return reqs.filter((r) => {
    const k = r.label.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 要件がすべて同じ「互いに代わりになる」群の技術か（その具体例を含む。'AWS(EC2)' はクラウド）
function interchangeable(reqs: SkillRequirement[]): boolean {
  const members = reqs.flatMap((r) => r.members);
  return INTERCHANGEABLE_GROUPS.some((group) =>
    members.every((m) => group.some((g) => g.toLowerCase() === m.toLowerCase() || impliesSkill(m, g))),
  );
}

function parseWith(text: string, lambdaExpression: boolean): SkillRequirement[] {
  const ctx: ParseContext = { restore: [], brackets: [], lambdaExpression };
  let s = REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), text);
  for (const re of PROTECTED_RES) {
    s = s.replace(re, (hit) => {
      if (ctx.restore.length >= BRACKET_BASE - PLACEHOLDER_BASE) return hit;
      ctx.restore.push(hit);
      return String.fromCharCode(PLACEHOLDER_BASE + ctx.restore.length - 1);
    });
  }
  // 括弧は内側から印に置き換える（印の位置で親と子を対応付ける）
  for (let m = s.match(BRACKET_GROUP); m && m.index !== undefined && ctx.brackets.length < 0x800; m = s.match(BRACKET_GROUP)) {
    ctx.brackets.push(m[1]);
    s = `${s.slice(0, m.index)}${String.fromCharCode(BRACKET_BASE + ctx.brackets.length - 1)}${s.slice(m.index + m[0].length)}`;
  }
  s = s.replace(STRAY_BRACKET, ';');

  const out: SkillRequirement[] = [];
  const extra: SkillRequirement[] = []; // 括弧の子から分けた要件（選択肢にはまとめない）
  let itemAnyOf = false;
  let itemWeakAnyOf = false;
  for (const clause of s.split(CLAUSE_SEP)) {
    const clauseMarks = markText(clause, ctx);
    const clausePreferred = PREFERRED_MARK.test(clauseMarks);
    const strongOr = OR_MARK.test(clauseMarks);
    const reqs: SkillRequirement[] = [];
    const clauseExtra: SkillRequirement[] = [];
    let explicitRequired = false;
    for (const piece of clause.split(PIECE_SEP)) {
      const parts = pieceOf(piece, ctx);
      const pieceRequired = REQUIRED_MARK.test(markText(piece, ctx));
      if (pieceRequired) explicitRequired = true;
      const preferred = clausePreferred && !pieceRequired;
      if (parts.parents.length === 0) reqs.push(...parts.alts.map((c) => singleReq(c, preferred)));
      else {
        reqs.push(parentReq(parts.parents[0], parts, preferred));
        reqs.push(...parts.parents.slice(1).map((n) => singleReq(n, preferred)));
      }
      // 選択肢の並びの中の子（'Kotlin(Android) or Swift(iOS)' の Android）は必須にしない
      clauseExtra.push(...parts.required.map((n) => singleReq(n, preferred || strongOr)), ...parts.preferred.map((n) => singleReq(n, true)));
    }
    extra.push(...clauseExtra);
    const unique = uniqueReqs(reqs);
    if (unique.length === 0) continue;
    const weakOr = !strongOr && WEAK_OR_MARK.test(clauseMarks);
    if (strongOr || (weakOr && unique.length >= 2 && interchangeable(unique))) {
      // 並びの中に選択肢があればその並びを1要件に。1語だけの並び（'AWS、GCP、Azureのいずれか' の最後）なら項目全体を1要件にする
      if (unique.length >= 2) out.push(anyOfReq(unique, clausePreferred && !explicitRequired));
      else {
        itemAnyOf = true;
        out.push(...unique);
      }
    } else {
      if (weakOr && unique.length === 1) itemWeakAnyOf = true;
      out.push(...unique);
    }
  }
  const reqs = uniqueReqs(out);
  const tail = uniqueReqs(extra);
  const required = reqs.filter((r) => !r.preferred);
  const preferred = reqs.filter((r) => r.preferred);
  const merge = (list: SkillRequirement[]) =>
    itemAnyOf || (itemWeakAnyOf && interchangeable(list)) ? (list.length > 0 ? [anyOfReq(list, list[0].preferred)] : []) : list;
  if ((!itemAnyOf && !itemWeakAnyOf) || reqs.length < 2) return uniqueReqs([...reqs, ...tail]);
  return uniqueReqs([...merge(required), ...merge(preferred), ...tail]);
}

function parseUncached(raw: string): SkillRequirement[] {
  // 丸数字は NFKC で数字になり語に付いてしまうため、先に区切りにする
  const text = raw.replace(/[①-⑳]/g, ' / ').normalize('NFKC').replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];
  const whole = resolve(text);
  if (whole) return [singleReq(whole, false)];
  const reqs = parseWith(text, false);
  // 'Java8(Stream/Lambda)' の Lambda はラムダ式（AWS の文脈が無く、ラムダ式のある言語と並ぶとき）
  const names = reqs.flatMap((r) => [...r.members, ...r.qualifiers]);
  if (lambdaIsExpression(names, text)) return parseWith(text, true);
  return reqs;
}

// Lambda をラムダ式と読むか（AWS・Amazon の記載や AWS を含意する技術が無く、ラムダ式のある言語と並ぶとき）
function lambdaIsExpression(names: string[], text: string): boolean {
  const keys = new Set(names.map((m) => m.toLowerCase()));
  if (!keys.has('lambda') || /aws|amazon/i.test(text)) return false;
  const awsContext = [...keys].some((m) => m !== 'lambda' && (m === 'aws' || impliesSkill(m, 'AWS')));
  return !awsContext && [...keys].some((m) => LAMBDA_EXPRESSION_LANGS.has(m));
}

const reqCache = new Map<string, SkillRequirement[]>();
const TOKEN_CACHE_MAX = 20_000;

// 1つの記載 → 要件の配列（必須・尚可スキル用。選択肢・括弧の補足は1要件にまとめる）
export function parseRequirements(raw: string): SkillRequirement[] {
  let cached = reqCache.get(raw);
  if (!cached) {
    cached = parseUncached(raw);
    if (reqCache.size >= TOKEN_CACHE_MAX) reqCache.clear();
    reqCache.set(raw, cached);
  }
  return cached.map((r) => ({ ...r, members: [...r.members], qualifiers: [...r.qualifiers] }));
}

// 1つの記載 → 正規化したスキル名の配列（辞書にあれば正規形、無ければ正規化した表記）。
// 要員のスキル・同義辞書・集計用で、選択肢や括弧の補足も1語ずつに分ける
export function tokenizeSkill(raw: string): string[] {
  return uniqueCi(parseRequirements(raw).flatMap((r) => [...r.members, ...r.qualifiers]));
}

// 1つのスキル名として正規化する（同義辞書の照合キー用）。複数の技術に分かれる記載は分けずに
// NFKC・空白の正規化だけをした表記を返す（1語かどうかは tokenizeSkill で確かめる）
export function normalizeSkill(raw: string): string {
  const tokens = tokenizeSkill(raw);
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 0) return '';
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// スキルの配列を正規化する（各要素を分割・正規化し、大文字小文字を無視して重複を除く。出現順は保つ）。要員のスキル用
// 抽出は括弧の中を別の要素に分けるため（'Java8(Stream/Lambda)' → 'Java', 'Stream', 'Lambda'）、ラムダ式かどうかは配列全体で決める
export function normalizeSkills(raw: string[]): string[] {
  const tokens = uniqueCi(raw.flatMap((item) => tokenizeSkill(item)));
  const lambdaRaw = raw.filter((item) => tokenizeSkill(item).some((t) => t.toLowerCase() === 'lambda'));
  if (lambdaRaw.length === 0 || !lambdaIsExpression(tokens, lambdaRaw.join(' '))) return tokens;
  return uniqueCi(tokens.map((t) => (t.toLowerCase() === 'lambda' ? LAMBDA_EXPRESSION : t)));
}

// 案件の必須・尚可スキルを要件の表記の配列にする。必須の欄に「尚可」「歓迎」の印がある要件は尚可へ移す
// （抽出・DB読出の両方で使う。既存の行も読出時に救済される）
export function normalizeRequirementLists(requiredRaw: string[], preferredRaw: string[]): { required: string[]; preferred: string[] } {
  const seen = new Set<string>();
  const required: string[] = [];
  const preferred: string[] = [];
  const add = (list: string[], label: string) => {
    const k = label.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    list.push(label);
  };
  const moved: string[] = [];
  for (const item of requiredRaw) {
    for (const r of parseRequirements(item)) {
      if (r.preferred) moved.push(r.label);
      else add(required, r.label);
    }
  }
  for (const label of moved) add(preferred, label);
  for (const item of preferredRaw) for (const r of parseRequirements(item)) add(preferred, r.label);
  return { required, preferred };
}

// 要件の表記の配列 → 含まれる技術名（集計・表示用に1語ずつ）
export function requirementMembers(labels: string[]): string[] {
  return uniqueCi(labels.flatMap((l) => parseRequirements(l).flatMap((r) => [...r.members, ...r.qualifiers])));
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
const PERSON_NAME_LIKE = /^(?:[\u4E00-\u9FFF\u3005]{2,6}|[ァ-ヺー]{2,6}|[ぁ-ゖー]{2,8})$/;
// ローマ字の氏名らしい語（'Yamada' 'Taro Yamada' 'yamada taro'）。数字・記号を含まない1〜3語の英字で、どの語も辞書に無いもの
const ROMAJI_NAME_LIKE = /^[A-Za-z][a-z]+(?: [A-Za-z][a-z]+){0,2}$/;

// 1語の英字の未知語は、日本語の音節（ヘボン式のかな）だけでできているときだけ氏名とみなす（'Yamada' 'Suzuki' は数えず、
// 'Redux' 'Recoil' は数える）
const ROMAJI_SYLLABLES = /^(?:(?:[kstpgc](?=[kstpgc]))?(?:ky|gy|sh|ch|ts|ny|hy|my|ry|by|py|j|[kgsztdnhbpmyrwf])?[aiueo]|n)+$/i;

function nameKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s.・]/g, '');
}

// 未知語の集計から外す語か（表示名・営業元の会社名や担当者名と同じ語、敬称付きの語。人名・社名の混入を数えない）。
// 辞書にある語は人名・社名とみなさない（社名に「インフラ」が含まれても、技術・役割として数える）
export function isNameLikeToken(token: string, names: string[]): boolean {
  if (isKnownSkill(token)) return false;
  if (HONORIFIC.test(token)) return true;
  // 表示名はイニシャルだけのため、氏名そのものとは照合できない。辞書に無い漢字2〜4文字・カタカナ3文字以下の語は
  // 氏名の混入の恐れがあるため数えない（「山田」「佐々木」「ヤマダ」。技術名の未知語はほぼ英字か長いカタカナ）
  if (PERSON_NAME_LIKE.test(token.normalize('NFKC').replace(/\s+/g, ''))) return true;
  // 英字の未知語のうち、先頭だけ大文字（または全部小文字）で語がすべて辞書に無いものも氏名の恐れがあるため数えない
  // （技術名の未知語は 'Redux' 'Recoil' のような1語が多く件数には影響するが、公開の辞書へ氏名を載せる事故を防ぐ方を採る）
  const t = token.normalize('NFKC').trim();
  if (ROMAJI_NAME_LIKE.test(t) && (t.includes(' ') || ROMAJI_SYLLABLES.test(t)) && t.split(' ').every((w) => !isKnownSkill(w))) return true;
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

// DB読出用: 案件の必須・尚可スキルのセル（またはマルチセレクト）を要件の表記に（Project のフィールド名で返す）
export function requirementsOf(requiredRaw: string[], preferredRaw: string[]): { requiredSkills: string[]; preferredSkills: string[] } {
  const r = normalizeRequirementLists(requiredRaw, preferredRaw);
  return { requiredSkills: r.required, preferredSkills: r.preferred };
}
