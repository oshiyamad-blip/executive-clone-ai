// 社外から届いた表計算・Word のファイルを、メモリ上限つきのワーカースレッドで時間を区切って解析する。
// SheetJS・mammoth の解析器に想定外の形式で大量のメモリ・CPUを使わされても、そのファイルを「解析できない」として
// 扱うだけにし、バッチ本体（メインスレッド）を止めない（処理済みにならないまま毎回同じメールで止まる状態を作らせない）
import { Worker } from 'worker_threads';
import { SafeLogError } from './redact.js';

// 1ファイルの解析の持ち時間とワーカーのメモリ上限
export const ISOLATED_PARSE_TIMEOUT_MS = 20_000;
export const ISOLATED_PARSE_HEAP_MB = 512;

// ワーカーの本体（spreadsheetWorker）。tsx で実行しているとき（.ts）は、ワーカーに tsx の読み込み処理が引き継がれないため、
// tsx の API（tsImport）で読み込む。ビルド済み（.js）ならそのまま読み込む
const IS_TS = import.meta.url.endsWith('.ts');
// 解析器が console に書く文字列（添付の中身を含む）は公開ログに出さないよう、ワーカーの標準出力・標準エラーは捨てる
const WORKER_BOOT = `
const { workerData } = require('node:worker_threads');
const drop = () => true;
process.stdout.write = drop;
process.stderr.write = drop;
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) console[k] = () => undefined;
(async () => {
  if (workerData.tsxApi) await (await import(workerData.tsxApi)).tsImport(workerData.impl, workerData.parent);
  else await import(workerData.impl);
})().catch(() => process.exit(70));
`;

function workerData(): { impl: string; parent: string; tsxApi: string } {
  const impl = new URL(IS_TS ? './spreadsheetWorker.ts' : './spreadsheetWorker.js', import.meta.url).href;
  return { impl, parent: import.meta.url, tsxApi: IS_TS ? import.meta.resolve('tsx/esm/api') : '' };
}

type Kind = 'spreadsheet' | 'docx';

interface Reply {
  id: number;
  ok: boolean;
  text?: string;
  safe?: boolean;
  message?: string;
}

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function startWorker(): Worker {
  const w = new Worker(WORKER_BOOT, {
    eval: true,
    workerData: workerData(),
    resourceLimits: { maxOldGenerationSizeMb: ISOLATED_PARSE_HEAP_MB, maxYoungGenerationSizeMb: 64 },
  });
  const forget = () => {
    if (worker === w) worker = null;
  };
  w.on('error', forget);
  w.on('exit', forget);
  w.unref();
  return w;
}

function runOnce(kind: Kind, data: Buffer, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let w: Worker;
    try {
      w = worker ?? startWorker();
      worker = w;
    } catch {
      reject(new SafeLogError('解析用のワーカーを起動できないため解析しません'));
      return;
    }
    const id = ++seq;
    const cleanup = () => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      w.unref();
    };
    const abort = (message: string) => {
      cleanup();
      if (worker === w) worker = null;
      void w.terminate().catch(() => undefined);
      reject(new SafeLogError(message));
    };
    const onMessage = (m: Reply) => {
      if (m.id !== id) return;
      cleanup();
      if (m.ok) resolve(m.text ?? '');
      else reject(new SafeLogError(m.safe && m.message ? m.message : '解析に失敗しました（形式が壊れているか対応していない内容です）'));
    };
    const onError = (err: Error & { code?: string }) =>
      abort(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? '解析がメモリの上限を超えたため中止しました' : '解析中にワーカーが異常終了しました');
    const onExit = () => abort('解析中にワーカーが終了しました');
    const timer = setTimeout(() => abort(`解析が${Math.round(timeoutMs / 1000)}秒を超えたため中止しました`), timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.ref();
    w.postMessage({ id, kind, data });
  });
}

// 1件ずつ順に解析する（ワーカーは1つを使い回し、時間切れ・メモリ超過のときだけ作り直す）
function isolated(kind: Kind, data: Buffer, timeoutMs: number): Promise<string> {
  const task = queue.then(() => runOnce(kind, data, timeoutMs));
  queue = task.catch(() => undefined);
  return task;
}

// Excel（.xlsx/.xls）の全シートをCSVテキストにする（spreadsheetText.spreadsheetBufferToText をワーカーで実行）
export function spreadsheetBufferToTextIsolated(data: Buffer, timeoutMs = ISOLATED_PARSE_TIMEOUT_MS): Promise<string> {
  return isolated('spreadsheet', data, timeoutMs);
}

// Word（.docx）の本文テキスト（ZIP の検査を通ったものだけ mammoth で読む）
export function docxBufferToTextIsolated(data: Buffer, timeoutMs = ISOLATED_PARSE_TIMEOUT_MS): Promise<string> {
  return isolated('docx', data, timeoutMs);
}
