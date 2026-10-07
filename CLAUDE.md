# CLAUDE.md

このリポジトリで作業するAIアシスタント向けのガイドです。

## 概要

**executive-clone-ai** は経営者の思考・意思決定をデジタル化し、
対話型インターフェースで再現するシステムです。

## 技術スタック

- **TypeScript 5.5+**（strict モード、noUnusedLocals/Parameters）
- **Node.js 20+** / ESM（`"type": "module"`）
- **Anthropic SDK** — Claude API でシグナル抽出・ストーリー生成・対話
- **Notion SDK** — シグナルDB・ストーリーDBの読み書き
- テストランナーなし。ビルド確認は `npm run build`（`tsc`）のみ

## コマンド

```bash
npm install       # 依存関係のインストール
npm run setup     # .env.local を生成
npm run build     # TypeScriptビルド確認（変更後は必ず実行）
npm run collect   # データ収集バッチ（日次）
npm run extract   # シグナル抽出バッチ（日次）
npm run analyze   # ストーリー分析バッチ（週次）
npm run chat      # 対話インターフェース起動
```

## アーキテクチャとデータフロー

```
src/collectors/ → src/dedup/ → src/store/ → src/extractors/ → src/analyzers/ → src/interface/
   （収集）        （名寄せ）  （生ログ永続化）（シグナル抽出）  （ストーリー構築）   （対話）
                                                   ↓                 ↓
                                              src/database/      src/database/
                                             （Notion保存）       （Notion保存）
```

- `src/types/index.ts` — すべてのモジュールが共有する型定義（RawLog / Signal / Story / etc.）
- `src/collectors/` — 各ソースのデータ収集。`googleAuth.ts`（SA+DWD共通）/ `slack.ts`
  （search.messages+xoxp）/ `email.ts`・`calendar.ts`・`meeting.ts`（googleapis）/
  `lifelog.ts`（Plaud NotePin S。フォルダ・ドロップ方式で .txt/.md/.srt/.vtt を取り込む）
- `src/dedup/` — 時間帯と内容類似度（Jaccard）による重複ログの名寄せ統合
- `src/store/` — 収集バッチと抽出バッチは別プロセスのため、生ログをローカルJSONに永続化
  （`data/` 配下。処理済みIDも管理。Notion格納前の一時的な受け皿）
- `src/extractors/` — Claude APIでシグナル抽出（構造化出力+adaptive thinking、重要度で足切り）
- `src/analyzers/` — Claude APIでストーリー構築（月単位グループ → 因果関係 → 洞察）
- `src/database/` — Notion API(v5, 2025-09-03)。database_id→data_source_id を解決し、
  レート制限(3req/s)・rich_text≤2000文字分割・children≤100分割をラップ
- `src/ses/level.ts` — 案件と要員のレベル照合（技術ごとの経験年数・工程・立場を別の軸として比べ、最も弱い軸で除外/経験交渉を決める）
- `src/ses/proper/judge.ts` — プロパー×案件のAI判定（案件の作業内容とスキルシートの経歴を読み比べ、必須ごとの根拠を経歴と機械照合。一般的な語だけの一致は見送り）
- `src/ses/proper/salesList.ts` — 営業に渡すプロパー提案候補リスト（別スプレッドシート。「全体」＋要員別タブ、優先度・対応状況の色分け、人の入力列はIDで引き継ぐ。見送り・クローズの行は次の更新で「クローズ済み」へ移し、見送り理由「募集終了」はその案件の他の要員の行にも及ぶ。候補から外れ入力の無い行は消す前に「期限切れ」タブへ控え、機械の列「最終更新」「前回優先度」で再判定の変化を示し、試運転と本番で案件IDが変わっても同じメール（要員・営業元メール・件名・受信30分以内）の行を引き継ぐ。案件詳細のメール本文の必須・尚可の行に ○△× を付ける）
- `src/ses/eval/labels.ts` — 判定ラベルの蓄積（AI判定と営業の評価を `SES_LABELS_DIR` にためる。足切りの再現率・優先度の妥当率は `labelsEval.ts`）
- `src/ses/proper/roster.ts` — 営業用の要員リスト（「要員」タブのサマリ＋「スキルシート_<名前>」タブ）から社員を読む
- `src/ses/trial/rawAttach.ts` — 試運転で案件メールの添付（表計算・PDF）を読む CLI（`npm run ses:trial:raw`。Gmail の RAW 取得結果か .eml を本番と同じ解析にかける）
- `src/data/executiveProfile.ts` — 経営者プロファイル（価値観・15の意思決定ルール・
  成功/失敗パターン）の単一の真実の源。要件3.3初期設定 / 3.4経営理念プロンプトに対応
- `src/interface/` — Claude APIを使った対話インターフェース（プロファイル＋DBを参照、
  疑似ログ再入力で対話をシグナルDBへ循環）

## 慣習と注意点

- **strict TS**: 未使用のimport/変数/引数を残さないこと — ビルドが失敗する
- **ESMインポート**: パスは必ず `.js` 拡張子を付ける（例: `'./slack.js'`）
- **環境変数ガード**: 未設定でも縮退動作すること — `?? ''` / 早期 `return []` パターンを維持
- **外部APIは try/catch**: `Promise.allSettled` などでエラーを吸収し処理を継続
- **コメント**: WHYが自明でない場合のみ記述
- **言語**: UI・ログ文言は日本語、コード・変数名は英語

## Claude API 利用方針

- モデルは全用途で `claude-opus-4-8`（`@anthropic-ai/sdk` は 0.111+）。
  **例外**: SESマッチング（`src/ses/`）はコスト最適化のため既定で 抽出=Haiku 5.5・
  最終判定/文面生成=Sonnet 5.5（`ANTHROPIC_MODEL_EXTRACT` / `ANTHROPIC_MODEL_MATCH` で変更可）。
  Haiku 4.5 以前は adaptive thinking・effort 非対応のため `src/llm/anthropic.ts` が自動で外す（Haiku 5.5 には付ける）
- **adaptive thinking**（`thinking: { type: 'adaptive' }`）を使う。content 配列には
  thinking ブロックが含まれるため、text は `content[0]` 決め打ちではなく `find` で探す。
  同一モデルでの多ターン継続では content 全体をそのまま履歴に戻す（thinking 維持）
- 抽出・分析は **構造化出力**（`output_config: { format: { type: 'json_schema', schema } }`）
  でJSONパースの信頼性を担保する（正規表現パースは使わない）
- 極秘情報を扱うため、ゼロデータリテンション（ZDR）APIキーの使用を強く推奨

## Git ワークフロー

開発ブランチ: `main`
明確なメッセージでコミットし `git push -u origin main` でプッシュ。
明示的に依頼されない限りプルリクエストは作成しない。
