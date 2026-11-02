$ErrorActionPreference = 'Stop'

$repository = 'tarifasilva999-cpu/AtlasChat-Tauri'
$releaseApi = "https://api.github.com/repos/$repository/releases/latest"
$headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'AtlasChat-CLI-Installer' }
$release = Invoke-RestMethod -Uri $releaseApi -Headers $headers
$asset = @($release.assets | Where-Object { $_.name -eq 'atlas-cli-win-x64.zip' } | Select-Object -First 1)
if (-not $asset) { throw 'The latest AtlasChat release does not include the Windows CLI package yet.' }

$version = [string]$release.tag_name -replace '^v', ''
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') { throw 'The latest AtlasChat release has an invalid version tag.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; run this installer from a Windows user account.' }

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("atlas-cli-" + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $env:LOCALAPPDATA 'AtlasChatCLI'
$versionsRoot = Join-Path $installRoot 'versions'
$versionRoot = Join-Path $versionsRoot $version
$binRoot = Join-Path $installRoot 'bin'
$zipPath = Join-Path $temporaryRoot 'atlas-cli.zip'
$unpackRoot = Join-Path $temporaryRoot 'unpacked'

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    Invoke-WebRequest -Uri $asset[0].browser_download_url -Headers @{ 'User-Agent' = 'AtlasChat-CLI-Installer' } -UseBasicParsing -OutFile $zipPath

    if ($asset[0].digest -match '^sha256:([0-9a-fA-F]{64})$') {
        $expectedDigest = $Matches[1]
        $actualDigest = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
        if ($actualDigest -ne $expectedDigest) { throw 'The CLI archive checksum does not match the GitHub release metadata.' }
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $unpackRoot -Force
    $manifest = Get-Content -LiteralPath (Join-Path $unpackRoot 'version.json') -Raw | ConvertFrom-Json
    if ($manifest.version -ne $version -or $manifest.platform -ne 'win32-x64') { throw 'The downloaded CLI package does not match this release.' }

    New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $versionRoot)) {
        $stagedVersion = Join-Path $versionsRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $stagedVersion -Force | Out-Null
            Copy-Item -Path (Join-Path $unpackRoot '*') -Destination $stagedVersion -Recurse -Force
            try { Move-Item -LiteralPath $stagedVersion -Destination $versionRoot }
            catch { if (-not (Test-Path -LiteralPath $versionRoot)) { throw } }
        }
        finally { Remove-Item -LiteralPath $stagedVersion -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $versionRoot 'node\node.exe'))) { throw 'The installed CLI package is incomplete.' }

    New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
    $currentTemp = Join-Path $installRoot 'current-version.tmp'
    [System.IO.File]::WriteAllText($currentTemp, $version + [Environment]::NewLine, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $currentTemp -Destination (Join-Path $installRoot 'current-version.txt') -Force

    $launcher = @'
@echo off
setlocal
set "ATLAS_HOME=%LOCALAPPDATA%\AtlasChatCLI"
set /p ATLAS_VERSION=<"%ATLAS_HOME%\current-version.txt"
if not defined ATLAS_VERSION (
  echo Atlas CLI is not installed correctly. Run the installer command again.
  exit /b 1
)
set "ATLAS_RELEASE=%ATLAS_HOME%\versions\%ATLAS_VERSION%"
if not exist "%ATLAS_RELEASE%\node\node.exe" (
  echo Atlas CLI files are missing. Run the installer command again.
  exit /b 1
)
"%ATLAS_RELEASE%\node\node.exe" "%ATLAS_RELEASE%\desktop\cli.cjs" %*
exit /b %ERRORLEVEL%
'@
    [System.IO.File]::WriteAllText((Join-Path $binRoot 'atlas.cmd'), $launcher, [System.Text.Encoding]::ASCII)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $binRoot.TrimEnd('\') })) {
        $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binRoot } else { "$userPath;$binRoot" }
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    $processEntries = @($env:Path -split ';' | Where-Object { $_ })
    if (-not ($processEntries | Where-Object { $_.TrimEnd('\') -ieq $binRoot.TrimEnd('\') })) {
        $env:Path = "$binRoot;$env:Path"
    }

    if (-not ('AtlasCliEnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AtlasCliEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
    public static void Broadcast() {
        UIntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 0x0002, 5000, out result);
    }
}
"@
    }
    [AtlasCliEnvironmentBroadcast]::Broadcast()

    $previous = @(Get-ChildItem -LiteralPath $versionsRoot -Directory | Where-Object { $_.Name -ne $version -and $_.Name -match '^\d+\.\d+\.\d+(?:-[\w.-]+)?$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    $keep = @($version) + @($previous | ForEach-Object { $_.Name })
    Get-ChildItem -LiteralPath $versionsRoot -Directory | Where-Object { $_.Name -notin $keep -and $_.Name -match '^\d+\.\d+\.\d+(?:-[\w.-]+)?$' } | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Atlas CLI $version is ready. Open a new terminal and type atlas." -ForegroundColor Cyan
    Write-Host 'In this PowerShell window, you can type atlas now.' -ForegroundColor DarkGray
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
