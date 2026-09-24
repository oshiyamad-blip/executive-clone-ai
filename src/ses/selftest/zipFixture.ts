// 回帰確認用の ZIP の組み立て（ses:eval:rules・ses:flow:check）。宣言サイズ・拡張フィールド・エントリの位置を
// 自由に偽れるよう、ライブラリを使わずに書く（攻撃の形のファイルを作るため）
import { deflateRawSync } from 'zlib';

export interface ZipFixtureEntry {
  name: string;
  content: Buffer | string;
  method?: 0 | 8;
  declaredSize?: number; // ローカルヘッダ・中央ディレクトリの展開後のサイズ（既定は実際の大きさ）
  localDeclaredSize?: number; // ローカルヘッダだけの展開後のサイズ
  zip64Extra?: boolean; // ZIP64 の拡張フィールド（0x0001）を付ける
  localName?: string; // ローカルヘッダの名前（既定は name）
}

export interface ZipFixtureOptions {
  // 中央ディレクトリの末尾に、先頭のエントリと同じ位置を指すエントリをこの件数だけ足す
  duplicateCentralEntries?: number;
}

function zip64(usz: number): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(16, 2);
  b.writeUInt32LE(usz >>> 0, 4);
  b.writeUInt32LE(Math.floor(usz / 2 ** 32), 8);
  return b;
}

export function zipOfEntries(entries: ZipFixtureEntry[], opts: ZipFixtureOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let first: Buffer | null = null;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf-8');
    const method = e.method ?? 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const usz = e.declaredSize ?? raw.length;
    const localUsz = e.localDeclaredSize ?? usz;
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const localNameBuf = Buffer.from(e.localName ?? e.name, 'utf-8');
    const extra = e.zip64Extra ? zip64(localUsz) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(localUsz >>> 0, 22);
    local.writeUInt16LE(localNameBuf.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(usz >>> 0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    const centralEntry = Buffer.concat([central, nameBuf]);
    first ??= centralEntry;
    locals.push(local, localNameBuf, extra, data);
    centrals.push(centralEntry);
    offset += local.length + localNameBuf.length + extra.length + data.length;
  }
  for (let i = 0; i < (opts.duplicateCentralEntries ?? 0) && first; i++) centrals.push(first);
  const cd = Buffer.concat(centrals);
  const count = Math.min(0xffff, centrals.length);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTENT_TYPES_XLSX =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';

// 最小の xlsx の部品（シート1枚。sheetXml でシートの中身を差し替えられる）
export function minimalXlsxEntries(sheetXml?: string): ZipFixtureEntry[] {
  return [
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XLSX },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        sheetXml ??
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Java</t></is></c><c r="B1"><v>80</v></c></row></sheetData></worksheet>',
    },
  ];
}

// ODS の「行・列の繰り返し」で1つのセルを何十億個にも増やす形（SheetJS の ODS の解析器に回ると止まる）
export function odsRepeatBombEntries(): ZipFixtureEntry[] {
  return [
    { name: 'mimetype', content: 'application/vnd.oasis.opendocument.spreadsheet', method: 0 },
    {
      name: 'META-INF/manifest.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    },
    {
      name: 'content.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>' +
        '<table:table table:name="S"><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table>' +
        '</office:spreadsheet></office:body></office:document-content>',
    },
  ];
}

// 最小の docx（本文1段落）
export function minimalDocxEntries(text: string, documentXml?: string | Buffer): ZipFixtureEntry[] {
  return [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      content:
        documentXml ??
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ];
}
