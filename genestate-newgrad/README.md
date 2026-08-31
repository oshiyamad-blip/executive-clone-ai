# 株式会社ジーンステイト 新卒採用サイト

コーポレートサイト（genestate.co.jp）配下に設置する、新卒採用サイト `/newgrad/` の一式。
既存のWordPressテーマの上に、**ページテンプレートとして載せる**構成になっている。

---

## いまの状態

| | 状態 |
| --- | --- |
| 採用トップ `/newgrad/` | ✅ 実装済み（このリポジトリ） |
| 下層ページ | 📄 コンテンツ設計済み・未実装（`docs/02-sitemap-ia.md`） |
| 掲載する数値・募集要項 | ⚠️ **未確定。プレースホルダ**（`docs/05-data-requests.md`） |
| 写真 | ⚠️ **未入稿。18カット必要**（`docs/04-photo-requirements.md`） |
| 配色・フォント | ✅ **実サイトのCSSから採取して反映済み**（採取記録は `docs/06-design-token-request.md`） |

未確定の項目があるあいだは**下書きモード**で動作し、
該当箇所に「要確認」バッジが表示され、検索エンジンにも拾われない（noindex）。

---

## ディレクトリ

```
genestate-newgrad/
├── README.md                          このファイル
│
├── docs/                              企画・設計ドキュメント
│   ├── 01-strategy.md                 採用コンセプト / メッセージ設計 / コピー候補
│   ├── 02-sitemap-ia.md               サイトマップ / 下層ページのコンテンツ設計
│   ├── 04-photo-requirements.md       必要写真18カットの撮影指示書
│   ├── 05-data-requests.md            社内で確定が必要な情報リスト
│   └── 06-design-token-request.md    配色・フォント採取の記録（採取済みの値と出どころ）
│
├── theme/                             WordPress子テーマに設置するファイル
│   ├── page-newgrad.php               採用トップのページテンプレート
│   ├── functions-snippet.php          子テーマ functions.php への追記内容
│   ├── inc/
│   │   ├── newgrad-functions.php      ヘルパー関数・アセット読み込み・OGP
│   │   ├── newgrad-content.php        ★掲載する文言・数値（ここだけ編集すればよい）
│   │   └── newgrad-photos.php         ★写真の定義（ID・代替テキスト・撮影指示）
│   └── assets/
│       ├── css/newgrad.css            ★冒頭にデザイントークン（トンマナ差し替え箇所）
│       ├── js/newgrad.js              アコーディオン・フェードイン・固定CTA
│       └── img/                       ここに P-01.jpg 〜 P-18.jpg を置く
│
├── design/                            意匠の検討用
│   ├── *.dc.html / canvas.json        MV・セクションの案（キャンバス用の元ファイル）
│   └── options.html                   ★案を比較する社内選定ページ（Artifactへ公開する中身）
│
├── tools/
│   ├── wp-stubs.php                   WordPress関数の最小スタブ（下の2本が共通で使う）
│   ├── render-preview.php             ローカル確認用の静的プレビュー生成
│   └── render-artifact.php            社内共有用（Artifact）HTML の生成
│
└── preview/
    ├── index.html                     生成済みプレビュー（ブラウザで開ける）
    └── artifact.html                  生成済み社内共有版（Artifact へ公開する中身）
```

**★印の3ファイルだけで、掲載内容・写真・デザインのすべてが変えられる。**
`page-newgrad.php` は原則として触らなくてよい。

---

## WordPress への設置手順

### 前提
- 既存テーマの**子テーマ**があること。無い場合は先に子テーマを作成する
  （親テーマを直接編集すると、テーマ更新時に上書きで消える）

### 手順

**1. ファイルを子テーマにコピーする**

```
wp-content/themes/（子テーマ）/
├── page-newgrad.php          ← theme/page-newgrad.php
├── inc/                      ← theme/inc/ をディレクトリごと
└── assets/                   ← theme/assets/ をディレクトリごと
```

`theme/functions-snippet.php` は**コピーしない**（中身を貼るだけのファイル）。

**2. 子テーマの `functions.php` の末尾に追記する**

```php
require_once get_stylesheet_directory() . '/inc/newgrad-functions.php';
```

詳細と補足は `theme/functions-snippet.php` を参照。

**3. 固定ページを作成する**

WordPress 管理画面 → 固定ページ → 新規追加

| 項目 | 値 |
| --- | --- |
| タイトル | 新卒採用 |
| パーマリンク（スラッグ） | `newgrad` |
| ページ属性 → テンプレート | **新卒採用トップ** |
| 本文 | 空のままでよい（内容はテンプレートが出力する） |

公開すると `https://genestate.co.jp/newgrad/` で表示される。

**4. 表示を確認する**

ヘッダー・フッターが既存サイトと同じものになっていることを確認する。
`get_header()` / `get_footer()` で親テーマのものを読んでいるため、
**グローバルナビ・ロゴ・フッターは自動的に同一**になる。

もし本文のスタイルが親テーマに負けている場合は、
`theme/functions-snippet.php` の「補足1」を参照。

---

## 掲載内容の編集

`theme/inc/newgrad-content.php` を開いて、該当箇所の文字列を書き換えるだけ。
WordPress の管理画面での操作は不要（＝**表示崩れの事故が起きない**）。

```php
'hero' => array(
    'catch' => '素質は、動き出せる。',        // ← ここを書き換える
    'sub'   => 'まだ名前のついていない…',
```

確認が済んだ項目は、その項目の `'todo' => true,` の行を削除する。
すべて削除できたら、`functions.php` に次を追記して下書きモードを解除する。

```php
define( 'NG_DRAFT_MODE', false );   // require_once より前に書くこと
```

---

## 写真の入れ方

`theme/assets/img/` に、**写真IDをそのままファイル名にして置く**。

```
assets/img/P-01.jpg
assets/img/P-03.webp
```

対応拡張子は `.webp` → `.jpg` → `.jpeg` → `.png` の順で探索する。
置いた瞬間に反映される。撮影の指定は `docs/04-photo-requirements.md` を参照。

---

## プレビュー（WordPress無しで見た目を確認する）

用途に応じて2本ある。どちらも `page-newgrad.php` をそのまま実行して書き出すので、
中身は常に本体と一致する。

### ローカルで開く

```bash
php tools/render-preview.php > preview/index.html
```

生成された `preview/index.html` をブラウザで開く。
CSSとJSがインライン化された1枚のHTMLなので、そのままメールで送ることもできる。

### 意匠の選定（MV 4案などを比べてもらう）

`design/options.html` は、MV 4案とセクション意匠2箇所×2案を並べた選定用のページ。
生成ツールは無く、手で書いた1枚のHTMLをそのまま Artifact として公開する。

モックは 1440px の設計を container query（`cqw`）で縮尺表示している。
`1cqw` = 枠幅の1% なので、設計値の px を 14.4 で割った値を書けば、
どの画面幅で見ても 1440px 設計の比率のまま縮む。

配色・書体は採用ページ本体と同じ実サイトの値のみを使っている。
**案を1つ選んでもらったら、`page-newgrad.php` の MV に反映する。**

### 社内共有（URLを配ってレビューしてもらう）

```bash
php tools/render-artifact.php > preview/artifact.html
```

書き出した `preview/artifact.html` を claude.ai の Artifact として公開すると、
URL で共有できる。**既定は非公開**で、共有相手はページの共有メニューから選ぶ。
閲覧者はページにコメントを残せるので、フィードバックの回収にも使える。

ローカル版との違いは出力形式と、冒頭に付く**レビュー用の説明帯**だけ。
帯には未確定の件数・写真の未入稿数と、デザイン担当以外が誤解しやすい2点
（斜線のボックスは写真の位置、黄色の「要確認」は数値が未確定）の凡例が入る。
採用ページ本体（`.ng` 配下）には手を入れていない。

同じページを更新するときは、`artifact.html` を作り直して**同じURLへ再公開**する。

⚠️ どちらもヘッダー・フッターは**確認用の仮のもの**。
本番では親テーマの実物に置き換わる。

---

## トンマナ（配色・フォント）

`theme/assets/css/newgrad.css` の冒頭「0. デザイントークン」ブロックが、
唯一の差し替えポイント。**2026-08-31 に実サイトのCSSから採取した実値が入っている。**

| | 実サイトの値 |
| --- | --- |
| ブランドカラー | `#19110C`（純黒ではなく茶みのある黒） |
| CTA・強調色 | `#C7A52D`（金） |
| 本文の文字色 / 補足文 | `#19110C` / `#756F6B` |
| セクションの地色 | `#F5F4EE`（温かみのあるオフホワイト） |
| 罫線 | `#DDDDDD` / `#484231`（ボタン罫線） |
| 和文フォント | `"Zen Kaku Gothic New", sans-serif`（行間 2） |
| 欧文フォント | `"Marcellus", serif` |
| ボタン | ピル型 `50px`。画像・カードは `8px` |
| コンテンツ最大幅 | `1120px` |
| セクションの上下余白 | `120px`（SP `100px`） |

採取元・各値の出どころ・寄せた意匠の一覧は `docs/06-design-token-request.md` にある。
各セクションのCSSはすべてこの変数を参照しており、色やフォントを直接書いている箇所は無い。

**このサイトの意匠で外せない3点**（コンポーネント側で再現済み）

1. **セクションの片方の上角だけを 240px 落とす**（白は左上／地色は右上）。
   地色セクションの直後の白セクションは、上半分に地色を敷いた下敷きを置き、
   切り欠きから背後を覗かせて層に見せる
2. **見出しは英字が主役**。Marcellus 48px の英字の下に、14px の和文ラベルを置き、
   その頭に**金色の丸**を付ける（罫線ではない）
3. **ボタンはピル型**。白地＋`#484231` の罫線、右端に金の丸＋白矢印。
   ホバーで黒へ反転し、矢印が丸の左外から滑り込む。**影は使わない**

> **サイズを px で持っている理由**
> 親テーマが `html { font-size: 62.5% }` を敷いているため、本番では 1rem = 10px になる。
> rem で書くと本番でだけ全体が 62.5% に縮むので、すべて px で持っている。

---

## 動作要件

- WordPress 5.0 以上 / PHP 7.4 以上
- 追加プラグイン不要
- 外部ライブラリ不要（JavaScriptは依存なしの素のJS。約5KB）
- IntersectionObserver 非対応のブラウザでは、アニメーションが無効になるだけで
  内容はすべて表示される

## アクセシビリティ / SEO

- 見出しの階層（h1 → h2 → h3）を維持している
- FAQ アコーディオンは `aria-expanded` / `aria-controls` に対応
- キーボード操作時のフォーカスリングを維持
- `prefers-reduced-motion` に対応（アニメーションを自動で無効化）
- 写真には代替テキストを設定（`inc/newgrad-photos.php`）
- meta description / OGP を出力（SEOプラグイン併用時は要調整）
- 下書きモード中は `noindex,nofollow`
- 印刷用スタイルあり（学生が募集要項を印刷して持参する場合に対応）
