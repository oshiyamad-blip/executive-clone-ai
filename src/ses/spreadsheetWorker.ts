// 表計算・Word の解析用ワーカー（spreadsheetIsolated.ts から起動する）。社外のファイルの解析で想定外に
// メモリ・CPUを使っても、メモリの上限と時間切れでこのワーカーだけを止め、バッチ本体は続ける
import { parentPort } from 'worker_threads';
import mammoth from 'mammoth';
import { spreadsheetBufferToText, isSafeDocx } from './spreadsheetText.js';
import { SafeLogError } from './redact.js';

interface Request {
  id: number;
  kind: 'spreadsheet' | 'docx';
  data: Uint8Array;
}

async function handle(req: Request): Promise<string> {
  const buf = Buffer.from(req.data.buffer, req.data.byteOffset, req.data.byteLength);
  if (req.kind === 'spreadsheet') return spreadsheetBufferToText(buf);
  if (!isSafeDocx(buf)) throw new SafeLogError('通常のdocxではないか、展開後の大きさが上限を超えるか壊れているため読み取りません');
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

parentPort?.on('message', (req: Request) => {
  handle(req).then(
    (text) => parentPort?.postMessage({ id: req.id, ok: true, text }),
    (err: unknown) =>
      parentPort?.postMessage({ id: req.id, ok: false, safe: err instanceof SafeLogError, message: err instanceof SafeLogError ? err.message : '' }),
  );
});
