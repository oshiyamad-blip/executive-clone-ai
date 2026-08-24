@echo off
rem 前面のアプリのプロセス名とウィンドウタイトルを表示する。
rem allowlist.json に何を書けばいいかを調べるために使う。Ctrl+C で終了。
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detox-focus.ps1" -Identify
