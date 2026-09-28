# plan_dApp.md D0–D3 真實瀏覽器冒煙測試（Windows 端執行）。
# 以 headless Microsoft Edge 開啟 Gateway 同源提供的 web/tests/browser-smoke.html，該頁用同源
# iframe 操作真正的 owner.html／buyer.html；結果寫在分頁標題，這裡經 DevTools 的 /json/list
# 讀回（不需要 WebSocket 用戶端或額外套件）。
#
# 前提：WSL 內 network／gateway 已啟動（Windows 可經 WSL2 localhost 轉送連到 https://localhost:8443）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e\browserSmoke.ps1
param(
  [string]$Url = 'https://localhost:8443/tests/browser-smoke.html',
  [string]$Browser = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  [int]$DebugPort = 9333,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$profileDir = Join-Path $env:TEMP "vehiclenet-browser-smoke-$PID"
# --ignore-certificate-errors：Gateway 使用本機自簽憑證（見 web/README.md），僅限測試用途。
$process = Start-Process -FilePath $Browser -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--ignore-certificate-errors',
  "--remote-debugging-port=$DebugPort", "--user-data-dir=$profileDir", $Url
)

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $title = ''
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 3
    } catch {
      continue
    }
    $page = $pages | Where-Object { $_.url -like '*browser-smoke*' } | Select-Object -First 1
    if ($page -and $page.title -like 'SMOKE-*') {
      $title = $page.title
      break
    }
  }
  if (-not $title) {
    Write-Output "逾時：$TimeoutSeconds 秒內未取得測試結果"
    exit 1
  }

  # /json/list 回傳的標題經過 HTML 跳脫（&quot; 等），需先還原。
  $summary = [System.Net.WebUtility]::HtmlDecode($title.Substring($title.IndexOf(' ') + 1)) | ConvertFrom-Json
  Write-Output $summary.userAgent
  foreach ($step in $summary.steps) {
    $mark = if ($step.ok) { 'PASS' } else { 'FAIL' }
    Write-Output "$mark $($step.name) $($step.detail)"
  }
  if ($summary.passed) {
    Write-Output '全部通過'
    exit 0
  }
  exit 1
} finally {
  # headless Edge 會衍生多個子行程，依 user-data-dir 找出本次啟動的全部行程後結束。
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$profileDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
