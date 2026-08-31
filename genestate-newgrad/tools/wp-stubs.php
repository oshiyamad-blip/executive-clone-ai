<?php
/**
 * WordPress 関数の最小スタブ
 *
 * WordPress 無しで page-newgrad.php を実行するために、テンプレートが呼ぶ
 * WordPress 関数だけを最小限に埋めるもの。
 * tools/render-preview.php と tools/render-artifact.php が共通で読み込む。
 *
 * 呼び出し側で ABSPATH と NG_PREVIEW を定義してから読み込むこと。
 *
 * @package GeneState_Newgrad
 */

function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function esc_attr( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function esc_url( $t )  { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function home_url( $path = '' ) { return 'https://genestate.co.jp' . $path; }
function get_permalink() { return home_url( '/newgrad/' ); }
function get_the_title() { return '新卒採用'; }
function current_time( $format ) { return date( $format ); }
function get_stylesheet_directory() { return dirname( __DIR__ ) . '/theme'; }
function get_stylesheet_directory_uri() { return 'assets-base'; }
function is_page_template( $t ) { return 'page-newgrad.php' === $t; }
function add_action() {}
function wp_enqueue_style() {}
function wp_enqueue_script() {}
