# Job Agent installer (Windows). Run via install.cmd. Installs Node.js LTS if missing, the packages, then the setup wizard.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "Job Agent installer" -ForegroundColor Cyan
if (-not (Test-Path 'config\search-config.yaml') -or -not (Test-Path 'drizzle')) {
  Write-Host "This folder is not a complete Job Agent copy (config\ or drizzle\ missing)." -ForegroundColor Red
  Write-Host "Update zips go over an existing job-agent folder. For a new install use the full release zip or git clone." -ForegroundColor Yellow
  exit 1
}

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  return [int]((& node -p "process.versions.node.split('.')[0]").Trim())
}

if ((Get-NodeMajor) -lt 22) {
  Write-Host "Node.js 22+ not found. Installing Node.js LTS with winget..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is not available. Install Node.js LTS from https://nodejs.org, then run install.cmd again." -ForegroundColor Yellow
    exit 1
  }
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  # Pick up the new PATH without reopening the window
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((Get-NodeMajor) -lt 22) {
    Write-Host "Node.js was installed but is not on PATH yet. Close this window and run install.cmd again." -ForegroundColor Yellow
    exit 1
  }
}
Write-Host ("Node.js " + (& node --version) + " OK") -ForegroundColor Green

Write-Host "Installing packages (first time takes a few minutes)..."
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci failed (see above)." -ForegroundColor Red; exit 1 }

& npm run setup
exit $LASTEXITCODE
