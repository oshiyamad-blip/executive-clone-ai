# 許可判定と対象推定。Windows API に触らない純粋なロジックだけを置き、
# ここだけは Windows 以外でもテストできるようにしてある（tests/matching.tests.ps1）。

Set-StrictMode -Version Latest

<#
  タイトルにパターン（文字列または文字列の配列）のどれかが含まれるか。
#>
function Test-TitleMatch {
  param([string]$Title, $Pattern)
  if ($null -eq $Title) { $Title = '' }
  foreach ($p in @($Pattern)) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    if ($Title.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

<#
  前面のアプリを許可するか。

  ルールの評価順は「除外が先、包含が後」。これは Chrome を分けるために要る。
  YouTube Music を「アプリとしてインストール」した窓のタイトルは "YouTube Music" だが、
  同じページを普通のタブで開くと "YouTube Music - Google Chrome" になる。
  titleNotContains に " - Google Chrome" を置くことで、前者だけを通す。
#>
function Test-Allowed {
  param(
    [Parameter(Mandatory)]$App,
    [Parameter(Mandatory)]$Rules,
    $NeverTouch = @(),
    [int]$SelfPid = -1
  )

  if ($App.ProcessId -eq $SelfPid) { return $true }

  $proc = ($App.ProcessName -replace '\.exe$', '')
  if (@($NeverTouch) -contains $proc.ToLowerInvariant()) { return $true }

  foreach ($rule in @($Rules)) {
    if (-not ($rule.PSObject.Properties.Name -contains 'process')) { continue }
    if ($proc -ine ($rule.process -replace '\.exe$', '')) { continue }

    $props = $rule.PSObject.Properties.Name
    if ($props -contains 'titleNotContains' -and (Test-TitleMatch $App.Title $rule.titleNotContains)) {
      continue
    }
    if ($props -contains 'titleContains') {
      if (Test-TitleMatch $App.Title $rule.titleContains) { return $true }
      continue
    }
    return $true
  }
  return $false
}

<#
  プロセス名とウィンドウタイトルから、衝動ログの対象をあてる。
  外れても記録が残ること自体が目的なので、判定は緩くてよい。
#>
function Resolve-Target {
  param([string]$ProcessName, [string]$Title)
  $p = ($ProcessName + '').ToLowerInvariant()
  $t = ($Title + '').ToLowerInvariant()

  if ($t -match 'youtube|niconico|ニコニコ|netflix|prime video|abema|twitch') { return 'video' }
  if ($t -match 'twitter|instagram|facebook|tiktok|threads|reddit') { return 'sns' }
  if ($p -match 'discord|slack|line|teams|chatwork') { return 'message' }
  if ($p -match 'steam|epicgames|riotclient|leagueoflegends|minecraft') { return 'game' }
  if ($p -match 'vlc|mpc-hc|wmplayer|potplayer') { return 'video' }
  if ($p -match 'chrome|msedge|firefox|brave|opera|vivaldi') { return 'sns' }
  return 'other'
}

<#
  既定で絶対に最小化してはいけないもの。
  デスクトップやタスクバー（explorer）を落とすと操作不能になり、
  タスクマネージャーを塞ぐと止める手段が無くなる。
#>
function Get-DefaultNeverTouch {
  @(
    'explorer',
    'taskmgr',
    'lockapp', 'consent', 'credentialuibroker',
    'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp',
    'textinputhost', 'ctfmon'
  )
}
