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
$stderrLog = Join-Path $env:TEMP 'probe-fwd-err.txt'

$devLines = (& $adb devices) -split "`r?`n"
$devLine = $devLines | Where-Object { $_ -match "\sdevice$" -and $_ -notmatch "^List of" } | Select-Object -First 1
if (-not $devLine) { Write-Output "NO DEVICE ATTACHED - plug in USB with debugging on"; exit 1 }
$serial = ($devLine.Trim() -split "\s+")[0]
Write-Output "serial=$serial"

$remote = "/data/local/tmp/probe-server.jar"
& $adb -s $serial push $jar $remote | Out-Null
Write-Output "pushed server"

$scid = "7a3b9c2"
$socketName = "scrcpy_" + $scid.PadLeft(8, '0')
Write-Output "scid=$scid socketName=$socketName"

& $adb -s $serial forward --remove-all 2>$null | Out-Null
& $adb -s $serial forward "tcp:27183" "localabstract:$socketName"
Write-Output "=== forward --list ==="
& $adb -s $serial forward --list

$argstr = "CLASSPATH=$remote app_process / com.genymobile.scrcpy.Server 5.0.1 scid=$scid tunnel_forward=true video=true audio=false control=true send_device_meta=false video_codec=h264 log_level=warn"
Write-Output "server cmd: $argstr"
$proc = Start-Process -FilePath $adb -ArgumentList @('-s', $serial, 'shell', $argstr) -PassThru -WindowStyle Hidden -RedirectStandardError $stderrLog
Start-Sleep -Seconds 3

function Read-Bytes($sock, $n) {
  $buf = New-Object byte[] $n
  $got = 0
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($got -lt $n -and $sw.ElapsedMilliseconds -lt 8000) {
    try {
      $sock.ReceiveTimeout = 1000
      $r = $sock.Client.Receive($buf, $got, $n - $got, [Net.Sockets.SocketFlags]::None)
      if ($r -le 0) { Start-Sleep -Milliseconds 50 }
      $got += $r
    } catch [Net.Sockets.SocketException] {
      if ($_.Exception.SocketErrorCode -ne 'TimedOut') { break }
    }
  }
  return $buf, $got
}

$socks = @()
for ($i = 0; $i -lt 2; $i++) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', 27183)
    Write-Output "connected to forwarded port 27183 (socket #$($i+1))"
    $socks += $c
  } catch {
    Write-Output "socket #$($i+1) connect failed: $($_.Exception.Message)"
  }
}

foreach ($s in $socks) {
  $b, $n = Read-Bytes $s 12
  $hex = ($b[0..($n-1)] | ForEach-Object { $_.ToString('x2') }) -join ' '
  $ascii = -join ($b[0..($n-1)] | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
  Write-Output "  first $n bytes"
  Write-Output "  hex:   $hex"
  Write-Output "  ascii: $ascii"
}

foreach ($s in $socks) { $s.Close() }
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
& $adb -s $serial shell pkill -f probe-server.jar 2>$null | Out-Null
& $adb -s $serial forward --remove "tcp:27183" | Out-Null
& $adb -s $serial shell rm -f $remote | Out-Null
Write-Output "=== server stderr ==="
Get-Content $stderrLog -ErrorAction SilentlyContinue | Select-Object -Last 8