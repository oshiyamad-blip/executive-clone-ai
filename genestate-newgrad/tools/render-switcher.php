<?php
/**
 * 意匠の切替ページ生成ツール（社内共有用）
 *
 * 採用トップをそのまま出しつつ、上部のスイッチで意匠の案を切り替えられる
 * 1枚HTMLを書き出す。本番の見え方のまま案を比べられるようにするためのもの。
 *
 * 使い方:
 *   php tools/render-switcher.php > preview/switcher.html
 *
 * 仕組み:
 *   MV は案ごとに構造が違うため、NG_SWITCHER を立てて4案すべてを描画し、
 *   表示は data-mv 属性とCSSで1案に絞る。
 *   数字と育成はマークアップが同じでCSSだけが違うので、JSでクラスを付け替える。
 *   本番では page-newgrad.php が NG_MV / NG_NUMBERS / NG_GROWTH を見て
 *   選ばれた1案だけを描画するので、このページの切替結果がそのまま本番になる。
 *
 * @package GeneState_Newgrad
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/' );
define( 'NG_PREVIEW', true );
/** 4案すべてを描画させる（このツールでのみ立てる） */
define( 'NG_SWITCHER', true );

$theme_dir = dirname( __DIR__ ) . '/theme';

require_once __DIR__ . '/wp-stubs.php';
/* 親テーマ代役のヘッダー/フッター（3つのツールで共通） */
require_once __DIR__ . '/chrome.php';

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	/* @charset はインラインの <style> では無効な記述になるため取り除く */
	$css = preg_replace( '/^@charset\s+"[^"]*";\s*/i', '', $css );

	echo "<title>新卒採用トップ 意匠の切替</title>\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n";
	echo "<link href=\"https://fonts.googleapis.com/css2?family=Marcellus&family=Zen+Kaku+Gothic+New:wght@300;400;500;700&display=swap\" rel=\"stylesheet\">\n";
	echo "<style>\n" . $css . "\n</style>\n";

	echo "<style>\n" . ng_chrome_css() . "\n</style>\n";

	echo <<<'SWCSS'
<style>
/* ==========================================================================
   意匠の切替バー（.sw-）

   採用ページ本体（.ng 配下）には一切影響しない。
   色と書体は本体と同じ genestate のトークンから取り、浮かないようにしている。
   ブランドが確定した明るい世界のページなので、閲覧者のテーマに関わらず
   同じ見え方になるよう配色は固定して明示的に塗っている。
   ========================================================================== */
:root {
	--sw-ink:   #19110C;
	--sw-gold:  #C7A52D;
	--sw-bone:  #F5F4EE;
	--sw-line:  #DDDDDD;
	--sw-muted: #756F6B;
	--sw-white: #FFFFFF;
	color-scheme: light;
}
body {
	margin: 0;
	background: var(--sw-white);
	color: var(--sw-ink);
	font-family: "Zen Kaku Gothic New", sans-serif;
	font-size: 16px;
	line-height: 2;
}

/* --- 切替バー --- */
.sw-bar {
	position: sticky;
	top: 0;
	z-index: 50;
	background: var(--sw-bone);
	border-bottom: 1px solid var(--sw-gold);
	padding: 14px 40px;
}
.sw-bar__inner {
	max-width: 1220px;
	margin: 0 auto;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px 28px;
}
.sw-lead {
	font-size: 13px;
	font-weight: 700;
	letter-spacing: .08em;
	line-height: 1.6;
	white-space: nowrap;
}
.sw-lead small {
	display: block;
	font-size: 11px;
	font-weight: 400;
	letter-spacing: 0;
	color: var(--sw-muted);
}
.sw-group { display: flex; align-items: center; gap: 8px; }
.sw-group__label {
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .08em;
	color: var(--sw-muted);
	white-space: nowrap;
}
.sw-seg {
	display: flex;
	background: var(--sw-white);
	border: 1px solid var(--sw-line);
	border-radius: 50px;
	padding: 3px;
	gap: 2px;
}
.sw-seg button {
	appearance: none;
	border: 0;
	background: transparent;
	border-radius: 50px;
	padding: 5px 13px;
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	line-height: 1.6;
	color: var(--sw-ink);
	cursor: pointer;
	white-space: nowrap;
	transition: background-color .2s ease, color .2s ease;
}
.sw-seg button:hover { background: var(--sw-bone); }
.sw-seg button[aria-pressed="true"] {
	background: var(--sw-gold);
	color: var(--sw-white);
}
.sw-seg button:focus-visible {
	outline: 2px solid var(--sw-ink);
	outline-offset: 2px;
}
.sw-now {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 6px 16px;
	background: var(--sw-ink);
	border-radius: 50px;
	color: var(--sw-white);
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .04em;
	line-height: 1.6;
	white-space: nowrap;
}
.sw-note {
	padding: 10px 40px;
	background: var(--sw-white);
	border-bottom: 1px solid var(--sw-line);
	color: var(--sw-muted);
	font-size: 12px;
	line-height: 1.8;
	text-align: center;
}

/* --- MV の出し分け ---------------------------------------------------------
   4案すべてがHTMLに入っていて、選ばれていない案を隠している。
   本番では選ばれた1案だけが描画されるので、この指定は要らなくなる。
   -------------------------------------------------------------------------- */
:root[data-mv="a"] .ng-hero:not(.ng-hero--a),
:root[data-mv="b"] .ng-hero:not(.ng-hero--b),
:root[data-mv="c"] .ng-hero:not(.ng-hero--c),
:root[data-mv="d"] .ng-hero:not(.ng-hero--d) { display: none !important; }

/* 本体が出す開発者向けの下書きバーは、切替バーと役割が重なるので隠す */
.ng-draftbar { display: none !important; }

@media (max-width: 900px) {
	.sw-bar { padding: 12px 20px; }
	.sw-now { margin-left: 0; }
	.sw-note { padding: 10px 20px; }
}
@media (prefers-reduced-motion: reduce) {
	* { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
SWCSS;

	echo "\n";

	/* --- 切替バー --- */
	echo <<<'SWBAR'
<div class="sw-bar">
	<div class="sw-bar__inner">
		<p class="sw-lead">意匠を切り替えて確認<small>選んだ組み合わせが、そのまま本番の見え方です</small></p>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-mv">MV</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-mv">
				<button type="button" data-part="mv" data-value="a" aria-pressed="true">A 全面写真</button>
				<button type="button" data-part="mv" data-value="b" aria-pressed="false">B 左右分割</button>
				<button type="button" data-part="mv" data-value="c" aria-pressed="false">C 白ベース</button>
				<button type="button" data-part="mv" data-value="d" aria-pressed="false">D タイポ主役</button>
			</div>
		</div>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-num">数字</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-num">
				<button type="button" data-part="numbers" data-value="a" aria-pressed="true">A 黒ベタ</button>
				<button type="button" data-part="numbers" data-value="b" aria-pressed="false">B 白ベース</button>
			</div>
		</div>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-gro">育成</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-gro">
				<button type="button" data-part="growth" data-value="a" aria-pressed="true">A 横4段</button>
				<button type="button" data-part="growth" data-value="b" aria-pressed="false">B 縦</button>
			</div>
		</div>

		<p class="sw-now">いまの組み合わせ <span id="sw-now-text">MV-A ／ 数字-A ／ 育成-A</span></p>
	</div>
</div>
<p class="sw-note">斜線のボックスは写真が入る位置です（撮影がまだのため、指示文を表示しています）。黄色の「要確認」は社内で数値の確定が必要な箇所です。上下のヘッダーとフッターは形だけの代役で、本番では既存サイトの実物が入ります。</p>
SWBAR;

	echo "\n" . ng_chrome_header();
}

function get_footer() {
	$js = file_get_contents( dirname( __DIR__ ) . '/theme/assets/js/newgrad.js' );
	echo ng_chrome_footer();
	echo "<script>\n" . $js . "\n</script>\n";

	echo <<<'SWJS'
<script>
/* 意匠の切替。
   MV は data-mv 属性でCSSが出し分ける。
   数字と育成はマークアップが同じなので、クラスを付け替えるだけでよい。
   選んだ内容は端末に覚えさせ、開き直しても保たれるようにしている。 */
(function () {
	var STORE = 'ng-switcher';
	var state = { mv: 'a', numbers: 'a', growth: 'a' };

	try {
		var saved = JSON.parse(localStorage.getItem(STORE) || '{}');
		['mv', 'numbers', 'growth'].forEach(function (k) {
			if (saved[k]) { state[k] = saved[k]; }
		});
	} catch (e) { /* 保存が使えない環境でも既定値で動く */ }

	var root = document.documentElement;

	function applyNumbers(v) {
		var sec = document.getElementById('numbers');
		if (!sec) { return; }
		sec.classList.toggle('ng-section--brand', v === 'a');
		sec.classList.toggle('ng-numbers--plain', v === 'b');
	}

	function applyGrowth(v) {
		var list = document.querySelector('.ng-growth__timeline');
		if (!list) { return; }
		list.classList.toggle('ng-growth__timeline--vertical', v === 'b');
	}

	function label() {
		var mv = state.mv.toUpperCase();
		return 'MV-' + mv + ' ／ 数字-' + state.numbers.toUpperCase() + ' ／ 育成-' + state.growth.toUpperCase();
	}

	function render() {
		root.setAttribute('data-mv', state.mv);
		applyNumbers(state.numbers);
		applyGrowth(state.growth);

		document.querySelectorAll('.sw-seg button').forEach(function (b) {
			var on = state[b.dataset.part] === b.dataset.value;
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
		});

		var now = document.getElementById('sw-now-text');
		if (now) { now.textContent = label(); }

		try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
	}

	document.querySelectorAll('.sw-seg button').forEach(function (b) {
		b.addEventListener('click', function () {
			state[b.dataset.part] = b.dataset.value;
			render();

			/* MV は画面の一番上にあるので、切り替えたら見える位置まで戻す */
			if (b.dataset.part === 'mv') {
				var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
				window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
			}
		});
	});

	render();
})();
</script>
SWJS;
	echo "\n";
}

/* -------------------------------------------------------------------------
 * テンプレートを実行
 * ------------------------------------------------------------------------- */
require_once $theme_dir . '/inc/newgrad-functions.php';
require $theme_dir . '/page-newgrad.php';
