export const meta = { name: 'ses-extract-model', description: 'SES試運転の抽出（モデルを引数で指定。RUN_DIR は引数）', phases: [{ title: 'Extract' }] }
const R = args.runDir
const model = args.model || 'haiku'
const outDir = args.outDir || `${R}/out`
return await parallel(args.chunks.map((c) => () => agent(
  `${R}/extract_instructions.md を Read で読み、その手順に従う。入力ファイル: ${R}/chunks/${c}。出力ファイル: ${outDir}/${c}.jsonl。RUN_DIR=${R}。`,
  { label: `extract:${c}`, phase: 'Extract', model })))
