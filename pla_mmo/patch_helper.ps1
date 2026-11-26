$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $env:TEMP
$target = __TARGET__
$archive = __ARCHIVE__
$baseVersion = __BASE_VERSION__
$targetVersion = __TARGET_VERSION__
$log = __LOG__
$appPid = __APP_PID__

function Write-Log([string]$message) {
    try {
        Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -Encoding utf8
    } catch {}
}

$staging = Join-Path $env:TEMP ('pla-patch-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $env:TEMP ('pla-patch-backup-' + [guid]::NewGuid().ToString('N'))
$added = New-Object System.Collections.ArrayList
$replaced = New-Object System.Collections.ArrayList

function Get-TargetPath([string]$relative) {
    $full = [IO.Path]::GetFullPath((Join-Path $target $relative))
    $prefix = [IO.Path]::GetFullPath($target).TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('unsafe target path: ' + $relative)
    }
    return $full
}

function Restore-Files {
    foreach ($relative in $added) {
        $path = Get-TargetPath ([string]$relative)
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    foreach ($relative in $replaced) {
        $path = Get-TargetPath ([string]$relative)
        $saved = Join-Path $backup ([string]$relative)
        if (Test-Path -LiteralPath $saved) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
            Copy-Item -LiteralPath $saved -Destination $path -Force
        }
    }
}

function Start-Application {
    $pythonw = Join-Path $target 'python\pythonw.exe'
    if (Test-Path -LiteralPath $pythonw) {
        Start-Process -FilePath $pythonw -ArgumentList ('"' + $target + '\app.py"') -WorkingDirectory $target
    }
}

try {
    Write-Log 'waiting for the application to exit before applying the patch'
    Wait-Process -Id $appPid -Timeout 60 -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 900

    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
    $infoPath = Join-Path $staging 'patch.json'
    if (-not (Test-Path -LiteralPath $infoPath)) { throw 'patch.json is missing' }
    $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$info.base_version -ne $baseVersion) {
        throw ('patch base version mismatch: ' + [string]$info.base_version)
    }
    if ($targetVersion -and ([string]$info.version -ne $targetVersion)) {
        throw ('patch target version mismatch: ' + [string]$info.version)
    }

    foreach ($item in @($info.files)) {
        $relative = [string]$item.path
        $action = [string]$item.action
        if (-not $relative -or $relative.Contains('..') -or [IO.Path]::IsPathRooted($relative)) {
            throw ('unsafe patch path: ' + $relative)
        }
        $destination = Get-TargetPath $relative
        $expected = ([string]$item.sha256).ToLowerInvariant()
        $sourceHash = ([string]$item.source_sha256).ToLowerInvariant()

        if ($action -eq 'delete') {
            if (Test-Path -LiteralPath $destination) {
                $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($sourceHash -and $current -ne $sourceHash) {
                    throw ('base file changed, refusing to delete: ' + $relative)
                }
                $saved = Join-Path $backup $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
                Copy-Item -LiteralPath $destination -Destination $saved -Force
                [void]$replaced.Add($relative)
                Remove-Item -LiteralPath $destination -Force
            }
            continue
        }

        $source = Join-Path $staging $relative
        if (-not (Test-Path -LiteralPath $source)) {
            throw ('patch file is missing: ' + $relative)
        }
        $sourceActual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -and $sourceActual -ne $expected) {
            throw ('patch file hash mismatch: ' + $relative)
        }

        if (Test-Path -LiteralPath $destination) {
            $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($sourceHash) {
                if ($current -ne $sourceHash) {
                    throw ('base file changed, refusing to replace: ' + $relative)
                }
                $saved = Join-Path $backup $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
                Copy-Item -LiteralPath $destination -Destination $saved -Force
                [void]$replaced.Add($relative)
            } elseif ($expected -and $current -eq $expected) {
                continue
            } else {
                throw ('file already exists with different content: ' + $relative)
            }
        } elseif ($sourceHash) {
            throw ('base file is missing: ' + $relative)
        } else {
            [void]$added.Add($relative)
        }

        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
        Write-Log ('patched ' + $relative)
    }

    Start-Application
    Write-Log ('patch update installed and restarted (v' + $targetVersion + ')')
    Start-Sleep -Seconds 5
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    Write-Log ('ERROR: ' + $_.Exception.Message)
    try { Restore-Files } catch { Write-Log ('restore failed: ' + $_.Exception.Message) }
    try { Start-Application } catch { Write-Log ('restart failed: ' + $_.Exception.Message) }
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
