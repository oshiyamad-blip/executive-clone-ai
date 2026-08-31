# デザイントークン採取結果

`theme/assets/css/newgrad.css` 冒頭「0. デザイントークン」の値の出どころを記録したもの。

> **状態：✅ 採取・反映済み（2026-08-31）**
> 作業環境から genestate.co.jp に到達できたため、実CSSから直接採取した。
> 以前このファイルに書いていた「暫定値のまま」「通信が届かない」という記述は解消済み。
> `docs/05-data-requests.md` の 🟡 19〜22 はこれで閉じてよい。

採取元は、コーポレートサイトが実際に読み込んでいる**1枚のCSS**。

```
https://genestate.co.jp/cms/wp-content/themes/genestate/assets/css/main.css
```

フォントは HTML から直接。

```html
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Zen+Kaku+Gothic+New:wght@300;400;500;700&display=swap" rel="stylesheet">
```

---

## 1. 実サイトの `:root`（そのまま転記）

```css
:root {
  --white:  #fff;
  --black:  #19110C;   /* 純黒ではなく、茶みのある黒 */
  --gold:   #C7A52D;
  --gray:   #756F6B;
  --bg:     #F5F4EE;   /* 温かみのあるオフホワイト */
  --border: #DDD;
}
```

`var()` での参照回数は `--gold` 51回 / `--white` 45回 / `--black` 24回 /
`--border` 23回 / `--bg` 20回 / `--gray` **0回**。
`--gray` は定義だけされていて参照が無く、その値はニュース日付の
`.modListNews__item__data { color:#756f6b }` に直書きされている。
補足文の色としてはこの値で正しい。

---

## 2. 採取した値と、差し替え先の対応表

| 採取したもの | 変数 | 反映した値 | 出どころ |
| --- | --- | --- | --- |
| ブランドカラー | `--ng-c-brand` | `#19110C` | `--black` |
| MV/CTAの下地 | `--ng-c-brand-dark` | `#19110C` | 実サイトの黒は1色のみ |
| 淡色パネル | `--ng-c-brand-tint` | `#F5F4EE` | `--bg` |
| CTA・アクセント色 | `--ng-c-accent` | `#C7A52D` | `--gold` |
| 本文の文字色 | `--ng-c-fg` | `#19110C` | `body { color }` |
| 補足文の文字色 | `--ng-c-fg-muted` | `#756F6B` | `--gray` |
| セクション交互の背景 | `--ng-c-bg-subtle` | `#F5F4EE` | `--bg` |
| 罫線の色 | `--ng-c-line` | `#DDDDDD` | `--border` |
| 濃い罫線 | `--ng-c-line-strong` | `#484231` | `.modBtn` の `border-color` |
| 本文の `font-family` | `--ng-font` | `"Zen Kaku Gothic New", sans-serif` | `body` |
| 英字の `font-family` | `--ng-font-en` | `"Marcellus", serif` | 11箇所すべて同一 |
| 本文の `line-height` | `--ng-lh-body` | `2` | `body` |
| 本文の `letter-spacing` | `--ng-ls-head` | `.04em` | `.modHeadingLv02__text__description` |
| 英字見出しの字間 | `--ng-ls-en` | `.05em` | `.modHeadingLv02__title__en` |
| 和文ラベルの字間 | `--ng-ls-label` | `.14em` | `2px ÷ 14px` |
| ボタンの `border-radius` | `--ng-radius-pill` | `50px`（ピル型） | `.modBtn` |
| 画像・カードの角丸 | `--ng-radius` | `8px` | `.recruitList__item__img` ほか |
| セクションの片角 | `--ng-corner` / `-sp` | `240px` / `120px` | `.modSection` |
| コンテンツの最大幅 | `--ng-container` | `1120px` | `1220px − padding 50px×2` |
| セクションの上下余白 | `--ng-section-y` | `120px`（SP `100px`） | `.modSection` |

**唯一「実サイトに該当が無い」値**は `--ng-c-brand-rgb: 25, 17, 12`。
これは `#19110C` を `rgba()` に混ぜるための RGB 成分表記で、色そのものは実値。
つまり、**推測で決めた色は1つも無い**。

---

## 3. 単位を px にした理由（重要）

親テーマは `html { font-size: 62.5% }` を敷いている。本番では **1rem = 10px** になる。

`newgrad.css` は当初 rem で書かれていたため、そのまま WordPress に載せると
**本番でだけ全体が 62.5% に縮む**状態だった。93箇所の rem を px へ変換して解消済み。
実サイト自身も `font-size:16px; font-size:1.6rem;` と px を先に書く流儀なので、作法も揃っている。

---

## 4. トークンでは吸収できなかった意匠（コンポーネント側を寄せた）

| # | 実サイトの作法 | 対応 |
| --- | --- | --- |
| a | 英字ラベルは「小さな添え物」ではなく**見出しの主役**。Marcellus 48px（SP 33px）。和文は 14px の小ラベル | `.ng-head__en` / `.ng-head__title` の主従を逆転 |
| b | 見出しのあしらいは罫線ではなく**金色の丸**（6px、和文ラベルの左） | `.ng-head__title::before` |
| c | ボタンは**ピル型**（50px）。白地＋`#484231` 罫線、右端に金の丸＋白矢印。ホバーで黒へ反転し、矢印が丸の左外から滑り込む | `.ng-btn` 一式を作り直し。矢印は data URI で内蔵 |
| d | 本文リンクは金＋下線。導線リンクは黒＋下線。ホバーで下線を消す | `.ng-link` と本文リンクを別系統に |
| e | 写真の角丸は 8px | `--ng-radius` |
| f | 数値は大きい数字＋小さい単位、金色 | `.ng-numbers__value` |
| g | **セクションの片方の上角だけを 240px 落とす**（白は左上／地色は右上）。地色セクションの直後の白セクションは `::before` で上半分に地色を敷き、切り欠きから覗かせる | `.ng-section` に移植 |
| h | **影を使わない**。奥行きは地色の面と余白で出す | `--ng-shadow` を廃止 |
| i | 角丸を持たない要素が無い（正方形の角を避ける） | 全体を確認済み |

---

## 5. 反映していない実サイトの仕様（意図的）

| 項目 | 実サイト | `/newgrad/` | 理由 |
| --- | --- | --- | --- |
| ホバーの適用範囲 | ほぼ全て `min-width:768px` の中。タッチ端末では無効 | 画面幅で分けていない | 現状 `@media (hover: hover)` 等での出し分けをしていない。必要なら対応する |
| 数字セクションの地色 | `#F5F4EE` の面に淡色タイル | 黒地に金の数字 | 白／地色／黒の交互リズムを保つための設計判断。地色に寄せることも可能 |
| スクロール演出 | `opacity:0 + blur(10px)` → 解除。1文字ずつ 0.08秒ずつ遅延 | `opacity + translateY` のフェードイン | 既存実装を維持。本家のブラー＋文字送りに寄せることも可能 |
| ブレークポイント | 内容は 768、ヘッダー/フッターは 1025 の二重系統 | 768 のみ | ヘッダー/フッターは親テーマの担当のため |

---

## 6. 再採取が必要になったら

```bash
curl -sS -o main.css https://genestate.co.jp/cms/wp-content/themes/genestate/assets/css/main.css
```

1枚に minify されているので、整形してから読むとよい。

```bash
python3 -c "
import re; css=open('main.css',encoding='utf-8').read()
out=re.sub(r';', ';\n  ', re.sub(r'\{', ' {\n  ', re.sub(r'\}', '}\n', css)))
open('main.pretty.css','w',encoding='utf-8').write(out)"
```

作業環境から到達できない場合は、環境設定の **Network access** を `Custom` にして
`genestate.co.jp` と `*.genestate.co.jp` を許可リストに追加する
（「Also include default list of common package managers」のチェックは必ず残すこと）。
設定はセッション起動時に読まれるため、保存後に新しいセッションを開く必要がある。
参考：https://code.claude.com/docs/en/cloud-environments
