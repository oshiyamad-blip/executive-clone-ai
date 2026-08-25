# 許可判定のテスト。Windows API に触れないので、pwsh があればどの OS でも走る。
#   pwsh -NoProfile -File tests/matching.tests.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path (Join-Path $root 'lib') 'matching.ps1')

$rules = (Get-Content -LiteralPath (Join-Path $root 'allowlist.example.json') -Raw -Encoding UTF8 |
  ConvertFrom-Json).allow
$never = @(Get-DefaultNeverTouch)

$script:failed = 0
$script:passed = 0

function Assert {
  param([string]$Name, [bool]$Actual, [bool]$Expected)
  if ($Actual -eq $Expected) {
    $script:passed++
    Write-Host ("ok   {0}" -f $Name)
  } else {
    $script:failed++
    Write-Host ("FAIL {0}  期待={1} 実際={2}" -f $Name, $Expected, $Actual) -ForegroundColor Red
  }
}

function App {
  param([string]$Process, [string]$Title, [int]$Id = 1234)
  [pscustomobject]@{ ProcessName = $Process; Title = $Title; ProcessId = $Id }
}

function Allowed {
  param($App)
  [bool](Test-Allowed -App $App -Rules $rules -NeverTouch $never -SelfPid 9999)
}

# ── Chrome: アプリウィンドウは通し、通常のブラウザ窓は弾く ──────────────
Assert 'YouTube Music のアプリウィンドウは許可' `
  (Allowed (App 'chrome' 'YouTube Music')) $true

Assert 'YouTube Music を普通のタブで開いた Chrome は不許可' `
  (Allowed (App 'chrome' 'YouTube Music - Google Chrome')) $false

Assert '普通の Chrome ウィンドウは不許可' `
  (Allowed (App 'chrome' 'X（旧Twitter） - Google Chrome')) $false

Assert 'タイトルが空の Chrome は不許可' `
  (Allowed (App 'chrome' '')) $false

Assert 'Edge のアプリウィンドウは許可' `
  (Allowed (App 'msedge' 'YouTube Music')) $true

Assert '普通の Edge ウィンドウは不許可' `
  (Allowed (App 'msedge' 'YouTube Music - Microsoft Edge')) $false

# ── タイトル条件のないルールはプロセス名だけで通す ──────────────────────
Assert 'Word はタイトルによらず許可' `
  (Allowed (App 'WINWORD' '第3稿.docx - Word')) $true

Assert 'Word は .exe 付きのルールでも一致する' `
  (Allowed (App 'winword.exe' '無題')) $true

Assert '許可リストに無いアプリは不許可' `
  (Allowed (App 'Discord' 'Discord')) $false

Assert '脚本エディタの雛形はプロセス名が一致すれば許可' `
  (Allowed (App 'your-editor' '第1幕')) $true

# ── 触ってはいけないもの ────────────────────────────────────────────────
Assert 'explorer は必ず許可（デスクトップとタスクバー）' `
  (Allowed (App 'explorer' '')) $true

Assert 'タスクマネージャーは必ず許可（逃げ道）' `
  (Allowed (App 'Taskmgr' 'タスク マネージャー')) $true

Assert 'ロック画面は必ず許可' `
  (Allowed (App 'LockApp' '')) $true

Assert '自分自身（HUD）は必ず許可' `
  ([bool](Test-Allowed -App (App 'pwsh' 'detox' 9999) -Rules $rules -NeverTouch $never -SelfPid 9999)) $true

# ── 衝動ログの対象推定 ──────────────────────────────────────────────────
function AssertEq {
  param([string]$Name, [string]$Actual, [string]$Expected)
  if ($Actual -eq $Expected) { $script:passed++; Write-Host ("ok   {0}" -f $Name) }
  else { $script:failed++; Write-Host ("FAIL {0}  期待={1} 実際={2}" -f $Name, $Expected, $Actual) -ForegroundColor Red }
}

AssertEq 'YouTube は動画' (Resolve-Target 'chrome' 'YouTube - Google Chrome') 'video'
AssertEq 'Instagram は SNS' (Resolve-Target 'chrome' 'Instagram - Google Chrome') 'sns'
AssertEq 'Discord はメッセージ' (Resolve-Target 'Discord' 'general') 'message'
AssertEq 'Steam はゲーム' (Resolve-Target 'steam' 'Steam') 'game'
AssertEq 'ブラウザ既定は SNS' (Resolve-Target 'firefox' '検索') 'sns'
AssertEq 'それ以外はその他' (Resolve-Target 'notepad' 'メモ帳') 'other'

Write-Host ''
Write-Host ("{0} 件成功 / {1} 件失敗" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
