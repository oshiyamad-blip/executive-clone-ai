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
src/collectors/  →  src/dedup/  →  src/extractors/  →  src/analyzers/  →  src/interface/
   （収集）          （名寄せ）     （シグナル抽出）    （ストーリー構築）     （対話）
                                        ↓                    ↓
                                   src/database/          src/database/
                                  （Notion保存）           （Notion保存）
```

- `src/types/index.ts` — すべてのモジュールが共有する型定義（RawLog / Signal / Story / etc.）
- `src/collectors/` — 各ソース（Slack/Gmail/Calendar/Meet/ライフログ）のデータ収集
- `src/dedup/` — 時間帯と内容類似度による重複ログの名寄せ統合
- `src/extractors/` — Claude APIを使ったシグナル抽出（hypothesis/key_person/idea/decision/trend）
- `src/analyzers/` — Claude APIを使ったストーリー構築（月単位グループ → 因果関係 → 洞察）
- `src/database/` — Notion API経由でのシグナル・ストーリーの永続化と読み込み
- `src/interface/` — Claude APIを使った対話インターフェース（経営者プロファイル＋DBを参照）

## 慣習と注意点

- **strict TS**: 未使用のimport/変数/引数を残さないこと — ビルドが失敗する
- **ESMインポート**: パスは必ず `.js` 拡張子を付ける（例: `'./slack.js'`）
- **環境変数ガード**: 未設定でも縮退動作すること — `?? ''` / 早期 `return []` パターンを維持
- **外部APIは try/catch**: `Promise.allSettled` などでエラーを吸収し処理を継続
- **コメント**: WHYが自明でない場合のみ記述
- **言語**: UI・ログ文言は日本語、コード・変数名は英語

## Claude API 利用方針

- シグナル抽出・ストーリー生成: `claude-opus-4-8`（精度優先）
- 対話インターフェース: `claude-opus-4-8`（推論品質優先）
- ゼロデータリテンション（ZDR）APIキーの使用を強く推奨

## Git ワークフロー

開発ブランチ: `main`
明確なメッセージでコミットし `git push -u origin main` でプッシュ。
明示的に依頼されない限りプルリクエストは作成しない。
