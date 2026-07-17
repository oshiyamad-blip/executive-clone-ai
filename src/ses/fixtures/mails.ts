// demo用の固定メールデータ。
// 「成立」「粗利不足で除外」「単金不明で要確認」「その他（破棄）」の全分岐と、
// 1通複数件抽出・添付(xlsx)・スプレッドシートリンクのケースを網羅する。
import type { SesRawMail } from '../../types/index.js';

function d(iso: string): Date {
  return new Date(iso);
}

// cc/messageIdHeader/references は loadFixtureMails() で既定値を補完する（記述を簡潔に保つ）
type FixtureMail = Omit<SesRawMail, 'cc' | 'messageIdHeader' | 'references'> &
  Partial<Pick<SesRawMail, 'cc' | 'messageIdHeader' | 'references'>>;

export const FIXTURE_MAILS: FixtureMail[] = [
  // --- P1: 案件（東京・PHP/MySQL）。E1と組み合わさって「成立」になる ---
  {
    id: 'sesmail_demo_p1',
    from: '田中一郎 <tanaka@alphatech.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【案件情報】渋谷 PHP/MySQL案件のご紹介',
    body: `お世話になっております。株式会社アルファテックの田中です。
以下、案件のご紹介です。

案件名: 大手ECサイト バックエンド刷新案件
必須スキル: PHP, MySQL
尚可スキル: AWS
単金: 60万円〜75万円/月
勤務地: 東京都渋谷区
リモート: 一部リモート可（週2出社）
開始時期: 即日
期間: 6ヶ月〜（長期予定）
商流: 元請直請け、一次請けまで。面談1回
ご担当: 田中一郎（tanaka@alphatech.example.jp）

添付にスキルシートのExcelを同封しております。ご確認よろしくお願いいたします。`,
    receivedAt: d('2026-07-16T09:00:00+09:00'),
    attachments: [
      {
        filename: 'skillsheet.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: '',
        text: '【シート: Sheet1】\n項目,内容\n案件名,大手ECサイト バックエンド刷新案件\n必須スキル,PHP;MySQL\n単金,60-75万円/月',
      },
    ],
    sheetLinks: [],
  },

  // --- E1: 要員（東京・PHP/MySQL/AWS）。P1と組み合わさって「成立」になる ---
  {
    id: 'sesmail_demo_e1',
    from: '鈴木花子 <suzuki@betasol.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【要員情報】PHPエンジニア K.S. 即日稼働可',
    body: `お世話になっております。株式会社ベータソリューションズの鈴木です。
以下、要員のご紹介です。

氏名: K.S.（イニシャル）
年齢: 32歳
スキル: PHP, MySQL, AWS
経験年数: 6年
希望単金: 60万円/月
居住地: 東京都新宿区
最寄駅: 新宿駅
稼働開始可能日: 即日
稼働率: 週5
リモート希望: 一部リモート可
ご担当: 鈴木花子（suzuki@betasol.example.jp）

ご検討よろしくお願いいたします。`,
    receivedAt: d('2026-07-16T09:30:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- P2: 案件（大阪・Java）。E2と組み合わさるが粗利不足のため「除外」される ---
  {
    id: 'sesmail_demo_p2',
    from: '佐藤次郎 <sato@gammasys.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【案件情報】大阪 Java/SpringBoot案件',
    body: `お世話になっております。株式会社ガンマシステムズの佐藤です。

案件名: 金融系基幹システム保守案件
必須スキル: Java, Spring Boot
尚可スキル: Oracle
単金: 55万円〜60万円/月
勤務地: 大阪府大阪市
リモート: 不可（常駐必須）
開始時期: 2026年8月1日
期間: 12ヶ月
商流: 二次請け。面談2回
ご担当: 佐藤次郎（sato@gammasys.example.jp）`,
    receivedAt: d('2026-07-16T10:00:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- E2: 要員（大阪・Java）。P2との粗利差が10万円未満のため「除外」される ---
  {
    id: 'sesmail_demo_e2',
    from: '高橋三郎 <takahashi@deltapartners.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【要員情報】Javaエンジニア M.T. 8月稼働可',
    body: `お世話になっております。株式会社デルタパートナーズの高橋です。

氏名: M.T.
年齢: 35歳
スキル: Java, Spring Boot, Oracle
経験年数: 8年
希望単金: 58万円/月
居住地: 大阪府大阪市
最寄駅: 梅田駅
稼働開始可能日: 2026年8月1日
稼働率: 週5
リモート希望: 不可
ご担当: 高橋三郎（takahashi@deltapartners.example.jp）`,
    receivedAt: d('2026-07-16T10:30:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- E3: 要員（神奈川・PHP/MySQL、単金スキル見合い）。P1と組み合わさり「要確認」になる ---
  {
    id: 'sesmail_demo_e3',
    from: '山本四郎 <yamamoto@epsilontech.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【要員情報】PHPエンジニア N.Y. 単金応相談',
    body: `お世話になっております。株式会社イプシロンテックの山本です。

氏名: N.Y.
年齢: 28歳
スキル: PHP, MySQL
経験年数: 4年
希望単金: スキル見合い
居住地: 神奈川県横浜市
最寄駅: 横浜駅
稼働開始可能日: 即日
稼働率: 週5
リモート希望: 一部リモート可
ご担当: 山本四郎（yamamoto@epsilontech.example.jp）`,
    receivedAt: d('2026-07-16T11:00:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- 複数案件メール: 1通に案件2件（抽出の「1メール複数件対応」を検証） ---
  {
    id: 'sesmail_demo_multi',
    from: '中村五郎 <nakamura@zetapartners.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【複数案件のご紹介】Python案件・Ruby案件',
    body: `お世話になっております。株式会社ゼータパートナーズの中村です。
2件まとめてご紹介です。

--- 案件1 ---
案件名: データ分析基盤構築案件
必須スキル: Python
尚可スキル: GCP
単金: 65万円〜80万円/月
勤務地: フルリモート
リモート: フルリモート可
開始時期: 2026年9月〜
期間: 3ヶ月〜
商流: 元請直請け
ご担当: 中村五郎（nakamura@zetapartners.example.jp）

--- 案件2 ---
案件名: ECサイトAPI開発案件
必須スキル: Ruby
尚可スキル: AWS
単金: 50万円〜65万円/月
勤務地: 東京都港区
リモート: 一部リモート可
開始時期: 2026年8月中旬〜
期間: 長期
商流: 一次請け
ご担当: 中村五郎（nakamura@zetapartners.example.jp）

こちらのスプレッドシートに詳細をまとめております。
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit`,
    receivedAt: d('2026-07-16T13:00:00+09:00'),
    attachments: [],
    sheetLinks: ['https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit'],
  },

  // --- P3: 案件（React/Next.js/TypeScript）。E4と組み合わさり「参考提案」（スキル2/3）になる ---
  {
    id: 'sesmail_demo_p3',
    from: '伊藤六郎 <ito@thetaworks.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【案件情報】React/Next.js フロントエンド刷新',
    body: `お世話になっております。株式会社シータワークスの伊藤です。

案件名: SaaS管理画面フロントエンド刷新案件
必須スキル: React, Next.js, TypeScript
尚可スキル: AWS
単金: 70万円〜85万円/月
勤務地: 東京都千代田区
リモート: 一部リモート可
開始時期: 即日
期間: 長期
商流: 元請直請け。面談1回
ご担当: 伊藤六郎（ito@thetaworks.example.jp）`,
    receivedAt: d('2026-07-16T15:00:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- E4: 要員（React/TypeScript、Next.js無し）。P3と組み合わさり「参考提案」になる ---
  {
    id: 'sesmail_demo_e4',
    from: '渡辺七海 <watanabe@iotasoft.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【要員情報】フロントエンド R.T. 即日可',
    body: `お世話になっております。株式会社イオタソフトの渡辺です。

氏名: R.T.
年齢: 30歳
スキル: React, TypeScript
経験年数: 5年
希望単金: 65万円/月
居住地: 東京都品川区
最寄駅: 大井町駅
稼働開始可能日: 即日
稼働率: 週5
リモート希望: 一部リモート可
ご担当: 渡辺七海（watanabe@iotasoft.example.jp）`,
    receivedAt: d('2026-07-16T15:30:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },

  // --- その他メール: 案件でも要員でもない事務連絡（「破棄」分岐を検証） ---
  {
    id: 'sesmail_demo_other',
    from: '営業事務局 <admin@alphatech.example.jp>',
    to: '営業部 <sales@ourcompany.example.jp>',
    subject: '【事務連絡】年末年始休業のお知らせ',
    body: `いつもお世話になっております。
弊社の年末年始休業期間についてご案内いたします。

休業期間: 2026年12月29日〜2027年1月4日
上記期間中のお問い合わせは新年1月5日以降順次対応いたします。

引き続きよろしくお願いいたします。`,
    receivedAt: d('2026-07-16T14:00:00+09:00'),
    attachments: [],
    sheetLinks: [],
  },
];

export function loadFixtureMails(): SesRawMail[] {
  // 共有メールボックス(sales@)宛に届いた想定。cc/Message-ID/References を補完する。
  return FIXTURE_MAILS.map((m) => ({
    cc: '',
    references: '',
    messageIdHeader: `<${m.id}@partner.example.jp>`,
    ...m,
  }));
}
