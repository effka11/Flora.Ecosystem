# Бенчмарк FVC против x264 (intra-only, tune psnr) на y4m-клипе.
# Использование: pwsh tools/bench.ps1 -Input bench/clip.y4m [-Frames 30]
# Выход: CSV-строки "codec,point,bytes,bpp,psnr" на stdout (парсится tools/bdrate.mjs).

param(
    [Parameter(Mandatory = $true)][string]$InputY4m,
    [int]$Frames = 30
)

$ErrorActionPreference = "Stop"
$fvc = Join-Path $PSScriptRoot "..\target\release\fvc.exe"
$tmp = Join-Path $PSScriptRoot "..\bench\tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$name = [IO.Path]::GetFileNameWithoutExtension($InputY4m)

# Обрезаем вход до N кадров один раз (одинаковый источник для всех).
$src = Join-Path $tmp "$name-src.y4m"
ffmpeg -y -hide_banner -loglevel error -i $InputY4m -frames:v $Frames $src

# Пиксели для bpp.
$probe = ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $src
$w, $h = $probe -split ","
$pixels = [long]$w * [long]$h * $Frames

function PsnrOf($dist) {
    $out = & $fvc psnr --ref $src --dist $dist
    if ($out -match "overall (\d+\.\d+)") { return [double]$Matches[1] }
    throw "psnr parse failed: $out"
}

Write-Output "codec,point,bytes,bpp,psnr"

foreach ($qp in 16, 24, 32, 40, 48) {
    $enc = Join-Path $tmp "$name-fvc-q$qp.fvc"
    $dec = Join-Path $tmp "$name-fvc-q$qp.y4m"
    & $fvc encode -i $src -o $enc --qp $qp | Out-Null
    & $fvc decode -i $enc -o $dec | Out-Null
    $bytes = (Get-Item $enc).Length
    $psnr = PsnrOf $dec
    $bpp = [math]::Round(8.0 * $bytes / $pixels, 5)
    Write-Output "fvc,qp$qp,$bytes,$bpp,$psnr"
}

foreach ($crf in 18, 23, 28, 33, 38, 43) {
    $enc = Join-Path $tmp "$name-x264-crf$crf.264"
    $dec = Join-Path $tmp "$name-x264-crf$crf.y4m"
    ffmpeg -y -hide_banner -loglevel error -i $src -c:v libx264 -preset medium -tune psnr `
        -g 1 -keyint_min 1 -crf $crf -pix_fmt yuv420p -f h264 $enc
    ffmpeg -y -hide_banner -loglevel error -i $enc -pix_fmt yuv420p $dec
    $bytes = (Get-Item $enc).Length
    $psnr = PsnrOf $dec
    $bpp = [math]::Round(8.0 * $bytes / $pixels, 5)
    Write-Output "x264,crf$crf,$bytes,$bpp,$psnr"
}
