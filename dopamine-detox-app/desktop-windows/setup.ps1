# 初回セットアップ。setup.cmd から呼ばれる。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== フォーカスロックの初期設定 ===' -ForegroundColor Cyan
Write-Host ''

# インターネットから落としたファイルには「別のコンピューターから来た」印が付いていて、
# そのままだと PowerShell が実行を拒むことがある。まとめて解除しておく。
Get-ChildItem -LiteralPath $here -Recurse -File | Unblock-File
Write-Host '[1/2] ファイルのブロックを解除しました。'

$allow = Join-Path $here 'allowlist.json'
if (Test-Path -LiteralPath $allow) {
  Write-Host '[2/2] allowlist.json はすでにあります。そのまま使います。'
} else {
  Copy-Item -LiteralPath (Join-Path $here 'allowlist.example.json') -Destination $allow
  Write-Host '[2/2] allowlist.json を作りました。'
}

Write-Host ''
Write-Host '次にやること:'
Write-Host '  1. identify.cmd      許可したいアプリのプロセス名を調べる'
Write-Host '  2. allowlist.json    メモ帳で開いて書き換える'
Write-Host '  3. dryrun.cmd        最小化せずに判定だけ試す'
Write-Host '  4. detox-focus.cmd   本番'
Write-Host ''
