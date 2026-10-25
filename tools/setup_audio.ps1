$ErrorActionPreference = 'Stop'
$audioTools = Join-Path (Split-Path $PSScriptRoot -Parent) '.audio-tools'
New-Item -ItemType Directory -Force -Path $audioTools | Out-Null
if (-not (Test-Path "$audioTools/vgmstream/vgmstream-cli.exe")) {
    Invoke-WebRequest 'https://github.com/vgmstream/vgmstream/releases/download/r2117/vgmstream-win64.zip' -OutFile "$audioTools/vgmstream-win64.zip"
    Expand-Archive "$audioTools/vgmstream-win64.zip" -DestinationPath "$audioTools/vgmstream" -Force
}
if (-not (Test-Path "$audioTools/ffmpeg/package/ffmpeg.exe")) {
    Invoke-WebRequest 'https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz' -OutFile "$audioTools/ffmpeg.tgz"
    New-Item -ItemType Directory -Force -Path "$audioTools/ffmpeg" | Out-Null
    tar -xzf "$audioTools/ffmpeg.tgz" -C "$audioTools/ffmpeg"
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg extraction failed' }
}
if (-not (Test-Path "$audioTools/wwiser.pyz")) {
    Invoke-WebRequest 'https://github.com/bnnm/wwiser/releases/download/v20260808/wwiser.pyz' -OutFile "$audioTools/wwiser.pyz"
}
Write-Output 'Audio tools ready. Run python/python.exe tools/build_audio.py'
