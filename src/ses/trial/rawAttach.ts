// 試運転で案件メールの添付（表計算・PDF）を読む CLI。Gmail の get_message(messageFormat=RAW) の結果を、本番と同じ解析にかける。
//   npm run ses:trial:raw -- <入力> <出力ディレクトリ>
// 入力は RAW の保存ファイル（JSON の raw に base64url の MIME）か .eml。出力ディレクトリに次を書く:
//   attach_<入力のファイル名>.json = { attachments: [{ name, kind: 'sheet'|'pdf'|'other', textChars, text?, pdfPath? }], messageIdHeaderPresent }
//   PDF は <入力のファイル名>_<番号>.pdf（読むのは呼び出し側。コードでは文字にしない。本番も Claude に文書として渡している）
// 標準出力には件数と文字数だけを出す（添付の名前・中身・Message-ID の値は出さない。ファイルの JSON にだけ書く）。
// 実行モード（DEMO_MODE）に左右されないよう、parseAttachments は通さず、本番の parseRawMail と表計算の文字化を直接呼ぶ
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentKind } from '../../collectors/email.js';
import { MAX_ATTACHMENT_CHARS } from '../extract.js';
import { parseRawMail } from '../mail/xserver.js';
import { spreadsheetBufferToTextIsolated } from '../spreadsheetIsolated.js';

// 試運転の抽出の行に載せる添付の文字の上限（本番の抽出が添付1件で読む上限と同じ。harness の attachmentText も同じ）
export const ATTACH_TEXT_MAX = MAX_ATTACHMENT_CHARS;

export interface RawAttachment {
  name: string;
  kind: 'sheet' | 'pdf' | 'other';
  textChars: number;
  text?: string;
  pdfPath?: string;
}

export interface RawAttachResult {
  attachments: RawAttachment[];
  messageIdHeaderPresent: boolean;
}

// 案件詳細（p.detail）の後ろに足す添付の文字の上限
export const DETAIL_ATTACH_MAX = 1500;

// 試運転の抽出の行（本文の先頭＋添付の文字）→ 案件の材料。本番の抽出と同じく本文の後ろに【添付: 名前】付きで続けたものを抽出の入力にし、
// 案件詳細は本文からの抜粋（excerpt）の後ろに「【添付より】」で DETAIL_ATTACH_MAX 文字まで足す（本番の抜粋は本文だけで、これは試運転だけの扱い）
export function attachmentMaterial(bodyHead: string, excerpt: string, attachmentText: string | undefined, names: string[] | undefined): { body: string; detail: string } {
  const text = (attachmentText ?? '').slice(0, ATTACH_TEXT_MAX);
  if (!text) return { body: bodyHead, detail: excerpt };
  return {
    body: `${bodyHead}\n\n【添付: ${(names ?? [])[0] ?? ''}】\n${text}`,
    detail: `${excerpt}${excerpt ? '\n\n' : ''}【添付より】\n${text.slice(0, DETAIL_ATTACH_MAX)}`,
  };
}

// RAW の保存ファイル（JSON の raw が base64url の MIME）か、MIME そのもの（.eml）を、MIME のバイト列にする
export function rawMimeOf(file: Buffer): Buffer {
  const head = file.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    const parsed = JSON.parse(file.toString('utf8')) as unknown;
    const raw = Array.isArray(parsed) ? (parsed[0] as { raw?: unknown } | undefined)?.raw : (parsed as { raw?: unknown }).raw;
    if (typeof raw !== 'string' || raw === '') throw new Error('JSON に raw（base64url の MIME）がありません');
    return Buffer.from(raw, 'base64url');
  }
  return file;
}

export async function readRawAttachments(file: Buffer, outDir: string, baseName: string): Promise<RawAttachResult> {
  const { mail } = await parseRawMail(rawMimeOf(file), 'trial_raw', new Date());
  const attachments: RawAttachment[] = [];
  let pdfs = 0;
  for (const a of mail.attachments) {
    const kind = attachmentKind(a.filename, a.mimeType);
    const data = a.data ? Buffer.from(a.data, 'base64') : Buffer.alloc(0);
    if (kind === 'xlsx' || kind === 'xls') {
      let text = '';
      try {
        text = await spreadsheetBufferToTextIsolated(data);
      } catch {
        // 解析できない表計算は、文字数0の添付として残す（読めなかったことが分かる）
      }
      attachments.push({ name: a.filename, kind: 'sheet', textChars: text.length, ...(text ? { text: text.slice(0, ATTACH_TEXT_MAX) } : {}) });
    } else if (kind === 'pdf') {
      mkdirSync(outDir, { recursive: true });
      pdfs += 1;
      const pdfPath = join(outDir, `${baseName}_${pdfs}.pdf`);
      writeFileSync(pdfPath, data);
      attachments.push({ name: a.filename, kind: 'pdf', textChars: 0, pdfPath });
    } else {
      attachments.push({ name: a.filename, kind: 'other', textChars: 0 });
    }
  }
  return { attachments, messageIdHeaderPresent: mail.messageIdHeader !== '' };
}

async function main(): Promise<void> {
  const [input, outDirArg] = process.argv.slice(2);
  if (!input || !outDirArg) {
    console.error('使い方: npm run ses:trial:raw -- <RAWの保存ファイル または .eml> <出力ディレクトリ>');
    process.exitCode = 2;
    return;
  }
  const outDir = resolve(outDirArg);
  const baseName = basename(input).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'mail';
  const result = await readRawAttachments(readFileSync(input), outDir, baseName);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `attach_${baseName}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 1));
  const count = (k: RawAttachment['kind']) => result.attachments.filter((a) => a.kind === k).length;
  console.log(
    JSON.stringify({
      attachments: result.attachments.length,
      sheets: count('sheet'),
      pdfs: count('pdf'),
      others: count('other'),
      textChars: result.attachments.filter((a) => a.kind === 'sheet').map((a) => a.textChars),
      messageIdHeaderPresent: result.messageIdHeaderPresent,
      outFile,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`添付の読み取りに失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  });
}
