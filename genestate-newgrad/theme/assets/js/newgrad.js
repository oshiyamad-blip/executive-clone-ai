/**
 * 新卒採用サイト（/newgrad/）のインタラクション
 *
 * 依存ライブラリなし。IntersectionObserver 非対応環境では
 * すべての要素を表示済みとして扱い、内容が読めなくなることは無い。
 *
 * 1. FAQ アコーディオン
 * 2. スクロール連動のフェードイン
 * 3. モバイル固定CTAの表示制御
 * 4. ページ内アンカーのスムーススクロールと現在地表示
 */
( function () {
	'use strict';

	var root = document.getElementById( 'newgrad' );
	if ( ! root ) {
		return;
	}

	var prefersReducedMotion = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

	/* ---------------------------------------------------------------
	 * 1. FAQ アコーディオン
	 * --------------------------------------------------------------- */
	root.querySelectorAll( '[data-ng-faq] .ng-faq__q' ).forEach( function ( button ) {
		button.addEventListener( 'click', function () {
			var expanded = button.getAttribute( 'aria-expanded' ) === 'true';
			var panel    = document.getElementById( button.getAttribute( 'aria-controls' ) );

			button.setAttribute( 'aria-expanded', String( ! expanded ) );
			if ( panel ) {
				panel.setAttribute( 'data-open', String( ! expanded ) );
			}
		} );
	} );

	/* ---------------------------------------------------------------
	 * 2. スクロール連動のフェードイン
	 * --------------------------------------------------------------- */
	var revealTargets = root.querySelectorAll( '.ng-reveal' );

	if ( ! ( 'IntersectionObserver' in window ) || prefersReducedMotion ) {
		// 非対応環境・動きを減らす設定では、最初から表示しておく。
		revealTargets.forEach( function ( el ) {
			el.setAttribute( 'data-revealed', 'true' );
		} );
	} else {
		var revealObserver = new IntersectionObserver(
			function ( entries ) {
				entries.forEach( function ( entry ) {
					if ( ! entry.isIntersecting ) {
						return;
					}
					entry.target.setAttribute( 'data-revealed', 'true' );
					revealObserver.unobserve( entry.target );
				} );
			},
			{ rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
		);

		revealTargets.forEach( function ( el ) {
			revealObserver.observe( el );
		} );
	}

	/* ---------------------------------------------------------------
	 * 3. モバイル固定CTA
	 *    MVを通り過ぎたら出し、最終CTAが見えている間は引っ込める。
	 *    （同じボタンが2つ並ぶのを避けるため）
	 * --------------------------------------------------------------- */
	var fixedCta = root.querySelector( '[data-ng-fixedcta]' );
	var hero     = root.querySelector( '.ng-hero' );
	var lastCta  = root.querySelector( '.ng-cta' );

	if ( fixedCta && hero && 'IntersectionObserver' in window ) {
		var heroPassed  = false;
		var ctaInView   = false;

		var syncFixedCta = function () {
			fixedCta.setAttribute( 'data-visible', String( heroPassed && ! ctaInView ) );
		};

		new IntersectionObserver(
			function ( entries ) {
				heroPassed = ! entries[ 0 ].isIntersecting;
				syncFixedCta();
			},
			{ threshold: 0 }
		).observe( hero );

		if ( lastCta ) {
			new IntersectionObserver(
				function ( entries ) {
					ctaInView = entries[ 0 ].isIntersecting;
					syncFixedCta();
				},
				{ threshold: 0 }
			).observe( lastCta );
		}
	}

	/* ---------------------------------------------------------------
	 * 4. ページ内アンカー
	 * --------------------------------------------------------------- */
	var anchorLinks = Array.prototype.slice.call(
		root.querySelectorAll( '.ng-anchors__list a[href^="#"]' )
	);

	anchorLinks.forEach( function ( link ) {
		link.addEventListener( 'click', function ( event ) {
			var target = document.querySelector( link.getAttribute( 'href' ) );
			if ( ! target ) {
				return;
			}
			event.preventDefault();
			target.scrollIntoView( {
				behavior: prefersReducedMotion ? 'auto' : 'smooth',
				block: 'start'
			} );
			// フォーカスも移動させ、キーボード操作でも位置が伝わるようにする。
			target.setAttribute( 'tabindex', '-1' );
			target.focus( { preventScroll: true } );
		} );
	} );

	// 現在表示中のセクションに対応するアンカーを強調する。
	if ( anchorLinks.length && 'IntersectionObserver' in window ) {
		var sections = anchorLinks
			.map( function ( link ) {
				return document.querySelector( link.getAttribute( 'href' ) );
			} )
			.filter( Boolean );

		var setCurrent = function ( id ) {
			anchorLinks.forEach( function ( link ) {
				link.classList.toggle( 'is-current', link.getAttribute( 'href' ) === '#' + id );
			} );
		};

		var currentObserver = new IntersectionObserver(
			function ( entries ) {
				entries.forEach( function ( entry ) {
					if ( entry.isIntersecting ) {
						setCurrent( entry.target.id );
					}
				} );
			},
			// 画面上部1/3を「現在地」の判定ラインとする。
			{ rootMargin: '-20% 0px -67% 0px', threshold: 0 }
		);

		sections.forEach( function ( section ) {
			currentObserver.observe( section );
		} );
	}
} )();
