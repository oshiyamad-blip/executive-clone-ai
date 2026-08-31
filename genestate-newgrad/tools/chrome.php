<?php
/**
 * 確認用ページの「親テーマ代役」ヘッダー／フッター
 *
 * 本番では get_header() / get_footer() により親テーマの実物が入る。
 * ローカル確認・社内共有・意匠切替の3つのツールが同じものを使うため、
 * ここに1つだけ置いている。
 * （以前は3ファイルに同じ内容が散っていて、住所の更新漏れが起きやすかった）
 *
 * @package GeneState_Newgrad
 */

/**
 * 代役ヘッダー／フッターのCSS。
 *
 * 色は採用ページ本体と同じ genestate のトークン
 * （黒 #19110C / 金 #C7A52D）をそのまま使う。
 *
 * @return string <style> の中身。
 */
function ng_chrome_css() {
	return <<<'CSS'
/* --- 親テーマ代役のヘッダー/フッター -------------------------------------
   本番では親テーマの実物が入る。ここでは採用ページが実サイトの
   ヘッダーとフッターに挟まれたときの見え方を確かめるための代役。
   ---------------------------------------------------------------------- */
.pv-header {
	display: flex; align-items: center; justify-content: space-between; gap: 16px;
	padding: 16px 40px; background: #FFFFFF; color: #19110C;
}
.pv-header__logo { font-weight: 700; letter-spacing: .04em; }
.pv-header__right { display: flex; align-items: center; gap: 24px; }
.pv-header__nav { display: flex; flex-wrap: wrap; gap: 20px; font-size: 13px; }
.pv-header__cta { display: flex; gap: 8px; }
.pv-header__cta span {
	display: block; min-width: 100px; padding: 8px 22px; border-radius: 50px;
	border: 1px solid; text-align: center; color: #FFFFFF; font-size: 13px;
}
.pv-header__cta .is-recruit { background: #19110C; border-color: #19110C; }
.pv-header__cta .is-contact { background: #C7A52D; border-color: #C7A52D; }
.pv-footer {
	padding: 46px 40px 51px; background: #19110C; color: #FFFFFF;
	border-radius: 0 240px 0 0; font-size: 13px; line-height: 1.9;
}
.pv-footer small { color: rgba(255, 255, 255, .6); }
@media (max-width: 767px) {
	.pv-header { padding: 16px 20px; }
	.pv-header__nav, .pv-header__cta { display: none; }
	.pv-footer { padding: 30px 20px; border-radius: 0 120px 0 0; }
}
CSS;
}

/**
 * 代役ヘッダーのHTML。
 *
 * @return string
 */
function ng_chrome_header() {
	return '<header class="pv-header"><span class="pv-header__logo">株式会社ジーンステイト</span>'
		. '<span class="pv-header__right">'
		. '<nav class="pv-header__nav"><span>ジーンステイトについて</span><span>事業紹介</span><span>会社情報</span><span>採用情報</span></nav>'
		. '<span class="pv-header__cta"><span class="is-recruit">採用情報</span><span class="is-contact">お問い合わせ</span></span>'
		. '</span></header>' . "\n";
}

/**
 * 代役フッターのHTML。
 *
 * @param string $note 末尾に添える注記。
 * @return string
 */
function ng_chrome_footer( $note = '（本番では既存サイトのフッターが入ります）' ) {
	return '<footer class="pv-footer">株式会社ジーンステイト<br>'
		. '〒163-0539 東京都新宿区西新宿1-26-2 新宿野村ビル39階'
		. '<br><small>' . esc_html( $note ) . '</small></footer>' . "\n";
}

/**
 * CSS を「スマートフォン幅で見たときに効くルールだけ」に組み替える。
 *
 * 意匠の切替ページで PC/SP を切り替えるためのもの。
 * 画面を実際に狭くしないとメディアクエリは効かないため、
 * あらかじめ SP のときだけ効くCSSを作っておき、<style> ごと差し替える。
 *
 * やっていること
 *   1. コメントを除く（中に { } を含むものがあり、括弧の対応が取れなくなるため）
 *   2. min-width のブロックを捨てる（PCでしか効かないルール）
 *   3. max-width のブロックは囲みを外して直接書き出す（SPでは常に効く）
 *   4. vw と svh を 375×667 の端末に置き換える
 *      （幅を狭めても vw は実際の画面幅で計算されてしまうため）
 *
 * 出来上がったものは本番には出ない。確認ページの中だけで使う。
 *
 * @param string $css 元のCSS。
 * @return string SP用に組み替えたCSS。
 */
function ng_sp_css( $css ) {
	/* 1. コメントを除去 */
	$css = preg_replace( '!/\*.*?\*/!s', '', $css );

	/* 2〜3. トップレベルのブロックに分けて振り分ける */
	$out   = '';
	$depth = 0;
	$start = 0;
	$len   = strlen( $css );

	for ( $i = 0; $i < $len; $i++ ) {
		$ch = $css[ $i ];
		if ( '{' === $ch ) {
			$depth++;
		} elseif ( '}' === $ch ) {
			$depth--;
			if ( 0 === $depth ) {
				$block = substr( $css, $start, $i - $start + 1 );
				$start = $i + 1;

				$brace   = strpos( $block, '{' );
				$prelude = trim( substr( $block, 0, $brace ) );

				if ( 0 === stripos( $prelude, '@media' ) ) {
					if ( false !== stripos( $prelude, 'min-width' ) ) {
						continue; // PC専用。SPでは効かない
					}
					if ( false !== stripos( $prelude, 'max-width' ) ) {
						// 囲みを外して中身をそのまま出す
						$body = substr( $block, $brace + 1 );
						$body = substr( $body, 0, strrpos( $body, '}' ) );
						$out .= $body . "\n";
						continue;
					}
				}
				$out .= $block . "\n";
			}
		}
	}

	/* 4. 画面幅に依存する単位を、375×667 の端末の値に置き換える */
	$out = preg_replace_callback(
		'/(-?[0-9]*\.?[0-9]+)vw\b/',
		function ( $m ) { return round( (float) $m[1] * 3.75, 2 ) . 'px'; },
		$out
	);
	$out = preg_replace_callback(
		'/(-?[0-9]*\.?[0-9]+)s?vh\b/',
		function ( $m ) { return round( (float) $m[1] * 6.67, 2 ) . 'px'; },
		$out
	);

	return $out;
}
