# デモ手順

2通りのデモを用意しています。**まずは A（最短）** を推奨します。

---

## A. 最短デモ（Notion不要・Anthropicキーだけ）

`DEMO_MODE=true` でサンプルデータ（架空の「サンプルテック株式会社」代表 山田太郎）を使うため、
**Notionもデバイスも不要**。Anthropic APIキーだけで経営者クローンを体験できます。

### 準備（2分）
```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local   # ZDRキー推奨
```

### デモ1: Web対話UI（おすすめ）
```bash
npm run demo:web
# → http://127.0.0.1:8787 をブラウザで開く
```
質問例（クローンが根拠[S1][T1]付きで経営者として回答します）:
- 「来期の投資配分はどうすべき？」
- 「競合が生成AIを入れてきた。うちはどう動く？」
- 「受託事業は続けるべき？」
- 「解約率を下げるには？」

### デモ2: 会議前ブリーフィング
```bash
npm run demo:brief -- "来期の新規事業投資をどう判断するか"
# → briefings/ にMarkdown生成。見解＋根拠＋想定反論＋確認論点が1枚に
```

### デモ3: CLI対話
```bash
npm run demo:chat
```

**見せ場**: 回答末尾の「参照元: [S1] …」で、クローンが**どのシグナル/ストーリーを根拠に判断したか**が
辿れること（＝ブラックボックスでない）。

---

## B. フルデモ（入力〜出力の一気通貫・Notion＋Anthropic）

実際のパイプライン（収集→名寄せ→抽出→Notion→対話）を見せる場合。

### 準備
1. `.env.local` に `ANTHROPIC_API_KEY` と Notion（`NOTION_TOKEN` / `NOTION_SIGNAL_DB_ID` / `NOTION_STORY_DB_ID`）を設定
2. Notionに2つのDBを作成しインテグレーションを共有（`README.md` 参照）

### 実演
```bash
# 1) サンプルの「録音文字起こし」と「LINEトーク」を受け皿に投入
cp demo/2026-07-13_lifelog-sample.txt lifelog-inbox/
cp demo/line-sample.txt messenger-inbox/

# 2) 収集→抽出（LINE・録音から重要シグナルを抽出しNotionへ）
npm run collect
npm run extract        # → NotionのシグナルDBに「撤退方針」「7:3配分」等が入る

# 3) ストーリー構築（因果を整理）
npm run analyze        # → ストーリーDBに因果ストーリーが入る

# 4) 対話・ブリーフィング
npm run web            # ブラウザで壁打ち（参照元はNotionリンク）
npm run brief -- "受託事業からの撤退是非"
```

**見せ場**: LINE/録音という**生の言動**が、数分後には**構造化されたシグナル**になり、
経営者クローンが**その根拠を引用しながら**判断を返すこと。

---

## デモの流れ（ピッチ向け・5分）

1. 課題提示（30秒）: 経営判断がボトルネック、暗黙知が属人化
2. デモ1 Web対話（2分）: 「来期の投資配分は？」→ 根拠付き回答 → 参照元を指さす
3. デモ2 ブリーフィング（1分）: 議題→1枚の意思決定資料が即生成
4. 仕組み説明（1分）: 入力(LINE/Plaud/GWS)→シグナル→ストーリー→対話
5. 締め（30秒）: 会議削減・意思決定の高速化・暗黙知の資産化
