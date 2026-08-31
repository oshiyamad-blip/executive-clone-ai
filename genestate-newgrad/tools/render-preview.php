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
/* 親テーマ代役のヘッダー/フッター（3つのツールで共通） */
require_once __DIR__ . '/chrome.php';

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	echo "<!doctype html>\n<html lang=\"ja\">\n<head>\n";
	echo "<meta charset=\"utf-8\">\n";
	echo "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
	echo "<title>新卒採用｜株式会社ジーンステイト（プレビュー）</title>\n";
	/* 実サイトが読み込んでいるものと同一の指定（display=swap まで含めて同じ）。 */
	echo ng_fonts_link();
	echo "<style>\n" . $css . "\n</style>\n";
	echo "<style>\n";
	echo <<<'HEADCSS'
/* ---- プレビュー専用 ---- */
body { margin: 0; font-family: "Zen Kaku Gothic New", sans-serif; background: #fff; }
.pv-note {
	padding: 12px 20px; background: #19110C; color: #fff;
	font-size: 13px; line-height: 1.7; text-align: center;
}
HEADCSS;
	echo "\n" . ng_chrome_css() . "\n</style>\n";
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
