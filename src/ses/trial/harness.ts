// 試運転（APIキーを使わず、Claude Code の定期実行が抽出・AI判定を代行する）の段ごとの処理。
// 本番と同じコード（抽出結果の組み立て・重複のまとめ・足切り・判定の検証・優先度・営業リストの差分）を通し、
// Google への読み書きだけをコネクタ側に任せる。手順は docs/ses-trial-runbook.md。
// 個人データはここに置かない（要員・メール・シートの値は実行時に RUN_DIR へ書き出したファイルから読む）。
//
//   PHASE=prompts  抽出の指示文とJSONの形を RUN_DIR に書く
//   PHASE=prep     抽出結果＋要員リスト → AI判定に回す組（pairs.json・system_<要員>.txt）
//   PHASE=final    AI判定の結果＋シートの今の行 → 営業リストへの書き込み（plan.json・writes/*.json）
//   PHASE=side     要員一覧・精度集計・要員のタブの値と数式（side.json。要員リストが変わったときの反映用）
//   PHASE=score    取り込み・判定・営業の入力の数字（score.json）
//   PHASE=labels   この回の判定と営業の評価をラベルストア（SES_LABELS_DIR）に足す（評価は src/ses/eval/labelsEval.ts）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { buildProject, projectExcerpt, EXTRACT_SYSTEM, EXTRACT_SCHEMA } from '../extract.js';
import { parseJstLabel } from './jstLabel.js';
import { appendLabels, engineerHashOf, labelsDir, readLabelStore, salesKeyOf, type LabelPair, type LabelSales } from '../eval/labels.js';
import { isClosedNotice } from '../mailKind.js';
import { ownPairsForJudge } from '../ownMatch.js';
import { judgeSystemFor, judgeUserPrompt, __setProperJudgeForTest, __setCachedProjectIdsForTest, type RawProperJudgment } from '../proper/judge.js';
import { buildProperCandidates, dedupeProjects, selectPairsForJudge } from '../proper/index.js';
import { rosterEngineersFromValues, skillSheetText } from '../proper/roster.js';
import { planSalesUpdate, salesPriorityOf, salesRowOf, staffListValues, staffFilterFormula, staffTabName, summaryValues, SALES_COLUMNS, SALES_CLOSED_STATUS } from '../proper/salesList.js';
import type { Project, ProperEngineer, SesRawMail } from '../../types/index.js';

const dir = process.env.RUN_DIR as string;
if (!dir) throw new Error('RUN_DIR を指定してください');
const phase = process.env.PHASE ?? 'prep';
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const LOOKBACK_DAYS = Number(process.env.PROPER_PROJECT_LOOKBACK_DAYS ?? 14);
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const has = (name: string) => existsSync(join(dir, name));
const HEADER = SALES_COLUMNS.map((c) => c.name);
const COL = Object.fromEntries(HEADER.map((n, i) => [n, i])) as Record<string, number>;

// ===== 抽出結果（out/*.jsonl：1スレッド1行） =====
interface OutRow {
  threadId: string;
  messageId: string;
  subject?: string;
  from?: string;
  receivedAt: string;
  kind?: string;
  extraction?: { projects?: unknown[]; engineers?: unknown[]; injectionSuspected?: boolean };
  bodyHead?: string;
  error?: string;
}

function outRows(base = dir): OutRow[] {
  const rows: OutRow[] = [];
  const out = join(base, 'out');
  if (!existsSync(out)) return rows;
  for (const f of readdirSync(out).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(out, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as OutRow);
      } catch {
        console.error(`読めない行があります: ${f}`);
      }
    }
  }
  return rows;
}

function projectsOf(rows: OutRow[]): { projects: Project[]; closed: number; failed: number } {
  const seen = new Set<string>();
  const projects: Project[] = [];
  let closed = 0;
  let failed = 0;
  for (const r of rows) {
    if (seen.has(r.messageId) || !r.extraction) continue;
    seen.add(r.messageId);
    const mail = {
      id: `sesmail_${r.messageId}`, from: r.from ?? '', to: '', cc: '', subject: r.subject ?? '', body: r.bodyHead ?? '',
      messageIdHeader: '', references: '', receivedAt: new Date(r.receivedAt), attachments: [], sheetLinks: [],
    } as SesRawMail;
    if (isClosedNotice(mail)) closed += 1;
    const ps = (r.extraction.projects ?? []) as Parameters<typeof buildProject>[0][];
    ps.forEach((raw, i) => {
      try {
        const p = buildProject(raw, mail, i, null) as Project;
        const detail = projectExcerpt(r.bodyHead ?? '', ps.map((x) => (x as { title: string }).title), i);
        if (detail) p.detail = detail;
        p.replyTarget = { from: r.from ?? '', to: '', cc: '', subject: r.subject ?? '', messageId: '', references: '' };
        if (r.extraction?.injectionSuspected) p.injectionSuspected = true;
        projects.push(p);
      } catch {
        failed += 1;
      }
    });
  }
  return { projects, closed, failed };
}

// ===== 前の回の繰り越し =====
// 上限で判定できなかった組を次の回に回すため、同じ親ディレクトリの別の回（run_*）を前の回とみなす。
// CARRY_DIRS（カンマ区切り）があればそれを使う
function carryDirs(): string[] {
  const own = resolve(dir);
  const given = (process.env.CARRY_DIRS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (given.length > 0) return given.map((x) => resolve(x)).filter((x) => x !== own);
  const parent = dirname(own);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('run_'))
      .map((d) => join(parent, d.name))
      .filter((p) => resolve(p) !== own)
      .sort();
  } catch {
    return [];
  }
}

// この回の抽出結果＋前の回の抽出結果のうち受信が遡り期間内のもの（同じ threadId は1回だけ）。読めない回は飛ばす
function carriedRows(): { rows: OutRow[]; carriedRows: OutRow[] } {
  const own = outRows();
  const seen = new Set(own.map((r) => r.threadId));
  const since = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const prev: OutRow[] = [];
  for (const d of carryDirs()) {
    try {
      for (const r of outRows(d)) {
        const t = new Date(r.receivedAt).getTime();
        if (seen.has(r.threadId) || !Number.isFinite(t) || t < since || t > now.getTime()) continue;
        seen.add(r.threadId);
        prev.push(r);
      }
    } catch (err) {
      console.error(`前の回を読めませんでした（飛ばします）: ${d}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rows: [...own, ...prev], carriedRows: prev };
}

// 前の回で判定済みの組（要員ID|案件ID）。控えにある組として、この回は判定しない
function previouslyJudged(list: ProperEngineer[]): Map<string, Set<string>> {
  const byEngineer = new Map<string, Set<string>>();
  for (const d of carryDirs()) {
    for (const e of list) {
      const f = join(d, `judged_${e.proposalLabel || e.displayName}.json`);
      try {
        if (!existsSync(f)) continue;
        const set = byEngineer.get(e.id) ?? new Set<string>();
        for (const r of JSON.parse(readFileSync(f, 'utf8')) as Array<{ projectId: string }>) set.add(r.projectId);
        byEngineer.set(e.id, set);
      } catch (err) {
        console.error(`前の回の判定を読めませんでした（飛ばします）: ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return byEngineer;
}

// ===== 要員リスト（roster.json：{ spreadsheetId, rows, gidOf, sheets: { 名前: 値 } }） =====
interface RosterDump {
  spreadsheetId: string;
  rows: string[][];
  gidOf: Record<string, number>;
  sheets: Record<string, string[][]>;
}

function engineers(): ProperEngineer[] {
  const r = read<RosterDump>('roster.json');
  const sheetTexts = new Map(Object.entries(r.sheets ?? {}).map(([name, values]) => [name, skillSheetText(values)]));
  return rosterEngineersFromValues(
    { spreadsheetId: r.spreadsheetId, rows: r.rows, gidOf: new Map(Object.entries(r.gidOf ?? {})), sheetTexts },
    now,
  ).map((e) => ({ ...e, affiliation: 'proper' as const }));
}

// ===== 営業リストの今の行（existing.json：見出しの名前 → 値 の配列。人の入力と照合に要る列だけ） =====
type SheetRow = Record<string, string> & { ID: string };

function existingRows(): SheetRow[] {
  return has('existing.json') ? read<SheetRow[]>('existing.json') : [];
}

function closedIds(): Set<string> {
  return new Set(has('closed_ids.json') ? read<string[]>('closed_ids.json') : []);
}

// 以前の試運転の行（own_gu のような仮のID）を、要員リストのIDに読み替える
function legacyCanonical(list: ProperEngineer[]) {
  return (id: string): string => {
    const m = /^ownmatch_own_([a-z]+)_(proj_[0-9a-f]+)$/.exec(id);
    if (!m) return id;
    const e = list.find((x) => (x.proposalLabel || x.displayName).replace(/[^A-Za-z]/g, '').toLowerCase() === m[1]);
    return e ? `ownmatch_${e.id}_${m[2]}` : id;
  };
}

function sheetValues(rows: SheetRow[]): string[][] {
  return [HEADER, ...rows.map((r) => HEADER.map((h) => r[h] ?? ''))];
}

// この回の判定結果（judged_*.json）を差し替えの判定器に入れ、本番と同じ組み立て（足切り・検証・優先度の元）で候補にする。final と labels で共有
async function judgedCandidates() {
  const list = engineers();
  const { projects } = projectsOf(carriedRows().rows);
  const done = previouslyJudged(list);
  const judged = new Map<string, RawProperJudgment>();
  for (const e of list) {
    const label = e.proposalLabel || e.displayName;
    if (!has(`judged_${label}.json`)) continue;
    for (const r of read<Array<{ projectId: string; judgment: RawProperJudgment }>>(`judged_${label}.json`)) judged.set(`${e.id}|${r.projectId}`, r.judgment);
  }
  __setProperJudgeForTest(async (e, p) => {
    const j = judged.get(`${e.id}|${p.id}`);
    if (!j) throw new Error('この回では判定していない組');
    return j;
  });
  // prep と同じ選び方にするため、前の回で判定済みの組を控えとして扱う
  __setCachedProjectIdsForTest(async (e) => done.get(e.id) ?? new Set<string>());
  // 判定する組は prep で選んである。ここでは判定した組をすべて候補にする（設定できる最大）
  process.env.PROPER_JUDGE_PER_ENGINEER = '300';
  const { candidates, stats } = await buildProperCandidates(list, projects, now);
  return { list, projects, judged, candidates, stats };
}

// ===== 段 =====
if (phase === 'prompts') {
  writeFileSync(join(dir, 'extract_system.txt'), EXTRACT_SYSTEM);
  writeFileSync(join(dir, 'extract_schema.json'), JSON.stringify(EXTRACT_SCHEMA, null, 1));
  console.log('ok');
} else if (phase === 'prep') {
  const list = engineers();
  const { rows, carriedRows: prevRows } = carriedRows();
  const { projects } = projectsOf(rows);
  const carriedIds = new Set(projectsOf(prevRows).projects.map((p) => p.id));
  const kept = dedupeProjects(projects).kept;
  const perEngineer = Number(process.env.PROPER_JUDGE_PER_ENGINEER ?? 150);
  const done = previouslyJudged(list);
  const canonical = legacyCanonical(list);
  // すでにシートにある組・クローズした組は判定し直さない（本番の判定の控えの代わり）
  const skip = new Set([...existingRows().map((r) => canonical(r.ID)), ...[...closedIds()].map(canonical)]);
  const all = ownPairsForJudge(list, kept, Number.MAX_SAFE_INTEGER, now).filter((p) => !skip.has(p.match.id));
  // 前の回で判定済みの組は上限に数えず、判定もしない。未判定の組だけを上限まで選ぶ
  const selected = selectPairsForJudge(all, (id) => done.get(id), perEngineer, Number.MAX_SAFE_INTEGER);
  const pairs: Record<string, Array<{ projectId: string; title: string; user: string }>> = {};
  let carried = 0;
  for (const p of selected) {
    if (done.get(p.match.ownEngineerId)?.has(p.match.projectId)) continue;
    if (carriedIds.has(p.match.projectId)) carried += 1;
    const e = list.find((x) => x.id === p.match.ownEngineerId) as ProperEngineer;
    const pj = kept.find((x) => x.id === p.match.projectId) as Project;
    (pairs[e.proposalLabel || e.displayName] ??= []).push({ projectId: pj.id, title: pj.title, user: judgeUserPrompt(pj) });
  }
  for (const e of list) writeFileSync(join(dir, `system_${e.proposalLabel || e.displayName}.txt`), judgeSystemFor(e));
  writeFileSync(join(dir, 'pairs.json'), JSON.stringify(pairs, null, 1));
  console.log(JSON.stringify({ engineers: list.map((e) => e.proposalLabel || e.displayName), projects: projects.length, kept: kept.length, carried, overCap: all.length - selected.length, pairs: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.length])), skipped: skip.size }));
} else if (phase === 'final') {
  const { list, projects, judged, candidates, stats } = await judgedCandidates();
  // この回で判定した組だけを載せる（判定していない組は失敗扱いになるため除く。シートにある組は下の差分で残る）
  const fresh = candidates.filter((c) => judged.has(`${c.ownEngineerId}|${c.projectId}`)).map((c) => salesRowOf(c, projects.find((p) => p.id === c.projectId)));
  const existing = existingRows();
  const canonical = legacyCanonical(list);
  const deduped = dedupeProjects(projects);
  const alias = (id: string) => {
    const c = canonical(id);
    for (const e of list) {
      const prefix = `ownmatch_${e.id}_`;
      const to = c.startsWith(prefix) ? deduped.aliasOf.get(c.slice(prefix.length)) : undefined;
      if (to) return `${prefix}${to}`;
    }
    return c;
  };
  // 前回の行は、受信から遡り日数の内で要員が営業中・希望単価も同じなら残す（試運転は過去の案件を持たないため受信日時で見る）
  const since = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const stillOpen = (id: string, prev: Array<string | number>) => {
    const c = canonical(id);
    const e = list.find((x) => c.startsWith(`ownmatch_${x.id}_`));
    const received = parseJstLabel(String(prev[COL['受信日時']]));
    return Boolean(e) && Number.isFinite(received) && received >= since && String(e?.requiredProjectRate ?? '') === String(prev[COL['希望単価(万)']] ?? '').trim();
  };
  const plan = planSalesUpdate(fresh, sheetValues(existing), stillOpen, alias, new Set([...closedIds()].map(alias)));
  if (!plan) throw new Error('営業リストの見出しが既定の並びではありません（列が並べ替えられています）');
  // 書き込み: 既存の行は人の入力の列の両側だけ、新しい行は下に足す。コネクタで書ける大きさ（約15KB）に分ける
  const humanCols = SALES_COLUMNS.flatMap((c, i) => (c.human ? [i] : []));
  const first = Math.min(...humanCols);
  const last = Math.max(...humanCols);
  const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);
  const writes: Array<{ range: string; values: Array<Array<string | number>> }> = [];
  for (const u of plan.updates) {
    writes.push({ range: `'全体'!A${u.row}:${letter(first - 1)}${u.row}`, values: [u.values.slice(0, first)] });
    writes.push({ range: `'全体'!${letter(last + 1)}${u.row}:${letter(HEADER.length - 1)}${u.row}`, values: [u.values.slice(last + 1)] });
  }
  let next = existing.length + 2;
  for (const r of plan.appends) writes.push({ range: `'全体'!A${next++}`, values: [r] });
  const chunks: Array<typeof writes> = [];
  for (const w of writes) {
    const size = JSON.stringify(w).length;
    const cur = chunks[chunks.length - 1];
    if (!cur || JSON.stringify(cur).length + size > 15_000) chunks.push([w]);
    else cur.push(w);
  }
  mkdirSync(join(dir, 'writes'), { recursive: true });
  chunks.forEach((c, i) => writeFileSync(join(dir, 'writes', `w${String(i).padStart(2, '0')}.json`), JSON.stringify(c)));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({
    appendFrom: existing.length + 2,
    appendCount: plan.appends.length,
    updateRows: plan.updates.map((u) => u.row),
    deleteIds: plan.deleteIds,
    closeIds: plan.closeIds,
    expireIds: plan.expireIds,
    closedRows: plan.closedRows,
    closedStatus: SALES_CLOSED_STATUS,
  }, null, 1));
  console.log(JSON.stringify({ judge: stats, fresh: fresh.length, updates: plan.updates.length, appends: plan.appends.length, deletes: plan.deleteIds.length, closes: plan.closeIds.length, expires: plan.expireIds.length, chunks: chunks.length }));
} else if (phase === 'labels') {
  const { list, projects, judged, candidates } = await judgedCandidates();
  const store = labelsDir();
  const nowIso = now.toISOString();
  const startSec = has('start.txt') ? Number(readFileSync(join(dir, 'start.txt'), 'utf8').trim()) : NaN;
  const judgedAt = Number.isFinite(startSec) && startSec > 0 ? new Date(startSec * 1000).toISOString() : nowIso;
  const deduped = dedupeProjects(projects);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const priorityOf = new Map(candidates.map((c) => [`${c.ownEngineerId}|${c.projectId}`, salesPriorityOf(c)]));
  const engineerById = new Map(list.map((e) => [e.id, e]));
  const hashOf = new Map(list.map((e) => [e.id, engineerHashOf(e)]));
  const pairs: LabelPair[] = [];
  let missingProject = 0;
  for (const [key, judgment] of judged) {
    const [engineerId, projectId] = key.split('|');
    const e = engineerById.get(engineerId);
    const found = projectById.get(projectId) ?? projectById.get(deduped.aliasOf.get(projectId) ?? '');
    if (!e || !found) {
      missingProject += 1;
      continue;
    }
    const { replyTarget: _drop, ...project } = found;
    pairs.push({
      key, engineerId, engineerLabel: e.proposalLabel || e.displayName, projectId: found.id, runId: basename(resolve(dir)), judgedAt,
      engineerHash: hashOf.get(engineerId) as string, project: project as Project, judgment, priority: priorityOf.get(key) ?? '',
    });
  }
  const canonical = legacyCanonical(list);
  const closedRows = has('closed_rows.json') ? read<SheetRow[]>('closed_rows.json') : [];
  const sales: LabelSales[] = [];
  // 全体 → クローズ済みの順に並べる（同じ組が両方にあるときは appendLabels があとの方を採る）
  for (const [tab, rows] of [['全体', existingRows()], ['クローズ済み', closedRows]] as const) {
    for (const r of rows) {
      const key = salesKeyOf(canonical(r.ID ?? ''));
      if (!key) continue;
      sales.push({ key, seenAt: nowIso, tab, status: r['対応状況'] ?? '', skipReason: r['見送り理由'] ?? '', check: r['精度チェック'] ?? '', checkMemo: r['精度メモ'] ?? '', priority: r['優先度'] ?? '' });
    }
  }
  const added = appendLabels(store, {
    pairs,
    engineers: list.map((e) => ({ hash: hashOf.get(e.id) as string, engineerId: e.id, engineer: e })),
    sales,
  });
  const total = readLabelStore(store);
  console.log(JSON.stringify({ ...added, missingProject, store: { pairs: total.pairs.length, sales: total.sales.length } }));
} else if (phase === 'side') {
  const list = engineers();
  // 行の残っている要員（営業から外れても、人の入力がある行は残る）のタブも作る
  const labels = [...new Set([...list.map((e) => e.proposalLabel || e.displayName), ...existingRows().map((r) => r['要員']).filter(Boolean)])].sort();
  writeFileSync(join(dir, 'side.json'), JSON.stringify({
    staffList: staffListValues(list),
    summary: summaryValues(labels),
    staffTabs: labels.map((l) => ({ title: staffTabName(l), formula: staffFilterFormula(l), header: HEADER.map((h) => (SALES_COLUMNS.find((c) => c.name === h)?.human ? `${h}（入力は全体タブ）` : h)) })),
  }, null, 1));
  console.log(JSON.stringify({ engineers: list.length, labels }));
} else if (phase === 'score') {
  const rows = outRows();
  const { closed, failed } = projectsOf(rows);
  const { projects } = projectsOf(carriedRows().rows);
  const kept = dedupeProjects(projects).kept;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const engineerMails = rows.filter((r) => r.kind === 'engineer').length;
  const errors = rows.filter((r) => r.error).length;
  const existing = existingRows();
  const count = (col: string, prefix: string) => existing.filter((r) => (r[col] ?? '').startsWith(prefix)).length;
  const checked = existing.filter((r) => (r['精度チェック'] ?? '').trim()).length;
  const good = count('精度チェック', '◎') + count('精度チェック', '○');
  const reasons: Record<string, number> = {};
  for (const r of existing) if ((r['見送り理由'] ?? '').trim()) reasons[r['見送り理由']] = (reasons[r['見送り理由']] ?? 0) + 1;
  const statuses: Record<string, number> = {};
  for (const r of existing) statuses[r['対応状況'] || '（空）'] = (statuses[r['対応状況'] || '（空）'] ?? 0) + 1;
  const verdicts: Record<string, number> = {};
  for (const f of readdirSync(dir).filter((x) => /^judged_.+\.json$/.test(x))) {
    for (const r of read<Array<{ judgment: RawProperJudgment }>>(f)) verdicts[r.judgment.verdict] = (verdicts[r.judgment.verdict] ?? 0) + 1;
  }
  const score = {
    mails: rows.length, engineerMails, extractErrors: errors, closedNotices: closed, buildFailures: failed,
    projects: projects.length, keptAfterDedupe: kept.length, dedupeRemoved: projects.length - kept.length,
    rateMissingPct: pct(projects.filter((p) => p.rateMax === null && p.rateMin === null).length, projects.length),
    requiredEmptyPct: pct(projects.filter((p) => p.requiredSkills.length === 0).length, projects.length),
    prefectureMissingPct: pct(projects.filter((p) => p.remote !== 'full' && !p.prefecture).length, projects.filter((p) => p.remote !== 'full').length),
    verdicts,
    sheet: { rows: existing.length, priorities: Object.fromEntries(['A', 'B', 'C', 'D'].map((p) => [p, count('優先度', p)])), statuses, reasons, checked, goodRatePct: pct(good, checked) },
  };
  writeFileSync(join(dir, 'score.json'), JSON.stringify(score, null, 1));
  console.log(JSON.stringify(score));
} else {
  throw new Error(`PHASE が不明です: ${phase}`);
}
