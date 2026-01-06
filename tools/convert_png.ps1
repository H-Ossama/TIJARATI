$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Host "Failed to load System.Drawing: $($_.Exception.Message)"
  exit 1
}

$dir = 'c:\Dev\TIJARATI\mobile\assets'
if (-not (Test-Path $dir)) {
  Write-Host "Assets folder not found: $dir"
  exit 1
}

Get-ChildItem $dir -Filter *.png | ForEach-Object {
  $src = $_.FullName
  $tmp = "$src.__tmp.png"
  try {
    $img = [System.Drawing.Image]::FromFile($src)
    $img.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    Move-Item -Force $tmp $src
    Write-Host "PNG ok: $($_.Name)"
  } catch {
    try { if (Test-Path $tmp) { Remove-Item $tmp -Force } } catch { }
    Write-Host "PNG fail: $($_.Name) -> $($_.Exception.Message)"
  }
}
