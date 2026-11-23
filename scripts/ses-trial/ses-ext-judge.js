export const meta = { name: 'ses-ext-judge', description: 'SES試運転の外部マッチのAI判定（要員キーを4つずつまとめる。RUN_DIR は引数）', phases: [{ title: 'Judge' }] }
const R = args.runDir
return await parallel(args.groups.map((keys, i) => () => agent(
  `RUN_DIR=${R}。${R}/ext_judge_instructions.md を Read で読み、その手順に従う。要員キー: ${JSON.stringify(keys)}。`,
  { label: `extjudge:${i}`, phase: 'Judge', model: 'sonnet' })))
