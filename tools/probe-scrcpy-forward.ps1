$ErrorActionPreference = 'Continue'
$adb = "C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe"
$jar = "C:\Users\USER\AppData\Roaming\cdeck\bin\scrcpy\scrcpy-win64-v5.0.1\scrcpy-server"

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
$proc = Start-Process -FilePath $adb -ArgumentList @('-s', $serial, 'shell', $argstr) -PassThru -WindowStyle Hidden -RedirectStandardError "C:\Users\USER\AppData\Local\Temp\opencode\probe-fwd-err.txt"
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
Get-Content "C:\Users\USER\AppData\Local\Temp\opencode\probe-fwd-err.txt" -ErrorAction SilentlyContinue | Select-Object -Last 8