# Generates assets/icon.ico, a quiet, warm notebook-page icon.
# Multi-size ICO with PNG-compressed images (fine on Windows 10/11).
# Rerun any time with:  powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $projectRoot "assets"
New-Item -ItemType Directory -Force $assets | Out-Null

function Draw-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 256.0   # design in 256-space, scale down

    # rounded warm-cream square background
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 239, 230, 212))
    $r = [int](52 * $s)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)

    # white page
    $page = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 253, 248))
    $px = [int](64 * $s); $py = [int](48 * $s); $pw = [int](128 * $s); $ph = [int](160 * $s)
    $pr = [int](14 * $s); $pd = 2 * $pr
    $pagePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pagePath.AddArc($px, $py, $pd, $pd, 180, 90)
    $pagePath.AddArc($px + $pw - $pd, $py, $pd, $pd, 270, 90)
    $pagePath.AddArc($px + $pw - $pd, $py + $ph - $pd, $pd, $pd, 0, 90)
    $pagePath.AddArc($px, $py + $ph - $pd, $pd, $pd, 90, 90)
    $pagePath.CloseFigure()
    $g.FillPath($page, $pagePath)

    # soft text lines on the page
    $lineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 209, 195, 168))
    $lh = [Math]::Max(2, [int](8 * $s))
    foreach ($i in 0..3) {
        $ly = [int]($py + (34 * $s) + $i * (30 * $s))
        $lw = if ($i -eq 3) { [int](60 * $s) } else { [int](92 * $s) }
        $g.FillRectangle($lineBrush, [int]($px + 18 * $s), $ly, $lw, $lh)
    }

    # terracotta bookmark ribbon
    $ribbon = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 156, 90, 60))
    $rx = [int]($px + $pw - 42 * $s); $rw = [int](22 * $s); $rtop = $py; $rlen = [int](54 * $s)
    $pts = @(
        (New-Object System.Drawing.Point($rx, $rtop)),
        (New-Object System.Drawing.Point(($rx + $rw), $rtop)),
        (New-Object System.Drawing.Point(($rx + $rw), ($rtop + $rlen))),
        (New-Object System.Drawing.Point(($rx + [int]($rw / 2)), ($rtop + $rlen - [int](12 * $s)))),
        (New-Object System.Drawing.Point($rx, ($rtop + $rlen)))
    )
    $g.FillPolygon($ribbon, $pts)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # the leading comma stops PowerShell unrolling the byte array
    return ,([byte[]]$ms.ToArray())
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @{}
foreach ($sz in $sizes) { $images[$sz] = Draw-IconPng $sz }

# ICO container: 6-byte header, 16-byte entry per image, then PNG payloads
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
    [byte[]]$bytes = $images[$sz]
    $dim = if ($sz -ge 256) { 0 } else { $sz }
    $w.Write([Byte]$dim); $w.Write([Byte]$dim)      # width, height (0 = 256)
    $w.Write([Byte]0); $w.Write([Byte]0)            # palette, reserved
    $w.Write([UInt16]1); $w.Write([UInt16]32)       # planes, bpp
    $w.Write([UInt32]$bytes.Length)
    $w.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($sz in $sizes) { $w.Write([byte[]]$images[$sz]) }
$w.Flush()

$icoPath = Join-Path $assets "icon.ico"
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$w.Dispose()
Write-Host "Wrote $icoPath ($((Get-Item $icoPath).Length) bytes)"
