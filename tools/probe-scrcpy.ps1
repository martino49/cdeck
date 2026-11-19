$ErrorActionPreference = 'Continue'
if ($env:CDECK_ADB) {
  $adb = $env:CDECK_ADB
} else {
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  $adb = if ($cmd) { $cmd.Source } else { Join-Path $env:APPDATA 'CDeck\bin\platform-tools\adb.exe' }
}
if (-not (Test-Path $adb)) { Write-Output "adb not found: $adb (set CDECK_ADB or run CDeck once)"; exit 1 }
$scrcpyRoot = Join-Path $env:APPDATA 'CDeck\bin\scrcpy'
$jarFile = Get-ChildItem -Path $scrcpyRoot -Filter 'scrcpy-server*' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jarFile) { Write-Output "scrcpy-server not found under $scrcpyRoot - run CDeck once so it downloads tools"; exit 1 }
$jar = $jarFile.FullName
$stderrLog = Join-Path $env:TEMP 'probe-srv-err.txt'

$devLines = (& $adb devices) -split "`r?`n"
$devLine = $devLines | Where-Object { $_ -match "\sdevice$" -and $_ -notmatch "^List of" } | Select-Object -First 1
if (-not $devLine) { Write-Output "NO DEVICE ATTACHED - plug in USB with debugging on"; exit 1 }
$serial = ($devLine.Trim() -split "\s+")[0]
$transport = if ($serial -match "^\d+\.\d+\.\d+\.\d+") { "wireless" } else { "usb" }
Write-Output "serial=$serial ($transport)"
Write-Output "current reverse rules on device:"
& $adb -s $serial reverse --list

$remote = "/data/local/tmp/probe-server.jar"
& $adb -s $serial push $jar $remote | Out-Null
Write-Output "pushed: $remote"

$scid = "1a2b3c4d"
$socketName = "scrcpy_$scid"
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
Write-Output "local tcp port=$port"

& $adb -s $serial reverse "localabstract:$socketName" "tcp:$port"
Write-Output "=== reverse --list (what adb registered on device) ==="
& $adb -s $serial reverse --list
Write-Output "=== end list ==="

$argstr = "CLASSPATH=$remote app_process / com.genymobile.scrcpy.Server 5.0.1 scid=$scid video=true audio=false control=true send_device_meta=false video_codec=h264 log_level=warn"
Write-Output "server cmd: $argstr"
$proc = Start-Process -FilePath $adb -ArgumentList @('-s', $serial, 'shell', $argstr) -PassThru -WindowStyle Hidden -RedirectStandardError $stderrLog

$socks = @()
$deadline = (Get-Date).AddSeconds(12)
while ($socks.Count -lt 2 -and (Get-Date) -lt $deadline) {
  if ($listener.Pending()) {
    $c = $listener.AcceptTcpClient()
    $socks += $c
    Write-Output "accepted connection #$($socks.Count) from $($c.Client.RemoteEndPoint)"
  } else {
    Start-Sleep -Milliseconds 200
  }
}
Write-Output "accepted $($socks.Count) socket(s)"

for ($i = 0; $i -lt $socks.Count; $i++) {
  $s = $socks[$i]
  $s.ReceiveTimeout = 4000
  $stream = $s.GetStream()
  $buf = New-Object byte[] 64
  try {
    $n = 0
    try { $n = $stream.Read($buf, 0, 64) } catch { }
    $hex = ($buf[0..([Math]::Max(0,$n-1))] | ForEach-Object { $_.ToString('x2') }) -join ' '
    $ascii = -join ($buf[0..([Math]::Max(0,$n-1))] | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
    Write-Output "socket #$($i+1): read $n bytes"
    Write-Output "  hex:   $hex"
    Write-Output "  ascii: $ascii"
  } catch {
    Write-Output "socket #$($i+1): read failed: $($_.Exception.Message)"
  }
}

foreach ($s in $socks) { $s.Close() }
$listener.Stop()
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
& $adb -s $serial shell pkill -f probe-server.jar 2>$null | Out-Null
& $adb -s $serial reverse --remove "localabstract:$socketName" | Out-Null
& $adb -s $serial shell rm -f $remote | Out-Null
Write-Output "=== server stderr ==="
Get-Content $stderrLog -ErrorAction SilentlyContinue | Select-Object -Last 12