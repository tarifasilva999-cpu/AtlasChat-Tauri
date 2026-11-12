# Recreate the small NSIS artwork with the same type and circle motif as the app.
Add-Type -AssemblyName System.Drawing
$atlasRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fonts = [System.Drawing.Text.PrivateFontCollection]::new()
$fonts.AddFontFile((Join-Path $atlasRoot 'fonts\AtlasSans-Regular.ttf'))
$family = $fonts.Families[0]

function New-InstallerArtwork([string]$Name, [int]$Width, [int]$Height, [bool]$Sidebar) {
    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $ink = [System.Drawing.Color]::FromArgb(246, 244, 255)
    $background = if ($Sidebar) { [System.Drawing.Color]::FromArgb(15, 14, 19) } else { [System.Drawing.Color]::FromArgb(20, 19, 25) }
    $graphics.Clear($background)
    $glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(30, 133, 84, 255))
    $graphics.FillEllipse($glow, $(if ($Sidebar) { -74 } else { 72 }), -70, 220, 220)
    $glow.Dispose()
    $brush = [System.Drawing.SolidBrush]::new($ink)
    $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(168, 164, 176))
    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(169, 123, 255))
    $font = [System.Drawing.Font]::new($family, $(if ($Sidebar) { 19 } else { 17 }), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $small = [System.Drawing.Font]::new($family, 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $pen = [System.Drawing.Pen]::new($ink, $(if ($Sidebar) { 3.5 } else { 1.7 }))
    try {
        if ($Sidebar) {
            $graphics.DrawEllipse($pen, 34, 51, 17, 17)
            $graphics.DrawEllipse($pen, 53, 69, 53, 53)
            $graphics.DrawEllipse($pen, 46, 126, 8, 8)
            $graphics.DrawString('AtlasChat', $font, $brush, 19, 177)
            $graphics.DrawString("Your ideas.`nYour device.", $small, $muted, 20, 211)
            $graphics.FillRectangle($accent, 20, 279, 34, 3)
        } else {
            $graphics.DrawEllipse($pen, 8, 16, 7, 7)
            $graphics.DrawEllipse($pen, 16, 24, 17, 17)
            $graphics.DrawEllipse($pen, 13, 42, 3, 3)
            $graphics.DrawString('AtlasChat', $font, $brush, 42, 20)
        }
        $bitmap.Save((Join-Path $PSScriptRoot $Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $pen.Dispose(); $small.Dispose(); $font.Dispose()
        $accent.Dispose(); $muted.Dispose(); $brush.Dispose()
        $graphics.Dispose(); $bitmap.Dispose()
    }
}

try {
    New-InstallerArtwork 'sidebar.bmp' 164 314 $true
    New-InstallerArtwork 'header.bmp' 150 57 $false
} finally { $fonts.Dispose() }
