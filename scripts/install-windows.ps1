#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot Windows installer for the Loom coding agent.

.DESCRIPTION
    Automates the flow validated by hand on a fresh Windows 11 box:
      1. Verify git and bun are installed (with install hints if not).
      2. Run `bun install`, retrying up to 3 times to ride out the transient
         "Integrity check failed for tarball: chart.js" CDN flake.
      3. Ensure a Rust toolchain: if `cargo` is missing, bootstrap rustup via
         rustup-init.exe. The filename matters - the https://win.rustup.rs proxy
         rejects the `-y` flag unless the downloaded file is named
         rustup-init.exe. With -SkipRust, the native build instead downloads the
         published prebuilt addon from npm (no Rust required).
      4. Build the native addon, then the compiled `loom` binary.

.PARAMETER SkipRust
    Do not install Rust. The native addon is fetched as a published prebuilt
    (`@oh-my-pi/pi-natives-win32-x64`) instead of compiled from source.

.PARAMETER GnuToolchain
    When installing Rust, use the x86_64-pc-windows-gnu toolchain instead of the
    default msvc toolchain, avoiding the multi-GB Visual Studio Build Tools /
    MSVC linker requirement.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

.EXAMPLE
    # No Rust toolchain - use the published prebuilt native addon
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -SkipRust
#>
[CmdletBinding()]
param(
    [switch]$SkipRust,
    [switch]$GnuToolchain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Resolve the repo root as the parent of this script's directory so the script
# works regardless of the caller's current directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
Write-Step "Loom Windows installer (repo: $RepoRoot)"

# --- 1. Prerequisites -------------------------------------------------------
Write-Step "Checking prerequisites (git, bun)"

if (-not (Test-Command git)) {
    throw "git was not found on PATH. Install Git for Windows from https://git-scm.com/download/win and reopen the shell."
}
Write-Ok "git: $((git --version) 2>&1)"

if (-not (Test-Command bun)) {
    throw @"
bun was not found on PATH. Install it with:
    powershell -c "irm bun.sh/install.ps1 | iex"
then reopen the shell and re-run this script.
"@
}
Write-Ok "bun: $((bun --version) 2>&1)"

# --- 2. bun install with retries -------------------------------------------
# `bun install` intermittently fails with
#   error: Integrity check failed for tarball: chart.js
# which is a transient CDN hiccup; a plain retry clears it.
Write-Step "Installing dependencies (bun install, up to 3 attempts)"
$maxAttempts = 3
$installed = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Write-Host "    attempt $attempt of $maxAttempts..."
    & bun install
    if ($LASTEXITCODE -eq 0) {
        $installed = $true
        break
    }
    Write-Warn "bun install failed (exit $LASTEXITCODE)."
    if ($attempt -lt $maxAttempts) {
        Write-Warn "Retrying in 3s (transient chart.js integrity flake clears on retry)..."
        Start-Sleep -Seconds 3
    }
}
if (-not $installed) {
    throw "bun install failed after $maxAttempts attempts. Re-run the script or run 'bun install' manually."
}
Write-Ok "Dependencies installed."

# --- 3. Rust toolchain (or prebuilt fallback) ------------------------------
$haveCargo = Test-Command cargo

if ($haveCargo) {
    Write-Step "Rust toolchain present"
    Write-Ok "cargo: $((cargo --version) 2>&1)"
}
elseif ($SkipRust) {
    Write-Step "Skipping Rust install (-SkipRust)"
    Write-Warn "The native addon will be downloaded as a published prebuilt instead of compiled."
}
else {
    Write-Step "cargo not found - bootstrapping Rust via rustup"
    $rustupInit = Join-Path $env:TEMP 'rustup-init.exe'
    # CRITICAL: the win.rustup.rs proxy only honors the non-interactive `-y`
    # flag when the downloaded binary is literally named rustup-init.exe.
    # Naming it rustup.exe makes it reject `-y` and drop into an interactive
    # prompt, so we always save to rustup-init.exe.
    Write-Host "    downloading rustup-init.exe..."
    Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $rustupInit -UseBasicParsing

    $rustupArgs = @('-y', '--no-modify-path')
    if ($GnuToolchain) {
        # GNU toolchain avoids the MSVC linker / VS Build Tools requirement.
        $rustupArgs += @('--default-host', 'x86_64-pc-windows-gnu', '--default-toolchain', 'stable-x86_64-pc-windows-gnu')
        Write-Warn "Installing the GNU toolchain (x86_64-pc-windows-gnu) - avoids the MSVC linker,"
        Write-Warn "but still needs MinGW-w64 gcc on PATH to compile the pcre2/tree-sitter C sources."
    }
    else {
        Write-Warn "Installing the default MSVC toolchain. This needs the MSVC linker (VS Build Tools,"
        Write-Warn "'Desktop development with C++'). If linking fails later, re-run with -GnuToolchain."
    }

    & $rustupInit @rustupArgs
    if ($LASTEXITCODE -ne 0) {
        throw "rustup-init.exe failed (exit $LASTEXITCODE)."
    }

    # Make cargo available in THIS session without reopening the shell.
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path $cargoBin) {
        $env:Path = "$cargoBin;$env:Path"
    }
    if (-not (Test-Command cargo)) {
        throw "cargo still not found after rustup install. Reopen the shell and re-run, or pass -SkipRust."
    }
    Write-Ok "cargo: $((cargo --version) 2>&1)"
    $haveCargo = $true
}

# --- 4. Build the native addon ---------------------------------------------
if ($haveCargo) {
    Write-Step "Building native addon from source (bun --cwd=packages/natives run build)"
    & bun --cwd=packages/natives run build
    if ($LASTEXITCODE -ne 0) { throw "Native addon build failed (exit $LASTEXITCODE)." }
}
else {
    Write-Step "Fetching prebuilt native addon (bun --cwd=packages/natives run gen:native:prebuilt)"
    & bun --cwd=packages/natives run gen:native:prebuilt
    if ($LASTEXITCODE -ne 0) { throw "Prebuilt native fetch failed (exit $LASTEXITCODE)." }
}
Write-Ok "Native addon ready."

# --- 5. Build the compiled binary ------------------------------------------
Write-Step "Building the loom binary (cd packages/coding-agent; bun run build)"
Push-Location (Join-Path $RepoRoot 'packages\coding-agent')
try {
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "Binary build failed (exit $LASTEXITCODE)." }
}
finally {
    Pop-Location
}

# --- Done -------------------------------------------------------------------
$distDir = Join-Path $RepoRoot 'packages\coding-agent\dist'
$binary = @('loom.exe', 'loom') |
    ForEach-Object { Join-Path $distDir $_ } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

Write-Step "Done"
if ($binary) {
    Write-Ok "Built binary: $binary"
    Write-Host ""
    Write-Host "Try it:" -ForegroundColor Cyan
    Write-Host "    & '$binary' --version"
    Write-Host "Add its directory to PATH to run 'loom' from any project."
}
else {
    Write-Warn "Build finished but no binary was found under $distDir. Inspect the build output above."
}
