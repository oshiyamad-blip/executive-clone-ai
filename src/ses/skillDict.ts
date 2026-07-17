// スキル正規化辞書（表記ゆれ吸収）。extract/match の双方が参照する。
// 辞書は初期は小規模でよく、Phase 1 の実メール検証で拡充する（要件定義のTest段階）。
const SKILL_DICT: Record<string, string> = {
  java: 'Java',
  ジャバ: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  python: 'Python',
  py: 'Python',
  'c#': 'C#',
  csharp: 'C#',
  'c++': 'C++',
  cplusplus: 'C++',
  php: 'PHP',
  ruby: 'Ruby',
  go: 'Go',
  golang: 'Go',
  kotlin: 'Kotlin',
  swift: 'Swift',
  aws: 'AWS',
  gcp: 'GCP',
  'google cloud': 'GCP',
  azure: 'Azure',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  k8s: 'Kubernetes',
  react: 'React',
  vue: 'Vue.js',
  'vue.js': 'Vue.js',
  angular: 'Angular',
  nodejs: 'Node.js',
  'node.js': 'Node.js',
  node: 'Node.js',
  spring: 'Spring',
  springboot: 'Spring Boot',
  'spring boot': 'Spring Boot',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  'sql server': 'SQL Server',
  linux: 'Linux',
  salesforce: 'Salesforce',
  sap: 'SAP',
  pm: 'PM',
  pmo: 'PMO',
  pl: 'PL',
  se: 'SE',
};

// 表記ゆれを正規形に写像する。「小文字化 → 辞書引き（ヒットすれば正規形）→ ヒットしなければtrimした原表記」の順。
export function normalizeSkill(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const key = trimmed.toLowerCase();
  return SKILL_DICT[key] ?? trimmed;
}

export function normalizeSkills(raw: string[]): string[] {
  return raw.map(normalizeSkill).filter((s) => s.length > 0);
}
