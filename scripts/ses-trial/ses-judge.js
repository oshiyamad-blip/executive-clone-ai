export const meta = { name: 'ses-judge', description: 'SES試運転のAI判定（RUN_DIR は引数）', phases: [{ title: 'Judge' }] }
const R = args.runDir
return await parallel(args.jobs.map(([e, s, t]) => () => agent(
  `RUN_DIR=${R}。${R}/judge_instructions.md を Read で読み、その手順に従う。要員: ${e}。範囲: [${s}, ${t})。出力ファイル: ${R}/jparts/${e}_${s}.json。`,
  { label: `judge:${e}_${s}`, phase: 'Judge', model: 'sonnet' })))
