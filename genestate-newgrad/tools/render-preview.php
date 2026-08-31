<?php
/**
 * 静的プレビュー生成ツール
 *
 * WordPress に設置する前に、page-newgrad.php の出来上がりを1枚のHTMLとして
 * 確認するためのもの。WordPress の関数を最小限スタブして、テンプレートを
 * そのまま実行し、CSS/JS をインライン化した単体HTMLを書き出す。
 *
 * 使い方:
 *   php tools/render-preview.php > preview/index.html
 *
 * 注意:
 *   ここで出力されるヘッダー・フッターは確認用の簡易版。
 *   本番では get_header() / get_footer() により親テーマの実物に置き換わる。
 *
 * @package GeneState_Newgrad
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/' );
define( 'NG_PREVIEW', true );

$theme_dir = dirname( __DIR__ ) . '/theme';

/* WordPress 関数のスタブ（render-artifact.php と共通） */
require_once __DIR__ . '/wp-stubs.php';

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	echo "<!doctype html>\n<html lang=\"ja\">\n<head>\n";
	echo "<meta charset=\"utf-8\">\n";
	echo "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
	echo "<title>新卒採用｜株式会社ジーンステイト（プレビュー）</title>\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n";
	/* 実サイトが読み込んでいるものと同一の指定（display=swap まで含めて同じ）。 */
	echo "<link href=\"https://fonts.googleapis.com/css2?family=Marcellus&family=Zen+Kaku+Gothic+New:wght@300;400;500;700&display=swap\" rel=\"stylesheet\">\n";
	echo "<style>\n" . $css . "\n</style>\n";
	echo <<<'HEADCSS'
<style>
/* ---- プレビュー専用：親テーマのヘッダー/フッターの代役 ----
   本番では親テーマの実物に置き換わる。ここでは見え方を確かめられるよう、
   実サイトのヘッダー・フッターの色と形（黒地・金のCTA・右上240pxの角丸）を写している。 */
body { margin: 0; font-family: "Zen Kaku Gothic New", sans-serif; background: #fff; }
.pv-note {
	padding: 12px 20px; background: #19110C; color: #fff;
	font-size: 13px; line-height: 1.7; text-align: center;
}
.pv-header {
	display: flex; align-items: center; justify-content: space-between; gap: 16px;
	padding: 16px 40px; background: #fff;
}
.pv-header__logo { font-weight: 700; letter-spacing: .04em; }
.pv-header__right { display: flex; align-items: center; gap: 24px; }
.pv-header__nav { display: flex; flex-wrap: wrap; gap: 20px; font-size: 13px; }
/* 実サイトのヘッダーCTA：ピル型・黒と金の2本 */
.pv-header__cta { display: flex; gap: 8px; }
.pv-header__cta span {
	display: block; min-width: 100px; padding: 8px 22px; border-radius: 50px;
	border: 1px solid; text-align: center; color: #fff; font-size: 13px;
}
.pv-header__cta .is-recruit { background: #19110C; border-color: #19110C; }
.pv-header__cta .is-contact { background: #C7A52D; border-color: #C7A52D; }
.pv-footer {
	padding: 46px 40px 51px; background: #19110C; color: #fff;
	border-radius: 0 240px 0 0;
	font-size: 13px; line-height: 1.9;
}
@media (max-width: 767px) {
	.pv-header { padding: 16px 20px; }
	.pv-header__nav, .pv-header__cta { display: none; }
	.pv-footer { padding: 30px 20px; border-radius: 0 120px 0 0; }
}
</style>
HEADCSS;
	echo "\n</head>\n<body>\n";
	echo '<p class="pv-note">これは確認用の静的プレビューです。ヘッダーとフッターは仮のもので、本番では親テーマの実物が入ります（トンマナはそこで自動的に揃います）。</p>' . "\n";
	echo '<header class="pv-header"><span class="pv-header__logo">株式会社ジーンステイト</span>'
		. '<span class="pv-header__right">'
		. '<nav class="pv-header__nav"><span>ジーンステイトについて</span><span>事業紹介</span><span>会社情報</span><span>採用情報</span></nav>'
		. '<span class="pv-header__cta"><span class="is-recruit">採用情報</span><span class="is-contact">お問い合わせ</span></span>'
		. '</span></header>' . "\n";
}

function get_footer() {
	$js = file_get_contents( dirname( __DIR__ ) . '/theme/assets/js/newgrad.js' );
	echo '<footer class="pv-footer">株式会社ジーンステイト<br>東京都新宿区西新宿1-26-2 新宿野村ビル39階<br><small>（プレビュー用の仮フッター）</small></footer>' . "\n";
	echo "<script>\n" . $js . "\n</script>\n";
	echo "</body>\n</html>\n";
}

/* -------------------------------------------------------------------------
 * テンプレートを実行
 * ------------------------------------------------------------------------- */
require_once $theme_dir . '/inc/newgrad-functions.php';
require $theme_dir . '/page-newgrad.php';
