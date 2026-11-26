param(
    [switch]$PortableOnly,
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root "build"
$DistDir = Join-Path $Root "dist"
$ReleaseDir = Join-Path $Root "release"
$Version = "0.9.5"
$AppName = "PLA-MMO-Seed-Path"

function Find-Python {
    foreach ($candidate in @("py", "python")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try {
            if ($candidate -eq "py") { & py -3 --version *> $null } else { & python --version *> $null }
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch { }
    }
    throw "未找到 Python 3.10+。"
}

function Invoke-Python([string[]]$Arguments) {
    if ($script:PythonCommand -eq "py") {
        & py -3 @Arguments
    } else {
        & python @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Python 命令失败，退出码 $LASTEXITCODE"
    }
}

$script:PythonCommand = Find-Python
Write-Host "使用 Python：$script:PythonCommand"
Write-Host "项目目录：$Root"

if (-not $SkipDeps) {
    Write-Host "检查运行依赖…"
    Invoke-Python @("-m", "pip", "install", "--disable-pip-version-check", "-r", (Join-Path $Root "requirements.txt"))
}
Invoke-Python @("-m", "PyInstaller", "--version")

foreach ($path in @($DistDir, $ReleaseDir)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

Write-Host "编译主程序…"
Invoke-Python @(
    "-m", "PyInstaller", "--noconfirm", "--clean",
    "--distpath", $DistDir,
    "--workpath", (Join-Path $BuildDir ".work"),
    (Join-Path $BuildDir "app.spec")
)

$MainDir = Join-Path $DistDir $AppName
if (-not (Test-Path (Join-Path $MainDir "$AppName.exe"))) {
    throw "主程序编译产物不存在：$MainDir"
}
Copy-Item (Join-Path $Root "启动独立窗口.bat") (Join-Path $MainDir "启动独立窗口.bat") -Force

$HelpersDir = Join-Path $MainDir "helpers"
New-Item -ItemType Directory -Path $HelpersDir -Force | Out-Null
$HelperOut = Join-Path $BuildDir ".helper-dist"

Write-Host "编译 Seed helper…"
Invoke-Python @(
    "-m", "PyInstaller", "--noconfirm", "--clean",
    "--distpath", $HelperOut,
    "--workpath", (Join-Path $BuildDir ".work-seed"),
    (Join-Path $BuildDir "seed_helper.spec")
)
Copy-Item (Join-Path $HelperOut "seed-helper") (Join-Path $HelpersDir "seed-helper") -Recurse -Force

Write-Host "编译 esptool helper…"
Invoke-Python @(
    "-m", "PyInstaller", "--noconfirm", "--clean",
    "--distpath", $HelperOut,
    "--workpath", (Join-Path $BuildDir ".work-esptool"),
    (Join-Path $BuildDir "esptool_helper.spec")
)
Copy-Item (Join-Path $HelperOut "esptool-helper") (Join-Path $HelpersDir "esptool-helper") -Recurse -Force

$PortableZip = Join-Path $ReleaseDir "$AppName-$Version-portable.zip"
if (Test-Path $PortableZip) { Remove-Item $PortableZip -Force }
Write-Host "生成便携 ZIP…"
Compress-Archive -Path $MainDir -DestinationPath $PortableZip -CompressionLevel Optimal

$InstallerPath = $null
if (-not $PortableOnly) {
    $IsccCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    )
    $Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $Iscc) {
        Write-Warning "未找到 Inno Setup 6 (ISCC.exe)。已生成便携 ZIP，安装包未生成。"
        Write-Host "安装后重试：winget install --id JRSoftware.InnoSetup -e --source winget"
    } else {
        Write-Host "生成安装包…"
        & $Iscc (Join-Path $BuildDir "installer.iss")
        if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败，退出码 $LASTEXITCODE" }
        $InstallerPath = Join-Path $ReleaseDir "$AppName-$Version-Setup.exe"
    }
}

$hashLines = @()
foreach ($file in Get-ChildItem $ReleaseDir -File | Where-Object { $_.Extension -in @(".zip", ".exe") }) {
    $hash = Get-FileHash $file.FullName -Algorithm SHA256
    $hashLines += "$($hash.Hash.ToLower())  $($file.Name)"
}
$hashLines | Set-Content -Encoding utf8 (Join-Path $ReleaseDir "SHA256SUMS.txt")

Write-Host ""
Write-Host "构建完成："
Get-ChildItem $ReleaseDir -File | Select-Object Name, Length | Format-Table -AutoSize
