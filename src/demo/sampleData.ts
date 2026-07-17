import { EXECUTIVE_PROFILE } from '../data/executiveProfile.js';
import type { Signal, Story, ExecutiveProfile } from '../types/index.js';

// デモ用のサンプルデータ。DEMO_MODE=true のとき Notion の代わりに使う。
// これにより Anthropic APIキーだけで chat/web/brief をエンドツーエンドでデモできる。
// 架空の企業「サンプルテック株式会社」の代表を想定。

export const DEMO_PROFILE: ExecutiveProfile = {
  ...EXECUTIVE_PROFILE,
  name: '山田 太郎',
  role: '代表取締役CEO（サンプルテック株式会社）',
};

const day = (d: string) => new Date(`2026-07-${d}T09:00:00+09:00`);

export const DEMO_SIGNALS: Signal[] = [
  {
    id: 'demo_s1',
    rawLogIds: [],
    timestamp: day('14'),
    category: 'key_person',
    summary: '元競合役員の佐藤氏と会食。SaaSの海外展開とPLGの知見を得た',
    detail: '佐藤氏はA社で北米展開を主導。「最初の100社は創業者が直接オンボーディングすべき」との助言。',
    tags: ['海外展開', 'PLG', '人脈'],
    importance: 8,
    relatedPeople: ['佐藤'],
  },
  {
    id: 'demo_s2',
    rawLogIds: [],
    timestamp: day('13'),
    category: 'decision',
    summary: '来期は既存SaaSの深掘りに7割、新規探索に3割とリソース配分を決定',
    detail: '取締役会で合意。既存事業の解約率改善を最優先KPIに設定。',
    tags: ['経営方針', 'リソース配分'],
    importance: 8,
    relatedPeople: [],
  },
  {
    id: 'demo_s3',
    rawLogIds: [],
    timestamp: day('12'),
    category: 'idea',
    summary: '料金体系をサブスク＋従量課金のハイブリッドにする着想',
    detail: '大口顧客は使用量が読みづらく、従量を混ぜた方が導入障壁が下がるのではという仮説。',
    tags: ['価格戦略', 'マネタイズ'],
    importance: 7,
    relatedPeople: [],
  },
  {
    id: 'demo_s4',
    rawLogIds: [],
    timestamp: day('11'),
    category: 'trend',
    summary: '競合A社が生成AI機能を投入。業界で「AI標準搭載」が加速する兆し',
    detail: 'デモを見た顧客からも問い合わせ増。半年以内に対応しないと不利になる可能性。',
    tags: ['競合', '生成AI', '業界トレンド'],
    importance: 8,
    relatedPeople: [],
  },
  {
    id: 'demo_s5',
    rawLogIds: [],
    timestamp: day('10'),
    category: 'hypothesis',
    summary: '中小企業向けは「オンボーディングの手厚さ」が解約率を左右するという仮説',
    detail: '解約した5社にヒアリング。初月に活用支援が薄かった点が共通していた。',
    tags: ['解約率', 'カスタマーサクセス'],
    importance: 7,
    relatedPeople: [],
  },
  {
    id: 'demo_s6',
    rawLogIds: [],
    timestamp: day('9'),
    category: 'key_person',
    summary: 'CTO候補の田中氏と面談。技術力よりカルチャーフィットが良好',
    detail: '「小さく試して学ぶ」姿勢が自社の価値観と一致。オファーを前向きに検討。',
    tags: ['採用', 'CTO'],
    importance: 6,
    relatedPeople: ['田中'],
  },
  {
    id: 'demo_s7',
    rawLogIds: [],
    timestamp: day('8'),
    category: 'decision',
    summary: '不採算の受託開発事業から半年をめどに撤退する方針',
    detail: '粗利率が低く主力SaaSにリソースを集中するため。撤退基準は前四半期に設定済み。',
    tags: ['撤退', '選択と集中'],
    importance: 8,
    relatedPeople: [],
  },
  {
    id: 'demo_s8',
    rawLogIds: [],
    timestamp: day('7'),
    category: 'idea',
    summary: '既存顧客向けに紹介プログラムを導入するアイデア',
    detail: 'NPSの高い顧客が数社おり、紹介経由のリード獲得コストは低いはずという読み。',
    tags: ['成長施策', '紹介'],
    importance: 6,
    relatedPeople: [],
  },
];

export const DEMO_STORIES: Story[] = [
  {
    id: 'demo_t1',
    title: '佐藤氏との出会いが海外展開の判断軸をつくった',
    signalIds: ['demo_s1', 'demo_s5'],
    period: { start: day('1'), end: day('14') },
    narrative:
      '6月に紹介で知り合った佐藤氏との継続的な対話を通じて、「海外展開の前に国内でオンボーディングの型を確立する」という順序の重要性を認識。これが来期の既存事業深掘り（7割）という配分判断につながった。',
    causalChain: [
      { fromSignalId: 'demo_s1', toSignalId: 'demo_s5', relationship: '助言が解約率仮説の検証を促した' },
      { fromSignalId: 'demo_s5', toSignalId: 'demo_s2', relationship: '仮説が既存深掘りの方針決定を後押しした' },
    ],
    insight: '重要人物からの示唆は、単発の情報ではなく「意思決定の順序」を変える形で効いてくる。',
    createdAt: day('14'),
    updatedAt: day('14'),
  },
  {
    id: 'demo_t2',
    title: '選択と集中：不採算事業からの撤退パターン',
    signalIds: ['demo_s7', 'demo_s2'],
    period: { start: day('5'), end: day('14') },
    narrative:
      '受託開発の粗利低下を早期に定量化し、事前に決めた撤退基準に沿って感情を挟まず撤退を判断。過去の「惰性で事業を続けて損失拡大」の失敗パターンを回避した。',
    causalChain: [
      { fromSignalId: 'demo_s7', toSignalId: 'demo_s2', relationship: '撤退でリソースが空き主力集中を可能にした' },
    ],
    insight: '撤退は事前に決めた基準で機械的に。好調時の固定費増と同じく、感情が判断を鈍らせる。',
    createdAt: day('13'),
    updatedAt: day('13'),
  },
];
