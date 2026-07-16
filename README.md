# 経営者クローンAIシステム

経営者の意思決定の仕組みや思考をデジタル化して再現するシステムです。

## 概要

経営企画や部門長が経営者と会議を行う前にAIと壁打ちを行うことで、
会議の回数を削減し、意思決定の速度を劇的に高めます。

また、経営者自身が気づいていない潜在的な行動の因果関係を抽出し、
経営の資産として蓄積します。

## データフロー

```
日常データ（Slack / メール / 会議 / 音声 / 文書）
         ↓
  [1] マルチソースデータ収集（日次）
         ↓
  [2] 名寄せ・重複除去
         ↓
  [3] シグナル抽出（重要情報のみ）→ Notion シグナルDB
         ↓
  [4] ストーリー分析（因果関係の整理）→ Notion ストーリーDB（週次）
         ↓
  [5] 意思決定シミュレーション対話
```

## ディレクトリ構成

```
executive-clone-ai/
├── src/
│   ├── collectors/    # データ収集（Slack / Gmail / Calendar / Meet / ライフログ）
│   ├── extractors/    # シグナル抽出（Claude APIで重要情報を選別）
│   ├── analyzers/     # ストーリー分析（Claude APIで因果関係を構築）
│   ├── database/      # Notion連携（シグナルDB・ストーリーDB）
│   ├── dedup/         # 名寄せ・重複除去
│   ├── interface/     # 対話インターフェース（経営者クローン）
│   └── types/         # TypeScript型定義
├── docs/
│   └── requirements.md   # 要件定義書
└── scripts/
    └── setup.mjs
```

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
npm run setup
# .env.local が生成されるので各APIキーを設定する
```

| 変数 | 必須 | 用途 |
|------|------|------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API（シグナル抽出・ストーリー生成・対話）。ZDRキー推奨 |
| `NOTION_TOKEN` | ✅ | Notion Internal Integration Token |
| `NOTION_SIGNAL_DB_ID` | ✅ | シグナルDBの database_id（起動時に data_source_id へ自動解決） |
| `NOTION_STORY_DB_ID` | ✅ | ストーリーDBの database_id |
| `LIFELOG_INBOX_DIR` | | Plaud NotePin S 文字起こしファイルの受け皿フォルダ |
| `SLACK_USER_TOKEN` | | 経営者本人が認可した Slack ユーザートークン(xoxp-) |
| `SLACK_TARGET_USER_ID` | | 対象経営者のSlackユーザーID（Uxxxx） |
| `GOOGLE_SA_CLIENT_EMAIL` | | サービスアカウントの client_email |
| `GOOGLE_SA_PRIVATE_KEY` | | サービスアカウントの秘密鍵（\n エスケープ） |
| `GOOGLE_TARGET_EMAIL` | | impersonate する対象経営者のメール |
| `EXECUTIVE_NAME` | | 経営者の名前（対話表示用） |
| `SIGNAL_IMPORTANCE_THRESHOLD` | | シグナル採用の重要度しきい値（既定5） |

### 3. Notionデータベースの準備

Notion API は 2025-09-03 以降 `database_id` と `data_source_id` が別物になりました。
本システムは `database_id` を設定すれば起動時に `data_source_id` へ自動解決します。
作成後、各DBの **Connections** からインテグレーションを共有してください。

**シグナルDB** に以下のプロパティを作成してください。

| プロパティ名 | 種類 |
|------|------|
| 概要 | タイトル |
| カテゴリ | セレクト（hypothesis / key_person / idea / decision / trend） |
| 重要度 | 数値（1〜10） |
| 日時 | 日付 |
| タグ | マルチセレクト |
| 関係者 | マルチセレクト |

**ストーリーDB** に以下のプロパティを作成してください。

| プロパティ名 | 種類 |
|------|------|
| タイトル | タイトル |
| 期間（開始） | 日付 |
| 洞察 | テキスト |

### 4. データソースの接続

各コレクタは対応する環境変数が未設定なら安全にスキップします。必要なものだけ設定してください。

#### ライフログ: Plaud NotePin S

Plaud には公式のネイティブ Notion/Drive 連携が無く、手動UIにも一括/JSONエクスポートが
無いため、本システムは **フォルダ・ドロップ方式** で取り込みます。文字起こしファイル
（`.txt` / `.md` / `.srt` / `.vtt`）を `LIFELOG_INBOX_DIR` に置けば取り込まれ、処理後は
`_processed/` へ退避されます。供給経路は3通り:

1. **公式 Zapier 連携**（安定・推奨）: Plaud のトリガー「Transcript & Summary Ready」→
   Google Drive / Dropbox 等にファイル出力 → そのローカル同期フォルダを受け皿に指定
2. **非公式CLI**（完全ローカル）: `@plaud/cli` の `plaud sync <dir>` を日次 cron で実行し、
   出力先を受け皿に指定（※Plaud非公認のリバースAPI。ToS/仕様変更リスクに留意）
3. **手動エクスポート**: Plaud アプリから TXT/SRT 等でエクスポートしてフォルダに置く

#### Slack

経営者**本人**が OAuth 認可して発行したユーザートークン（`xoxp-`、スコープ `search:read`
`users:read`）を設定します。`search.messages` の `from:<@USERID>` で全チャンネル・DMを横断
収集します（本人が参加する会話に限定）。

#### Google Workspace（Gmail / Calendar / Meet）

GCP のサービスアカウント + ドメイン全体委任で対象経営者を impersonate します。Workspace
管理コンソールでクライアントIDと readonly スコープを事前登録してください。Meet の文字起こし
（構造化データ）は会議終了から30日で消えるため、日次バッチでの即時取得が前提です。

## 開発コマンド

```bash
npm run collect   # データ収集バッチ（日次実行）
npm run extract   # シグナル抽出バッチ（日次実行）
npm run analyze   # ストーリー分析バッチ（週次実行）
npm run chat      # 対話インターフェース起動
npm run build     # TypeScriptビルド確認
```

## 運用フロー

### 日次バッチ（深夜）

1. `npm run collect` — 各データソースから前日分を収集・名寄せ
2. `npm run extract` — シグナルを抽出してNotionシグナルDBへ保存

### 週次バッチ（週末）

1. `npm run analyze` — 週のシグナルを集計してストーリーを生成

### 日常利用

1. `npm run chat` — 経営者クローンとの対話を開始
2. AIとの対話ログは再びデータベースにフィードバック（疑似ログ循環）

## セキュリティ

- すべての処理はローカル環境またはプライベートサーバーで実行
- Claude API はゼロデータリテンション（ZDR）のオプトアウト設定を推奨
- Notionは社内ワークスペースのみにアクセス権限を付与し、外部公開しない
- 環境変数は `.env.local` に保存し、Gitにはコミットしない

## 注意事項

- **経営者本人の全面的な協力が必須**: 録音やログ収集に対する心理的な同意と継続的な関与が不可欠
- **アナログ情報は対象外**: 紙のメモや音声記録されない口頭のみのやり取りはシステム外
- **AIの回答は参考情報**: 対話インターフェースはシミュレーションであり、実際の経営判断の代替ではない
