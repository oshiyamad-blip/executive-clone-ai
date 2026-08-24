@echo off
rem セッションを開始する。引数なしなら30分。
rem   detox-focus.cmd            → 30分
rem   detox-focus.cmd -Minutes 45
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detox-focus.ps1" %*
