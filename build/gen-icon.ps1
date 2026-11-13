# 生成应用图标:蓝底圆角方块 + 白色"清"字,多尺寸 PNG → 由 wrap-ico.mjs 封装成 .ico
Add-Type -AssemblyName System.Drawing

$sizes = @(256, 48, 32, 16)
$outDir = "D:\K\zcode\DiskJanitor\build\png"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  # 背景:圆角矩形,纵向渐变 #4F8CFF -> #2C5FD0
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $c1 = [System.Drawing.Color]::FromArgb(255, 79, 140, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 44, 95, 208)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 90)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = [int]($s * 0.22)
  $path.AddArc(0, 0, $r*2, $r*2, 180, 90)
  $path.AddArc($s - $r*2, 0, $r*2, $r*2, 270, 90)
  $path.AddArc($s - $r*2, $s - $r*2, $r*2, $r*2, 0, 90)
  $path.AddArc(0, $s - $r*2, $r*2, $r*2, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)

  # 白色"清"字,居中略偏上
  $fontSize = [float]($s * 0.62)
  $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $textRect = New-Object System.Drawing.RectangleF(0, ($s * -0.03), $s, $s)
  $g.DrawString('清', $font, [System.Drawing.Brushes]::White, $textRect, $fmt)

  $g.Dispose()
  $bmp.Save("$outDir\icon-$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "icon-$s.png ok"
}
