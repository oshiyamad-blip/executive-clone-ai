// ラベルストアの Drive 控えを扱う（npm run ses:labels:restore / ses:labels:backup）。個人データを含むため標準出力は件数だけ。
//   restore <控えのフォルダ>   *.tsv/*.txt を読み、SES_LABELS_DIR/restored_index.jsonl と restored_mail_ids.txt（抽出し直す元メール）を書く
//   backup <出力先>            ストアの全組を labels_backup_NN.tsv に分けて書く（最初の控え用。PHASE=labels を介さない）
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelsDir, parseBackup, readLabelStore, writeBackupFiles, type BackupRow } from './labels.js';

export function restoreFromBackup(backupDir: string, store: string): { files: number; rows: number; bad: number; known: number; missing: number; mailIds: number } {
  const byKey = new Map<string, BackupRow>();
  let bad = 0;
  const names = readdirSync(backupDir).filter((n) => /\.(tsv|txt)$/.test(n)).sort();
  for (const n of names) {
    const r = parseBackup(readFileSync(join(backupDir, n), 'utf8'));
    bad += r.bad;
    for (const row of r.rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
  }
  const have = new Set(readLabelStore(store).pairs.map((p) => p.key));
  const lost = [...byKey.values()].filter((r) => !have.has(r.key));
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'restored_index.jsonl'), [...byKey.values()].map((r) => `${JSON.stringify(r)}\n`).join(''));
  const mailIds = [...new Set(lost.map((r) => r.sourceMailId).filter(Boolean))];
  writeFileSync(join(store, 'restored_mail_ids.txt'), mailIds.map((m) => `${m}\n`).join(''));
  return { files: names.length, rows: byKey.size, bad, known: byKey.size - lost.length, missing: lost.length, mailIds: mailIds.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args[0] === 'backup' ? 'backup' : 'restore';
  const target = args[0] === 'backup' || args[0] === 'restore' ? args[1] : args[0];
  if (!target) {
    console.error('使い方: ses:labels:restore -- <控えのフォルダ> / ses:labels:backup -- <出力先>');
    process.exit(1);
  }
  if (mode === 'backup') {
    const w = writeBackupFiles(target, readLabelStore(labelsDir()).pairs, true);
    console.log(JSON.stringify({ backupFiles: w.files.length, backupLines: w.lines, backupBytes: w.bytes }));
  } else {
    console.log(JSON.stringify(restoreFromBackup(target, labelsDir())));
  }
}
