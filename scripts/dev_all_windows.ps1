#Requires -Version 5.1
<#
.SYNOPSIS
    Windows parallel to dev_all.sh - starts all SAW services.
.PARAMETER FrontendPort
    Port for Vite frontend (default: 5173)
.PARAMETER ApiPort
    Port for SAW API (default: 5127)
.EXAMPLE
    .\scripts\dev_all.ps1 -FrontendPort 7176 -ApiPort 5127
#>
param(
    [int]$FrontendPort = 5173,
    [int]$ApiPort = 5127
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

$ApiHost = "127.0.0.1"
$PatchEngineHost = "127.0.0.1"
$PatchEnginePort = 5128

$env:SAW_ENABLE_DB = "1"
$env:SAW_ENABLE_PLUGINS = "1"
$env:SAW_API_URL = "http://${ApiHost}:${ApiPort}"
$env:SAW_PATCH_ENGINE_URL = "http://${PatchEngineHost}:${PatchEnginePort}"
$env:SAW_REPO_ROOT = $RootDir
$env:SAW_PATCH_APPLY_ALLOWLIST = "."

# Dev default: make semantic vector lookups auto-run without approval prompts.
# Override by setting SAW_AUTO_APPROVE_VECTOR_SEARCH=0 if you want approval gating.
if (-not $env:SAW_AUTO_APPROVE_VECTOR_SEARCH) {
    $env:SAW_AUTO_APPROVE_VECTOR_SEARCH = "1"
}

$jobs = @()

function Cleanup {
    Write-Host "`n[dev_all] stopping..." -ForegroundColor Yellow
    foreach ($job in $script:jobs) {
        if ($job -and $job.State -eq 'Running') {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
    # Kill any child processes we spawned
    Get-Process -Name "node", "python" -ErrorAction SilentlyContinue | 
        Where-Object { $_.StartTime -gt $script:startTime } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

$startTime = Get-Date

Write-Host "[dev_all] root: $RootDir" -ForegroundColor Cyan

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "[dev_all] ERROR: uv not found on PATH." -ForegroundColor Red
    Write-Host "[dev_all] Install uv (PowerShell): irm https://astral.sh/uv/install.ps1 | iex" -ForegroundColor Red
    exit 127
}

# Start Docker if available
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "[dev_all] starting postgres (docker compose up -d)..." -ForegroundColor Cyan
    try {
        $dockerOutput = docker compose up -d 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[dev_all] docker compose failed (is Docker Desktop running?); skipping postgres" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[dev_all] docker not available; skipping postgres startup" -ForegroundColor Yellow
    }
} else {
    Write-Host "[dev_all] docker not found; skipping postgres startup" -ForegroundColor Yellow
}

# Create venv if needed
if (-not (Test-Path ".venv")) {
    Write-Host "[dev_all] creating .venv..." -ForegroundColor Cyan
    uv venv .venv
}

# Activate venv
$venvActivate = Join-Path $RootDir ".venv\Scripts\Activate.ps1"
. $venvActivate

# Install Python deps
Write-Host "[dev_all] installing SAW API deps..." -ForegroundColor Cyan
uv pip install -r services/saw_api/requirements.txt

Write-Host "[dev_all] installing Patch Engine deps..." -ForegroundColor Cyan
uv pip install -r services/patch_engine/requirements.txt

# Start SAW API
Write-Host "[dev_all] starting SAW API on ${ApiHost}:${ApiPort} ..." -ForegroundColor Cyan
$apiJob = Start-Job -ScriptBlock {
    param($root, $host_, $port)
    Set-Location $root
    . "$root\.venv\Scripts\Activate.ps1"
    python -m uvicorn services.saw_api.app.main:app --host $host_ --port $port --reload --reload-dir "services/saw_api"
} -ArgumentList $RootDir, $ApiHost, $ApiPort
$jobs += $apiJob

# Wait for SAW API health
Write-Host "[dev_all] waiting for SAW API /health ..." -ForegroundColor Cyan
$apiReady = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://${ApiHost}:${ApiPort}/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-Host "[dev_all] SAW API ok" -ForegroundColor Green
            $apiReady = $true
            break
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $apiReady) {
    Write-Host "[dev_all] SAW API did not respond in time" -ForegroundColor Yellow
}

# Start Patch Engine
Write-Host "[dev_all] starting Patch Engine on ${PatchEngineHost}:${PatchEnginePort} ..." -ForegroundColor Cyan
$patchJob = Start-Job -ScriptBlock {
    param($root, $host_, $port)
    Set-Location $root
    . "$root\.venv\Scripts\Activate.ps1"
    python -m uvicorn services.patch_engine.app.main:app --host $host_ --port $port --reload --reload-dir "services/patch_engine"
} -ArgumentList $RootDir, $PatchEngineHost, $PatchEnginePort
$jobs += $patchJob

# Wait for Patch Engine health
Write-Host "[dev_all] waiting for Patch Engine /health ..." -ForegroundColor Cyan
$patchReady = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://${PatchEngineHost}:${PatchEnginePort}/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-Host "[dev_all] Patch Engine ok" -ForegroundColor Green
            $patchReady = $true
            break
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $patchReady) {
    Write-Host "[dev_all] Patch Engine did not respond in time" -ForegroundColor Yellow
}

# Check for Node.js/npm, install if missing
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[dev_all] npm not found, installing Node.js via winget..." -ForegroundColor Cyan
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        Write-Host "[dev_all] ERROR: npm not found and winget unavailable." -ForegroundColor Red
        Write-Host "         Install Node.js from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
}

# Install npm deps if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "[dev_all] node_modules missing; running npm install..." -ForegroundColor Cyan
    npm install
}

# Start frontend
Write-Host "[dev_all] starting frontend (vite) on port ${FrontendPort} ..." -ForegroundColor Cyan
$viteJob = Start-Job -ScriptBlock {
    param($root, $port)
    Set-Location $root
    npm run dev -- --port $port --strictPort
} -ArgumentList $RootDir, $FrontendPort
$jobs += $viteJob

Write-Host ""
Write-Host "[dev_all] running:" -ForegroundColor Green
Write-Host "  - SAW API:   http://${ApiHost}:${ApiPort}" -ForegroundColor White
Write-Host "  - Patch Eng: http://${PatchEngineHost}:${PatchEnginePort}" -ForegroundColor White
Write-Host "  - Frontend:  http://127.0.0.1:${FrontendPort}" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

# Register cleanup on exit
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Cleanup } | Out-Null

try {
    # Stream output from all jobs
    while ($true) {
        foreach ($job in $jobs) {
            Receive-Job -Job $job -ErrorAction SilentlyContinue
        }
        
        # Check if any job failed
        $failed = $jobs | Where-Object { $_.State -eq 'Failed' }
        if ($failed) {
            Write-Host "[dev_all] A service failed!" -ForegroundColor Red
            foreach ($f in $failed) {
                Receive-Job -Job $f -ErrorAction SilentlyContinue
            }
            break
        }
        
        Start-Sleep -Milliseconds 500
    }
} finally {
    Cleanup
}

