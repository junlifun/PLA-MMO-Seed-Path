param(
    [switch]$PortableOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root "build"
$DistDir = Join-Path $Root "dist-python"
$Stage = Join-Path $DistDir "PLA-MMO-Seed-Path"
$ReleaseDir = Join-Path $Root "release"
$Version = "0.9.5"
$AppName = "PLA-MMO-Seed-Path"

function Find-Python {
    $candidate = Get-Command python -ErrorAction SilentlyContinue
    if (-not $candidate) { throw "Python was not found." }
    return (Get-Command python).Source
}

$PythonExe = Find-Python
$PythonHome = Split-Path -Parent $PythonExe
Write-Host "Python: $PythonExe"

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Stage "python") -Force | Out-Null

Write-Host "Copying application files..."
foreach ($file in @("app.py", "requirements.txt", "LICENSE", "LICENSES.md", "README.md")) {
    Copy-Item (Join-Path $Root $file) (Join-Path $Stage $file) -Force
}
foreach ($dir in @("pla_mmo", "templates", "static", "offline_engine", "vendor", "tools")) {
    Copy-Item (Join-Path $Root $dir) (Join-Path $Stage $dir) -Recurse -Force
}

Write-Host "Copying Python runtime..."
$PythonStage = Join-Path $Stage "python"
foreach ($file in @("python.exe", "pythonw.exe", "python3.dll", "python313.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt")) {
    $source = Join-Path $PythonHome $file
    if (Test-Path $source) { Copy-Item $source (Join-Path $PythonStage $file) -Force }
}
Copy-Item (Join-Path $PythonHome "DLLs") (Join-Path $PythonStage "DLLs") -Recurse -Force
Copy-Item (Join-Path $PythonHome "tcl") (Join-Path $PythonStage "tcl") -Recurse -Force
robocopy (Join-Path $PythonHome "Lib") (Join-Path $PythonStage "Lib") /E /XD (Join-Path $PythonHome "Lib\site-packages") (Join-Path $PythonHome "Lib\test") (Join-Path $PythonHome "Lib\idlelib") /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PythonStage "Lib\site-packages") -Force | Out-Null

$Site = Join-Path $PythonStage "Lib\site-packages"
$SourceSite = Join-Path $PythonHome "Lib\site-packages"
$packages = @(
    "flask", "jinja2", "werkzeug", "click", "itsdangerous", "blinker", "markupsafe",
    "webview", "pythonnet", "clr_loader", "proxy_tools", "bottle",
    "z3", "serial", "usb", "psutil", "PIL", "cffi", "pycparser",
    "esptool", "esp_pylib", "cryptography", "reedsolo", "intelhex",
    "rich", "rich_click", "mdurl", "markdown_it", "pygments", "colorama"
)
foreach ($package in $packages) {
    $source = Join-Path $SourceSite $package
    if (Test-Path $source) { Copy-Item $source (Join-Path $Site $package) -Recurse -Force }
}
foreach ($file in @("clr.py", "bottle.py", "typing_extensions.py", "_cffi_backend.cp313-win_amd64.pyd")) {
    $source = Join-Path $SourceSite $file
    if (Test-Path $source) { Copy-Item $source (Join-Path $Site $file) -Force }
}

# Copy package metadata needed by packages that query importlib.metadata.
Get-ChildItem $SourceSite -Directory -Filter "*.dist-info" | Where-Object {
    $_.Name -match "^(Flask|Jinja2|Werkzeug|click|itsdangerous|blinker|MarkupSafe|pywebview|pythonnet|clr_loader|proxy_tools|bottle|z3|pyserial|pyusb|psutil|pillow|cffi|pycparser|esptool|esp_pylib|cryptography|reedsolo|intelhex|rich|rich_click|mdurl|markdown-it-py|Pygments|colorama|typing_extensions)"
} | ForEach-Object { Copy-Item $_.FullName (Join-Path $Site $_.Name) -Recurse -Force }

@"
@echo off
cd /d "%~dp0"
start "" "%~dp0python\pythonw.exe" "%~dp0app.py"
"@ | Set-Content -Encoding ascii (Join-Path $Stage "Start-PLA.bat")

@"
Option Explicit
Dim shell, folder
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
shell.Run """" & folder & "\python\pythonw.exe"" """ & folder & "\app.py""", 0, False
"@ | Set-Content -Encoding ascii (Join-Path $Stage "Start-PLA.vbs")

New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
$PortableZip = Join-Path $ReleaseDir "$AppName-$Version-portable.zip"
if (Test-Path $PortableZip) { Remove-Item $PortableZip -Force }
Write-Host "Creating portable ZIP..."
Compress-Archive -Path $Stage -DestinationPath $PortableZip -CompressionLevel Optimal

if (-not $PortableOnly) {
    $IsccCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    )
    $Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $Iscc) { throw "Inno Setup 6 (ISCC.exe) was not found." }
    & $Iscc (Join-Path $BuildDir "installer.iss")
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed." }
}

$hashLines = @()
foreach ($file in Get-ChildItem $ReleaseDir -File | Where-Object { $_.Extension -in @(".zip", ".exe") }) {
    $hash = Get-FileHash $file.FullName -Algorithm SHA256
    $hashLines += "$($hash.Hash.ToLower())  $($file.Name)"
}
$hashLines | Set-Content -Encoding utf8 (Join-Path $ReleaseDir "SHA256SUMS.txt")
Get-ChildItem $ReleaseDir -File | Select-Object Name, Length | Format-Table -AutoSize
