import '../env.js';
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems } from './extract.js';
import { matchAll } from './match.js';
import { createDrafts } from './draft.js';
import { persistAndNotify } from './notify.js';
import { markMailProcessed, writeDemoArtifact, readDemoArtifact, dedupeProjects, dedupeEngineers } from './store.js';
import { saveProject, saveEngineer, fetchOpenProjects, fetchAvailableEngineers } from '../database/index.js';
import { isDemo, minGrossMarginJpy, maxCandidatesPerItem } from './config.js';
import type { Project, Engineer, ExtractedItem, MatchResult, SesRawMail } from '../types/index.js';

// SESマッチングバッチのオーケストレータ。collect→parse→extract→store→match→draft→notify を順に呼ぶ。
// 各段は try/catch でエラーを吸収し、途中段が失敗しても後続へ渡せるデータがあれば継続する。
export interface SesBatchOptions {
  collectOnly?: boolean; // ①〜④まで（保存で止める）
  matchOnly?: boolean; // ⑤〜⑦のみ（既存DB/demo成果物から読んで突合）
}

export async function runSesBatch(opts: SesBatchOptions = {}): Promise<void> {
  console.log('=== SES案件・要員マッチングバッチ開始 ===');
  console.log(
    `モード: ${isDemo() ? 'DEMO（外部呼び出しなし）' : '本番'} / 粗利下限: ${minGrossMarginJpy()}円/月 / 候補上限: ${maxCandidatesPerItem()}件`,
  );

  let projects: Project[];
  let engineers: Engineer[];

  if (opts.matchOnly) {
    ({ projects, engineers } = await loadExisting());
  } else {
    ({ projects, engineers } = await collectAndStore());
    if (opts.collectOnly) {
      console.log(`=== --collect-only指定のため収集・保存のみで終了（案件${projects.length}件・要員${engineers.length}件） ===`);
      return;
    }
  }

  const matches = await matchDraftAndNotify(projects, engineers);
  console.log(`=== SESバッチ完了: マッチ候補 計${matches.length}件 ===`);
}

function isProjectItem(item: ExtractedItem): item is { kind: 'project'; project: Project } {
  return item.kind === 'project';
}

function isEngineerItem(item: ExtractedItem): item is { kind: 'engineer'; engineer: Engineer } {
  return item.kind === 'engineer';
}

// ①〜④: 収集 → 展開 → 抽出 → 保存（名寄せ込み）
async function collectAndStore(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  let mails: SesRawMail[] = [];
  try {
    mails = await collectSesMail();
  } catch (err) {
    console.error(`SES収集: 失敗: ${String(err)}`);
  }
  console.log(`SES収集: 未処理メール${mails.length}件`);
  if (mails.length === 0) {
    console.warn('SES収集: 受信0件です（Xserverからの転送設定をご確認ください）');
  }

  let parsedMails = mails;
  try {
    parsedMails = await parseAttachments(mails);
  } catch (err) {
    console.error(`SES展開: 失敗: ${String(err)}`);
  }

  let items: ExtractedItem[] = [];
  try {
    items = await extractItems(parsedMails);
  } catch (err) {
    console.error(`SES抽出: 失敗: ${String(err)}`);
  }

  const rawProjects = dedupeProjects(items.filter(isProjectItem).map((i) => i.project));
  const rawEngineers = dedupeEngineers(items.filter(isEngineerItem).map((i) => i.engineer));

  const storedProjects = await storeProjects(rawProjects);
  const storedEngineers = await storeEngineers(rawEngineers);

  markMailProcessed(mails.map((m) => m.id));

  return { projects: storedProjects, engineers: storedEngineers };
}

async function storeProjects(projects: Project[]): Promise<Project[]> {
  if (isDemo()) {
    writeDemoArtifact('projects', projects);
    return projects;
  }
  const results: Project[] = [];
  for (const project of projects) {
    try {
      const notionPageId = await saveProject(project);
      results.push({ ...project, notionPageId });
    } catch (err) {
      console.error(`SES保存: 案件保存失敗 (${project.title}): ${String(err)}`);
      results.push(project);
    }
  }
  return results;
}

async function storeEngineers(engineers: Engineer[]): Promise<Engineer[]> {
  if (isDemo()) {
    writeDemoArtifact('engineers', engineers);
    return engineers;
  }
  const results: Engineer[] = [];
  for (const engineer of engineers) {
    try {
      const notionPageId = await saveEngineer(engineer);
      results.push({ ...engineer, notionPageId });
    } catch (err) {
      console.error(`SES保存: 要員保存失敗 (${engineer.displayName}): ${String(err)}`);
      results.push(engineer);
    }
  }
  return results;
}

// --match-only 用: 既存データを読み込む（本番=Notion、demo=直前の data/ses-demo/*.json）
async function loadExisting(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  if (isDemo()) {
    const projects = readDemoArtifact<Project[]>('projects') ?? [];
    const engineers = readDemoArtifact<Engineer[]>('engineers') ?? [];
    if (projects.length === 0 && engineers.length === 0) {
      console.warn('SES: --match-only 用の直前データが無いため、先に収集・保存から実行します');
      return collectAndStore();
    }
    // JSON復元時に Date が文字列になるため戻す
    return {
      projects: projects.map((p) => ({ ...p, receivedAt: new Date(p.receivedAt) })),
      engineers: engineers.map((e) => ({ ...e, receivedAt: new Date(e.receivedAt) })),
    };
  }
  try {
    const [projects, engineers] = await Promise.all([fetchOpenProjects(), fetchAvailableEngineers()]);
    return { projects, engineers };
  } catch (err) {
    console.error(`SES: 既存データの読み込みに失敗: ${String(err)}`);
    return { projects: [], engineers: [] };
  }
}

// ⑤〜⑦: マッチング → 下書き生成 → 通知
async function matchDraftAndNotify(projects: Project[], engineers: Engineer[]): Promise<MatchResult[]> {
  let matches: MatchResult[] = [];
  try {
    matches = await matchAll(projects, engineers);
  } catch (err) {
    console.error(`SESマッチング: 失敗: ${String(err)}`);
  }

  try {
    matches = await createDrafts(matches, projects, engineers);
  } catch (err) {
    console.error(`SES下書き: 失敗: ${String(err)}`);
  }

  try {
    await persistAndNotify(matches, projects, engineers);
  } catch (err) {
    console.error(`SES通知: 失敗: ${String(err)}`);
  }

  return matches;
}

function parseArgs(): SesBatchOptions {
  const args = process.argv.slice(2);
  return {
    collectOnly: args.includes('--collect-only'),
    matchOnly: args.includes('--match-only'),
  };
}

runSesBatch(parseArgs()).catch(console.error);
