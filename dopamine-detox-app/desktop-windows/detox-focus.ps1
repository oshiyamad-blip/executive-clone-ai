#Requires -Version 5.1
<#
.SYNOPSIS
  セッション中、許可したアプリ以外を前面に出させない常駐ツール（Windows）。

.DESCRIPTION
  0.4秒ごとに「いま手前にあるウィンドウ」を見て、許可リストに無ければ最小化する。
  プロセスは強制終了しない（Word の未保存文書を巻き添えにしないため）。

  記録はスマホアプリと同じ JSON 形式で残るので、書き出して PWA 側に読み込ませられる。

.PARAMETER Minutes
  セッションの長さ（分）。

.PARAMETER Identify
  ブロックはせず、前面のアプリのプロセス名とウィンドウタイトルを表示し続ける。
  許可リストに何を書けばいいか調べるためのモード。

.PARAMETER DryRun
  最小化はせず、ブロック対象を表示するだけ。許可リストの確認用。

.EXAMPLE
  .\detox-focus.ps1 -Identify
  .\detox-focus.ps1 -Minutes 45
#>
param(
  [int]$Minutes = 30,
  [switch]$Identify,
  [switch]$DryRun,
  [string]$Config,
  [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Win32 ────────────────────────────────────────────────────────────────
Add-Type -Namespace Detox -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();

[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

[DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int cmd);

[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
'@

$SW_MINIMIZE = 6

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 設定の読み込み ────────────────────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Config) { $Config = Join-Path $scriptDir 'allowlist.json' }
if (-not $LogPath) { $LogPath = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'detox-pc-log.json' }

. (Join-Path (Join-Path $scriptDir 'lib') 'matching.ps1')

if (-not (Test-Path -LiteralPath $Config)) {
  throw "許可リストが見つかりません: $Config`n（allowlist.example.json をコピーして allowlist.json を作ってください）"
}
$conf = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($conf.PSObject.Properties.Name -contains 'allow') -or -not @($conf.allow).Count) {
  throw "$Config に allow が入っていません。許可アプリを1つ以上書いてください。"
}

$neverTouch = @(Get-DefaultNeverTouch)
if ($conf.PSObject.Properties.Name -contains 'neverTouch') {
  $neverTouch += @($conf.neverTouch)
}
$neverTouch = @($neverTouch | ForEach-Object { ($_ -replace '\.exe$', '').ToLowerInvariant() })

# ── 前面ウィンドウの取得 ──────────────────────────────────────────────────
function Get-ForegroundApp {
  $hwnd = [Detox.Win32]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }

  # $pid は PowerShell の読み取り専用の自動変数なので使えない
  [uint32]$procId = 0
  [void][Detox.Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if ($procId -eq 0) { return $null }

  $sb = New-Object System.Text.StringBuilder 512
  [void][Detox.Win32]::GetWindowText($hwnd, $sb, $sb.Capacity)

  $name = $null
  # 管理者権限のプロセスは情報が取れない。その場合は触らない（不明なものは壊さない）
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return $null }

  [pscustomobject]@{
    Handle      = $hwnd
    ProcessId   = $procId
    ProcessName = $name
    Title       = $sb.ToString()
  }
}

# ── 記録（スマホアプリと同じ JSON 形式）──────────────────────────────────
function New-Id { [guid]::NewGuid().ToString() }
function Get-EpochMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Read-Log {
  if (Test-Path -LiteralPath $LogPath) {
    try {
      $raw = Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8
      if (-not [string]::IsNullOrWhiteSpace($raw)) { return ($raw | ConvertFrom-Json) }
    } catch {
      # 壊れていたら退避して作り直す（記録の追記が止まる方が困る）
      Copy-Item -LiteralPath $LogPath -Destination "$LogPath.broken" -Force
    }
  }
  [pscustomobject]@{ version = 1; sessions = @(); impulses = @(); settings = [pscustomobject]@{} }
}

function Write-Log {
  param($Log)
  $dir = Split-Path -Parent $LogPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # PWA 側が読めるよう UTF-8（BOM なし）で書く
  $json = $Log | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($LogPath, $json, (New-Object Text.UTF8Encoding $false))
}

# ── Identify モード ──────────────────────────────────────────────────────
if ($Identify) {
  Write-Host '前面のアプリを表示します。調べたいアプリに切り替えてください。Ctrl+C で終了。' -ForegroundColor Cyan
  Write-Host ''
  $last = ''
  while ($true) {
    $app = Get-ForegroundApp
    if ($app) {
      $line = '{0,-28} {1}' -f $app.ProcessName, $app.Title
      if ($line -ne $last) {
        if (Test-Allowed -App $app -Rules $conf.allow -NeverTouch $neverTouch -SelfPid $PID) { $mark = '許可'; $color = 'Green' }
        else { $mark = 'ブロック'; $color = 'Yellow' }
        Write-Host ('[{0}] {1}' -f $mark, $line) -ForegroundColor $color
        $last = $line
      }
    }
    Start-Sleep -Milliseconds 700
  }
}

# ── セッション ───────────────────────────────────────────────────────────

# ダブルクリック起動では引数を渡せないので、-Minutes が無いときは対話で聞く
if (-not $PSBoundParameters.ContainsKey('Minutes')) {
  $answer = Read-Host '何分にしますか？ (そのまま Enter で30分)'
  if (-not [string]::IsNullOrWhiteSpace($answer)) {
    $parsed = 0
    if ([int]::TryParse($answer.Trim(), [ref]$parsed) -and $parsed -ge 1) {
      $Minutes = $parsed
    } else {
      throw "分は1以上の数字で入れてください（入力: $answer）"
    }
  }
}

if ($Minutes -lt 1) { throw 'Minutes は 1 以上にしてください。' }

$script:startedAt  = Get-EpochMs
$script:durationMs = [int64]$Minutes * 60000
$script:sessionId  = New-Id
$script:impulses   = @()
$script:lastSeen   = @{}   # プロセス名 → 最後に記録した時刻（ms）。連続記録の抑制用
$script:finished   = $false
$script:aborted    = $false
$script:blockCount = 0
$script:flashUntil = 0

$allowLabels = @($conf.allow | ForEach-Object {
  if ($_.PSObject.Properties.Name -contains 'label') { $_.label } else { $_.process }
}) -join ' / '

Write-Host ''
Write-Host ("セッション開始: {0}分" -f $Minutes) -ForegroundColor Cyan
Write-Host ("許可: {0}" -f $allowLabels)
Write-Host ("記録: {0}" -f $LogPath)
if ($DryRun) { Write-Host '(DryRun: 最小化はしません)' -ForegroundColor Yellow }
Write-Host ''

# ── HUD ──────────────────────────────────────────────────────────────────
$form = New-Object Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.StartPosition   = 'Manual'
$form.BackColor       = [Drawing.Color]::White
$form.Size            = New-Object Drawing.Size 268, 104
$form.Padding         = New-Object Windows.Forms.Padding 1
$area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object Drawing.Point (($area.Right - $form.Width - 16), ($area.Bottom - $form.Height - 16))

$border = New-Object Windows.Forms.Panel
$border.Dock = 'Fill'
$border.BackColor = [Drawing.Color]::White
$border.BorderStyle = 'FixedSingle'
$form.Controls.Add($border)

$timeLabel = New-Object Windows.Forms.Label
$timeLabel.Font      = New-Object Drawing.Font 'Segoe UI', 26, ([Drawing.FontStyle]::Regular)
$timeLabel.ForeColor = [Drawing.ColorTranslator]::FromHtml('#16161a')
$timeLabel.AutoSize  = $false
$timeLabel.Size      = New-Object Drawing.Size 170, 44
$timeLabel.Location  = New-Object Drawing.Point 14, 10
$timeLabel.TextAlign = 'MiddleLeft'
$border.Controls.Add($timeLabel)

$stateLabel = New-Object Windows.Forms.Label
$stateLabel.Font      = New-Object Drawing.Font 'Segoe UI', 9
$stateLabel.ForeColor = [Drawing.ColorTranslator]::FromHtml('#6a6a70')
$stateLabel.AutoSize  = $false
$stateLabel.Size      = New-Object Drawing.Size 238, 32
$stateLabel.Location  = New-Object Drawing.Point 15, 58
$border.Controls.Add($stateLabel)

$stopButton = New-Object Windows.Forms.Button
$stopButton.Text      = '中断'
$stopButton.Font      = New-Object Drawing.Font 'Segoe UI', 8
$stopButton.FlatStyle = 'Flat'
$stopButton.ForeColor = [Drawing.ColorTranslator]::FromHtml('#6a6a70')
$stopButton.BackColor = [Drawing.Color]::White
$stopButton.Size      = New-Object Drawing.Size 56, 26
$stopButton.Location  = New-Object Drawing.Point 196, 16
$stopButton.FlatAppearance.BorderColor = [Drawing.ColorTranslator]::FromHtml('#cfcecb')
$border.Controls.Add($stopButton)

$stopButton.Add_Click({
  $answer = [Windows.Forms.MessageBox]::Show(
    'セッションを中断しますか？中断も記録に残ります。',
    'ドーパミンデトックス',
    [Windows.Forms.MessageBoxButtons]::YesNo,
    [Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -eq [Windows.Forms.DialogResult]::Yes) {
    $script:aborted = $true
    $form.Close()
  }
})

# ── 監視ループ ───────────────────────────────────────────────────────────
$tick = {
  $now = Get-EpochMs
  $left = $script:startedAt + $script:durationMs - $now

  if ($left -le 0) {
    $script:finished = $true
    $form.Close()
    return
  }

  $span = [TimeSpan]::FromMilliseconds($left)
  if ($span.TotalHours -ge 1) {
    $clock = '{0}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds
  } else {
    $clock = '{0:00}:{1:00}' -f $span.Minutes, $span.Seconds
  }
  $timeLabel.Text = $clock

  $app = Get-ForegroundApp
  if ($app -and -not (Test-Allowed -App $app -Rules $conf.allow -NeverTouch $neverTouch -SelfPid $PID)) {
    if (-not $DryRun) { [void][Detox.Win32]::ShowWindow($app.Handle, $SW_MINIMIZE) }

    $key = $app.ProcessName.ToLowerInvariant()
    $prev = if ($script:lastSeen.ContainsKey($key)) { $script:lastSeen[$key] } else { 0 }
    # 同じアプリを何度も掴んでも、記録は60秒に1件に抑える
    if ($now - $prev -gt 60000) {
      $script:lastSeen[$key] = $now
      $script:blockCount++
      $script:impulses += [pscustomobject]@{
        id        = New-Id
        at        = $now
        target    = (Resolve-Target $app.ProcessName $app.Title)
        intensity = 3
        triggers  = @()
        outcome   = 'resisted'
        note      = ('PC: ブロック — {0}「{1}」' -f $app.ProcessName, $app.Title)
        sessionId = $script:sessionId
      }
      Write-Host ('  ブロック: {0}  {1}' -f $app.ProcessName, $app.Title) -ForegroundColor Yellow
    }
    $script:flashUntil = $now + 2500
    $stateLabel.Text = ('{0} は今は開けません' -f $app.ProcessName)
    $stateLabel.ForeColor = [Drawing.ColorTranslator]::FromHtml('#16161a')
  }
  elseif ($now -gt $script:flashUntil) {
    if ($script:blockCount -gt 0) {
      $idle = 'ブロック {0} 件' -f $script:blockCount
    } else {
      $idle = 'セッション中'
    }
    $stateLabel.Text = $idle
    $stateLabel.ForeColor = [Drawing.ColorTranslator]::FromHtml('#6a6a70')
  }
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick($tick)

$form.Add_Shown({ & $tick; $timer.Start() })
$form.Add_FormClosing({ $timer.Stop() })

[void][Windows.Forms.Application]::Run($form)

# ── 後始末 ───────────────────────────────────────────────────────────────
$endedAt = Get-EpochMs
if ($script:finished) {
  $status = 'done'
  $endedAt = $script:startedAt + $script:durationMs
} else {
  $status = 'aborted'
}

$log = Read-Log
$log.sessions = @($log.sessions) + @([pscustomobject]@{
  id         = $script:sessionId
  startedAt  = $script:startedAt
  durationMs = $script:durationMs
  endedAt    = $endedAt
  status     = $status
})
$log.impulses = @($log.impulses) + $script:impulses
Write-Log $log

Write-Host ''
if ($script:finished) {
  [Console]::Beep(880, 220); [Console]::Beep(1174, 320)
  Write-Host ("完了。{0}分、離れていられました。" -f $Minutes) -ForegroundColor Green
} else {
  Write-Host ("中断しました（{0}）。" -f ([TimeSpan]::FromMilliseconds($endedAt - $script:startedAt).ToString('hh\:mm\:ss'))) -ForegroundColor Yellow
}
Write-Host ("ブロック {0} 件 / 記録: {1}" -f $script:blockCount, $LogPath)
