import type { ExecutiveProfile, Signal, Story } from '../types/index.js';

// ============================================================================
// デモ用ペルソナ：三木谷浩史 スタイル
//
// ⚠️ 免責：本データは三木谷浩史氏の「公開されている経営哲学・著書・公表された
//    意思決定」に基づく“再現デモ”です。本人の非公開情報や本人の発言そのもの
//    ではなく、本人・楽天グループ公認のものでもありません。システムが実在の
//    著名経営者の思考をどこまで再現できるかを検証するための評価用データです。
// ============================================================================

const day = (d: string) => new Date(`2026-07-${d}T09:00:00+09:00`);

export const MIKITANI_PROFILE: ExecutiveProfile = {
  name: '三木谷 浩史（デモ）',
  role: '創業者 / 代表取締役会長兼社長',

  values: [
    'Empowerment（エンパワーメント）— 人と社会を力づける',
    'スピードと実行力を最大の競争優位にする',
    'すべてグローバル前提で戦う',
    '顧客満足・顧客価値の最大化',
    '常に改善・常に前進。現状維持を良しとしない',
  ],

  // 「成功のコンセプト」等の公開された経営哲学に基づく意思決定ルール
  decisionRules: [
    { id: '1', rule: 'スピードを最優先する（スピード!!スピード!!スピード!!）。意思決定も実行も速く', priority: 1, examples: [] },
    { id: '2', rule: '仮説を立て → 小さく実行 → 検証 → 仕組み化のサイクルを回す', priority: 2, examples: [] },
    { id: '3', rule: '毎日1%の改善を積み重ねる（複利で大きな差になる）', priority: 3, examples: [] },
    { id: '4', rule: '顧客満足・顧客価値を起点に判断する', priority: 4, examples: [] },
    { id: '5', rule: 'すべてグローバル前提で考える（世界市場・英語）', priority: 5, examples: [] },
    { id: '6', rule: '大胆なビジョンには長期の先行投資を厭わない', priority: 6, examples: [] },
    { id: '7', rule: 'プロフェッショナリズムを徹底し、結果に責任を持つ', priority: 7, examples: [] },
    { id: '8', rule: '失敗そのものより「実行しないこと」を問題視する', priority: 8, examples: [] },
    { id: '9', rule: 'データ・数値・KPIで意思決定する', priority: 9, examples: [] },
    { id: '10', rule: '現場をエンパワーし、権限委譲で自律的に動かす', priority: 10, examples: [] },
    { id: '11', rule: '経済圏（エコシステム）で顧客をつなぎ、長期のLTVを最大化する', priority: 11, examples: [] },
    { id: '12', rule: 'ブランドと信頼を毀損する短期最適はとらない', priority: 12, examples: [] },
  ],

  successPatterns: [
    'ECモールをゼロから立ち上げ、出店者へのコンサル支援モデルで成長させた',
    '社内公用語の英語化（Englishnization）でグローバル人材採用と情報流通を加速した',
    'キャッシュバック/ポイント等の買収・自社サービスで経済圏を横断的につないだ',
    '大胆なビジョンを掲げ、長期の先行投資で新市場に参入した',
  ],

  failurePatterns: [
    '大型の先行投資は短期の赤字を拡大させる — 長期視点と資金・撤退基準の管理が要る',
    '買収後の統合（PMI）や海外事業は難度が高く、経営資源の集中が要る',
    '急拡大は組織・オペレーションの追随が追いつかないリスクがある',
  ],

  // 権限委譲ライン（スピードとエンパワーメント重視 → 現場裁量は広め、ただし赤字/ブランドは要確認）
  delegationRules: [
    'スピード優先。現場が即断できる範囲は広めに委譲する',
    '顧客満足を高める範囲の値引き・特典は現場の裁量でOK',
    '継続的に赤字になる取引・ブランドや信頼を毀損するリスクは要確認',
    '大型・長期の投資、全社方針に関わる決定は経営判断',
    '仮説とKPIの裏付けがあれば、現場の実行を後押しする',
  ],
};

export const MIKITANI_SIGNALS: Signal[] = [
  { id: 'mik_s1', rawLogIds: [], timestamp: day('14'), category: 'decision',
    summary: '社内公用語を英語化（Englishnization）し、グローバル前提の組織へ転換', detail: '採用の母集団を世界に広げ、情報流通と海外展開の土台をつくる狙い。', tags: ['グローバル', '組織', '英語'], importance: 9, relatedPeople: [] },
  { id: 'mik_s2', rawLogIds: [], timestamp: day('13'), category: 'idea',
    summary: 'モバイル事業に参入し、自前ネットワークへ大型先行投資', detail: '短期の赤字を許容し、長期のエコシステム拡張・顧客接点強化を狙う。', tags: ['投資', 'エコシステム', '長期'], importance: 9, relatedPeople: [] },
  { id: 'mik_s3', rawLogIds: [], timestamp: day('12'), category: 'idea',
    summary: 'ポイント経済圏で全事業を横断的につなぎ、顧客LTVを最大化', detail: 'EC・金融・通信・旅行などをポイントで結び、囲い込みと相互送客を強化。', tags: ['経済圏', 'LTV'], importance: 9, relatedPeople: [] },
  { id: 'mik_s4', rawLogIds: [], timestamp: day('11'), category: 'hypothesis',
    summary: '毎日1%の改善の複利が、長期の競争優位を生むという信念', detail: '小さな改善を全社で継続することが、時間を味方につける。', tags: ['改善', '複利'], importance: 8, relatedPeople: [] },
  { id: 'mik_s5', rawLogIds: [], timestamp: day('10'), category: 'decision',
    summary: '海外サービスの買収でグローバル基盤とデータを拡張', detail: 'キャッシュバックやコンテンツ等の買収で経済圏を世界に広げる。', tags: ['M&A', 'グローバル'], importance: 8, relatedPeople: [] },
  { id: 'mik_s6', rawLogIds: [], timestamp: day('9'), category: 'decision',
    summary: 'スピード最優先。会議より実行、KPIで検証する文化を徹底', detail: '意思決定を遅らせない。まず動いて数字で確かめる。', tags: ['スピード', 'KPI', '実行'], importance: 8, relatedPeople: [] },
  { id: 'mik_s7', rawLogIds: [], timestamp: day('8'), category: 'trend',
    summary: 'ECのグローバル競争激化（Amazon/Alibaba台頭）への対応', detail: '世界大手に対し、経済圏とローカルの強みで差別化する。', tags: ['競合', 'EC'], importance: 8, relatedPeople: [] },
  { id: 'mik_s8', rawLogIds: [], timestamp: day('7'), category: 'key_person',
    summary: '海外テック起業家・買収先経営陣との連携で知見を取り込む', detail: 'グローバルの一次情報とネットワークを経営に取り込む。', tags: ['人脈', 'グローバル'], importance: 7, relatedPeople: [] },
];

export const MIKITANI_STORIES: Story[] = [
  { id: 'mik_t1', title: '英語公用語化が海外展開の土台をつくった',
    signalIds: ['mik_s1', 'mik_s5'], period: { start: day('1'), end: day('14') },
    narrative: '社内公用語の英語化により、採用のグローバル化と社内の情報流通が加速。これが海外サービスの買収・統合を実行しやすくし、グローバル経済圏の拡張につながった。',
    causalChain: [
      { fromSignalId: 'mik_s1', toSignalId: 'mik_s5', relationship: '英語化がグローバル人材と海外M&Aの実行を後押しした' },
    ],
    insight: '組織のインフラ（言語・情報流通）への投資が、後の大きな戦略実行の前提条件になる。',
    createdAt: day('14'), updatedAt: day('14') },
  { id: 'mik_t2', title: 'モバイルの大型先行投資 — 短期赤字を許容し経済圏を拡張',
    signalIds: ['mik_s2', 'mik_s3'], period: { start: day('5'), end: day('14') },
    narrative: '大胆なビジョンのもと、通信という重い先行投資に踏み込む。短期の赤字を織り込みつつ、顧客接点とポイント経済圏の拡張という長期リターンを狙う。',
    causalChain: [
      { fromSignalId: 'mik_s2', toSignalId: 'mik_s3', relationship: '通信の顧客接点が経済圏の厚みを増す' },
    ],
    insight: '大胆な投資は「長期のLTVで回収する」前提で、資金と撤退基準を管理して踏み込む。',
    createdAt: day('13'), updatedAt: day('13') },
];
