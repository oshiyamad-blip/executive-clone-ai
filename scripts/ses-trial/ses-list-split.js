export const meta = { name: 'ses-list-split', description: 'SES試運転のスレッド一覧（1時間ごと・大きさで分割。RUN_DIR は引数）', phases: [{ title: 'List' }] }
const R = args.runDir
return await parallel(args.groups.map((hours, i) => () => agent(
  `${args.instructions} を Read で読み、その手順に従う。{HOURS}=${JSON.stringify(hours)}、{FILE}=${R}/list/s${String(i).padStart(2, '0')}.tsv。`,
  { label: `list:h${hours[0]}-${hours[hours.length - 1]}`, phase: 'List', model: 'sonnet' })))
