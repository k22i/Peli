# Runs the spike self-test on Windows and saves results\<name>.json/.png/.log.
#   pwsh scripts/windows/run.ps1 -Mode single -Name windows-single
# Extra knobs come from the environment (SPIKE_WIN_ZORDER, SPIKE_WIN_DISABLE,
# SPIKE_MPV_ARGS, MPV_BIN).
param(
  [string]$Mode = "single",
  [string]$Name = "windows-$Mode",
  [string]$Exe = "bin\spike.exe"
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
New-Item -ItemType Directory -Force results | Out-Null
$out = (Resolve-Path results).Path

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  public static string ClassAt(int x, int y) {
    var p = new POINT { X = x, Y = y };
    var h = WindowFromPoint(p);
    var sb = new System.Text.StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString() + " (0x" + h.ToString("x") + ")";
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

$env:SPIKE_MODE = $Mode
$env:SPIKE_SELFTEST = Join-Path $out "$Name.json"
$env:SPIKE_MPV_LOG = Join-Path $out "$Name.mpv.log"
$env:SPIKE_INPUT_WAIT = "6"
$env:SPIKE_HOLD = "4"
$env:SPIKE_WINDOW_X = "0"; $env:SPIKE_WINDOW_Y = "0"
$env:SPIKE_WINDOW_W = "960"; $env:SPIKE_WINDOW_H = "540"
if (-not $env:SPIKE_MEDIA) { $env:SPIKE_MEDIA = (Resolve-Path media\test.mp4).Path }

$log = Join-Path $out "$Name.log"
$proc = Start-Process -FilePath $Exe -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"

function Wait-Log([string]$pattern, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $log) -and (Select-String -Path $log, "$log.err" -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

$probe = @{}
if (Wait-Log "SPIKE_READY_FOR_INPUT" 90) {
  # [NullString] so the class argument is NULL, not "" (which matches nothing).
  $hwnd = [W]::FindWindowW([NullString]::Value, "Cove spike: mpv --wid ($Mode)")
  [W]::SetForegroundWindow($hwnd) | Out-Null
  $pt = New-Object W+POINT; $pt.X = 0; $pt.Y = 0
  [W]::ClientToScreen($hwnd, [ref]$pt) | Out-Null
  $rc = New-Object W+RECT
  [W]::GetClientRect($hwnd, [ref]$rc) | Out-Null
  # Centre probe box, then the play/pause button bottom-left (the controls
  # bar is 12px from the bottom, the button ~35px above the client bottom).
  $cx = $pt.X + [int]($rc.R / 2); $cy = $pt.Y + [int]($rc.B / 2)
  $probe["probeHit"] = [W]::ClassAt($cx, $cy)
  [W]::Click($cx, $cy); Start-Sleep -Milliseconds 500
  $bx = $pt.X + 42; $by = $pt.Y + $rc.B - 35
  $probe["buttonHit"] = [W]::ClassAt($bx, $by)
  [W]::Click($bx, $by); Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait("x"); Start-Sleep -Milliseconds 500
  $probe["clientOrigin"] = "$($pt.X),$($pt.Y)"
  $probe["clientSize"] = "$($rc.R)x$($rc.B)"
}
$probe | ConvertTo-Json | Set-Content (Join-Path $out "$Name.hit.json")

Wait-Log "SPIKE_READY_FOR_SCREENSHOT|start failed" 60 | Out-Null
Start-Sleep -Seconds 1
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save((Join-Path $out "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)

if (-not $proc.WaitForExit(30000)) { $proc.Kill() }
Write-Host "== $Name"
Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Select-String "\[spike\] (step|embed)"
Get-Content (Join-Path $out "$Name.hit.json")
