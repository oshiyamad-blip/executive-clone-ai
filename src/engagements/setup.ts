import '../env.js';
import { notion, throttle, resolveDataSourceId } from '../database/index.js';
import { DB_IDS } from './notionDb.js';

// 案件・請求管理の Notion DB 一括作成スクリプト（npm run engagements:setup）
//
// NOTION_ENGAGEMENTS_PARENT_PAGE_ID 配下に7つのDBを作成し、
// .env.local に貼るための database_id を出力する（.env.local への書き込みはしない）。
// 環境変数が設定済みのDBはスキップするので、再実行しても二重作成されない。
//
// relation プロパティは作成順に依存する（案件元 → 要員 → 案件 → アサイン → 稼働実績 → 発行請求書）。
// カラムは作成後に Notion 上で自由に追加してよい（コードは知らないプロパティを無視する）。

interface CreatedDb {
  databaseId: string;
  dataSourceId: string;
}

async function createDb(
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<CreatedDb> {
  const response = await throttle(() =>
    notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      initial_data_source: { properties },
    } as never),
  );
  const db = response as unknown as { id: string; data_sources?: Array<{ id: string }> };
  return { databaseId: db.id, dataSourceId: db.data_sources?.[0]?.id ?? db.id };
}

const select = (...names: string[]) => ({ select: { options: names.map((name) => ({ name })) } });
const relation = (dataSourceId: string) => ({
  relation: { data_source_id: dataSourceId, single_property: {} },
});

async function main(): Promise<void> {
  const parentPageId = process.env.NOTION_ENGAGEMENTS_PARENT_PAGE_ID ?? '';
  if (!parentPageId || !process.env.NOTION_TOKEN) {
    console.error('NOTION_TOKEN と NOTION_ENGAGEMENTS_PARENT_PAGE_ID を設定してください');
    process.exitCode = 1;
    return;
  }

  const created: Array<{ env: string; id: string; name: string }> = [];
  const skipped: string[] = [];

  // ① 案件元DB
  // 既存DB（環境変数設定済み）でも data_source_id を解決しておく。
  // 後続DBの relation を張るために必要（解決しないと relation 列の無いDBができ、
  // 発行・検収の書き込みが validation_error(400) で失敗する）
  let clientDs = '';
  if (DB_IDS.client) {
    skipped.push('案件元DB（NOTION_CLIENT_DB_ID 設定済み）');
    clientDs = await resolveDataSourceId(DB_IDS.client);
  } else {
    const db = await createDb(parentPageId, '案件元DB', {
      会社名: { title: {} },
      担当者: { rich_text: {} },
      請求送付先メール: { email: {} },
      締め日: select('月末', '15日', '20日'),
      支払サイト: select('翌月末', '翌々月末', '30日', '60日'),
      ステータス: select('取引中', '休眠', '終了'),
      メモ: { rich_text: {} },
    });
    clientDs = db.dataSourceId;
    created.push({ env: 'NOTION_CLIENT_DB_ID', id: db.databaseId, name: '案件元DB' });
  }

  // ② 要員DB（業務委託+正社員）
  let memberDs = '';
  if (DB_IDS.member) {
    skipped.push('要員DB（NOTION_MEMBER_DB_ID 設定済み）');
    memberDs = await resolveDataSourceId(DB_IDS.member);
  } else {
    const db = await createDb(parentPageId, '要員DB', {
      名前: { title: {} },
      区分: select('業務委託（法人）', '業務委託（個人事業主）', '正社員'),
      メールアドレス: { email: {} },
      スキル: { multi_select: { options: [] } },
      次回空き日: { date: {} },
      空き予定メモ: { rich_text: {} },
      ステータス: select('稼働中', '待機', '取引終了', 'ドラフト'),
      インボイス登録番号: { rich_text: {} },
      振込先口座: { rich_text: {} },
      単価目安: { number: { format: 'yen' } },
      月額給与: { number: { format: 'yen' } },
      コスト係数: { number: {} },
    });
    memberDs = db.dataSourceId;
    created.push({ env: 'NOTION_MEMBER_DB_ID', id: db.databaseId, name: '要員DB' });
  }

  // ③ 案件DB
  let projectDs = '';
  if (DB_IDS.project) {
    skipped.push('案件DB（NOTION_PROJECT_DB_ID 設定済み）');
    projectDs = await resolveDataSourceId(DB_IDS.project);
  } else if (!clientDs && !DB_IDS.client) {
    console.warn('案件DB: 案件元DBが未作成のためスキップ（案件元DBを先に作成してください）');
  } else {
    const db = await createDb(parentPageId, '案件DB', {
      案件名: { title: {} },
      ...(clientDs ? { 案件元: relation(clientDs) } : {}),
      ステータス: select('提案中', '募集中', '進行中', '終了', '失注', 'ドラフト'),
      期間開始: { date: {} },
      期間終了: { date: {} },
      必要スキル: { multi_select: { options: [] } },
      単価下限: { number: { format: 'yen' } },
      単価上限: { number: { format: 'yen' } },
      必要人数: { number: {} },
      メモ: { rich_text: {} },
    });
    projectDs = db.dataSourceId;
    created.push({ env: 'NOTION_PROJECT_DB_ID', id: db.databaseId, name: '案件DB' });
  }

  // ④ アサインDB（コスト側+請求側の契約条件）
  let assignmentDs = '';
  if (DB_IDS.assignment) {
    skipped.push('アサインDB（NOTION_ASSIGNMENT_DB_ID 設定済み）');
    assignmentDs = await resolveDataSourceId(DB_IDS.assignment);
  } else {
    const db = await createDb(parentPageId, 'アサインDB', {
      アサイン名: { title: {} },
      ...(projectDs ? { 案件: relation(projectDs) } : {}),
      ...(memberDs ? { 要員: relation(memberDs) } : {}),
      契約形態: select('業務委託', '準委任（SES）', '派遣'),
      期間開始: { date: {} },
      期間終了: { date: {} },
      // 稼働率は 0-100 の数値で扱う。Notion の percent フォーマットは格納値1=表示100%で
      // コードの読み書きと100倍ズレるため使わない
      稼働率: { number: {} },
      支払方式: select('月額+精算幅', '時給×実稼働'),
      支払単価: { number: { format: 'yen' } },
      支払精算下限h: { number: {} },
      支払精算上限h: { number: {} },
      支払超過単価: { number: { format: 'yen' } },
      支払控除単価: { number: { format: 'yen' } },
      支払時給単価: { number: { format: 'yen' } },
      請求方式: select('月額+精算幅', '時給×実稼働'),
      請求単価: { number: { format: 'yen' } },
      請求精算下限h: { number: {} },
      請求精算上限h: { number: {} },
      請求超過単価: { number: { format: 'yen' } },
      請求控除単価: { number: { format: 'yen' } },
      請求時給単価: { number: { format: 'yen' } },
      端数処理: select('切り捨て', '四捨五入', '切り上げ'),
      ステータス: select('契約中', '終了', '更新待ち'),
    });
    assignmentDs = db.dataSourceId;
    created.push({ env: 'NOTION_ASSIGNMENT_DB_ID', id: db.databaseId, name: 'アサインDB' });
  }

  // ⑦ 契約書DB（原本管理+アサインDBとの突合）
  if (DB_IDS.contract) {
    skipped.push('契約書DB（NOTION_CONTRACT_DB_ID 設定済み）');
  } else {
    const db = await createDb(parentPageId, '契約書DB', {
      タイトル: { title: {} },
      契約種別: select('基本契約', '個別契約', '派遣個別契約', 'その他'),
      相手方: { rich_text: {} },
      ...(memberDs ? { 要員: relation(memberDs) } : {}),
      ...(clientDs ? { 案件元: relation(clientDs) } : {}),
      ...(assignmentDs ? { アサイン: relation(assignmentDs) } : {}),
      期間開始: { date: {} },
      期間終了: { date: {} },
      自動更新: { checkbox: {} },
      突合ステータス: select('一致', '差異あり', '照合不可'),
      突合結果: { rich_text: {} },
      ファイル名: { rich_text: {} },
      契約書PDF: { files: {} },
    });
    created.push({ env: 'NOTION_CONTRACT_DB_ID', id: db.databaseId, name: '契約書DB' });
  }

  // ⑤ 稼働実績DB（受領請求書・勤表）
  if (DB_IDS.workRecord) {
    skipped.push('稼働実績DB（NOTION_WORK_RECORD_DB_ID 設定済み）');
  } else {
    const db = await createDb(parentPageId, '稼働実績DB', {
      タイトル: { title: {} },
      ...(assignmentDs ? { アサイン: relation(assignmentDs) } : {}),
      種別: select('請求書', '勤表'),
      対象月: { rich_text: {} },
      稼働時間: { number: {} },
      '請求金額（税抜）': { number: { format: 'yen' } },
      消費税: { number: { format: 'yen' } },
      '請求金額（税込）': { number: { format: 'yen' } },
      '検収金額（税込）': { number: { format: 'yen' } },
      検収ステータス: select('検収OK', '差異あり', '要確認', '未検収'),
      差異内容: { rich_text: {} },
      記載チェック: { rich_text: {} },
      インボイス番号一致: { checkbox: {} },
      振込先一致: { checkbox: {} },
      支払期日: { date: {} },
      GmailメッセージID: { rich_text: {} },
    });
    created.push({ env: 'NOTION_WORK_RECORD_DB_ID', id: db.databaseId, name: '稼働実績DB' });
  }

  // ⑥ 発行請求書DB
  if (DB_IDS.issuedInvoice) {
    skipped.push('発行請求書DB（NOTION_ISSUED_INVOICE_DB_ID 設定済み）');
  } else {
    const db = await createDb(parentPageId, '発行請求書DB', {
      タイトル: { title: {} },
      請求書番号: { rich_text: {} },
      ...(clientDs ? { 案件元: relation(clientDs) } : {}),
      対象月: { rich_text: {} },
      '小計（税抜）': { number: { format: 'yen' } },
      消費税: { number: { format: 'yen' } },
      '合計（税込）': { number: { format: 'yen' } },
      支払期日: { date: {} },
      ステータス: select('承認待ち', '承認済み', '下書き作成済', '送付済', '入金確認済'),
      Gmail下書きID: { rich_text: {} },
      PDFパス: { rich_text: {} },
      請求書PDF: { files: {} },
    });
    created.push({ env: 'NOTION_ISSUED_INVOICE_DB_ID', id: db.databaseId, name: '発行請求書DB' });
  }

  if (skipped.length) {
    console.log(`スキップ: ${skipped.join(' / ')}`);
  }
  if (created.length) {
    console.log('\n以下を .env.local に追記してください:\n');
    for (const db of created) {
      console.log(`${db.env}=${db.id}  # ${db.name}`);
    }
  } else {
    console.log('すべてのDBが設定済みです — 作成するものはありません');
  }
}

main().catch((err) => {
  console.error(`セットアップ中にエラー: ${String(err)}`);
  process.exitCode = 1;
});
