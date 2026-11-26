param(
  [Parameter(Mandatory = $true)][string]$TargetDir,
  [Parameter(Mandatory = $true)][string]$StagedDir,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$StageRoot
)

$ErrorActionPreference = 'Stop'
$backup = Join-Path $StageRoot 'previous'
$failed = Join-Path $StageRoot 'failed'
$ack = Join-Path $StageRoot 'app-ready'
$stageArgument = '--update-stage=' + (Split-Path -Leaf $StageRoot)
$restartArgs = ''
if ($env:PERCHREMOTE_UPDATE_PROFILE_ARG) {
  $restartArgs = '"' + $env:PERCHREMOTE_UPDATE_PROFILE_ARG + '"'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'PerchRemote 软件更新'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(420, 142)
$form.FormBorderStyle = 'FixedDialog'
$form.ControlBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.SetBounds(24, 24, 372, 27)
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)
$form.Controls.Add($label)
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(24, 60, 372, 13)
$bar.Style = 'Marquee'
$form.Controls.Add($bar)
$detail = New-Object System.Windows.Forms.Label
$detail.Text = '更新完成后将自动打开工作台。'
$detail.SetBounds(24, 95, 372, 24)
$form.Controls.Add($detail)

function Show-Stage([string]$Message) {
  $label.Text = $Message
  [System.Windows.Forms.Application]::DoEvents()
}

function Wait-ForCondition([int]$Seconds, [scriptblock]$Until) {
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if (& $Until) { return $true }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 150
  } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
  return (& $Until)
}

function Start-App([string]$Arguments) {
  $options = @{
    FilePath = (Join-Path $TargetDir 'PerchRemote.exe')
    WorkingDirectory = $TargetDir
    PassThru = $true
  }
  if ($Arguments.Trim()) { $options.ArgumentList = $Arguments.Trim() }
  Start-Process @options
}

$oldApp = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
$running = $null
$backedUp = $false
$replaced = $false
$keepBackup = $false

$form.Show()
Show-Stage '正在等待旧版退出…'
[System.IO.File]::WriteAllText((Join-Path $StageRoot 'helper-ready'), '')
try {
  if (!(Wait-ForCondition 30 { !$oldApp -or $oldApp.HasExited })) {
    throw '旧版在 30 秒内未退出，请关闭后重新尝试。'
  }
  Show-Stage '正在替换应用文件…'
  # Electron subprocesses can hold the directory open briefly after the main process exits.
  if (!(Wait-ForCondition 8 {
    try {
      [System.IO.Directory]::Move($TargetDir, $backup)
      return $true
    } catch [System.IO.IOException] {
      return $false
    }
  })) { throw '应用文件仍被占用，无法替换。' }
  $backedUp = $true
  [System.IO.Directory]::Move($StagedDir, $TargetDir)
  $replaced = $true

  Show-Stage '正在启动新版…'
  $running = Start-App "$restartArgs $stageArgument"
  if (!(Wait-ForCondition 60 { $running.HasExited -or [System.IO.File]::Exists($ack) }) -or
      $running.HasExited -or ![System.IO.File]::Exists($ack)) {
    throw '新版未能启动工作台。'
  }
} catch {
  $problem = $_.Exception.Message
  try {
    if ($backedUp) {
      Show-Stage '正在恢复旧版…'
      if ($running -and !$running.HasExited) {
        $running.Kill()
        if (!$running.WaitForExit(5000)) { throw '新版进程未退出。' }
      }
      if ($replaced -and !(Wait-ForCondition 8 {
        try {
          [System.IO.Directory]::Move($TargetDir, $failed)
          return $true
        } catch [System.IO.IOException] {
          return $false
        }
      })) { throw '新版文件仍被占用。' }
      [System.IO.Directory]::Move($backup, $TargetDir)
      $backedUp = $false
    }
    if (!$oldApp -or $oldApp.HasExited) {
      Start-App $restartArgs | Out-Null
      $problem += "`n已启动旧版。"
    }
  } catch {
    if ($backedUp) {
      $keepBackup = $true
      $problem += "`n旧版备份：$backup"
    }
  }
  $bar.Style = 'Continuous'
  Show-Stage '更新未完成'
  [System.Windows.Forms.MessageBox]::Show($form, $problem, '更新未完成', 'OK', 'Warning') | Out-Null
} finally {
  $form.Dispose()
  if (!$keepBackup) {
    Set-Location -LiteralPath (Split-Path -Parent $StageRoot)
    Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
