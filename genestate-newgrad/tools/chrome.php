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
