<#
.SYNOPSIS
  Pulls the latest Spicy Lyrics changes from upstream into this fork, then
  rebuilds and reinstalls it into Spicetify.

.DESCRIPTION
  Fetches `upstream` (Spikerko/spicy-lyrics), merges upstream/<Branch> into the
  current branch, and runs install-spicetify.ps1. Stops without installing if the
  merge conflicts. Does not push anything. See RUNBOOK.md.

.PARAMETER Branch
  Upstream branch to merge. Default: main.

.PARAMETER Force
  Rebuild and reinstall even when there is nothing new upstream.

.PARAMETER NoInstall
  Merge only; skip the build and install.

.PARAMETER NoApply
  Passed to install-spicetify.ps1: skip `spicetify apply`.
#>
[CmdletBinding()]
param(
  [string]$Branch = 'main',
  [switch]$Force,
  [switch]$NoInstall,
  [switch]$NoApply
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot

function Resolve-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $desktop = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\cmd\git.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($desktop) { return $desktop.FullName }
  throw "Could not find git. Install it or add it to PATH (see RUNBOOK.md, Prerequisites)."
}

$git = Resolve-Git

function Invoke-Git([string[]]$Arguments) {
  & $git -C $Repo @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE"
  }
}

function Get-GitOutput([string[]]$Arguments) {
  $out = & $git -C $Repo @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE"
  }
  return $out
}

if (-not (Get-GitOutput @('remote') | Where-Object { $_ -eq 'upstream' })) {
  throw "No 'upstream' remote. Add it: git remote add upstream https://github.com/Spikerko/spicy-lyrics.git"
}

if (Get-GitOutput @('status', '--porcelain')) {
  throw 'The working tree has uncommitted changes. Commit or stash them first, then rerun.'
}

Write-Host "==> Fetching upstream/$Branch"
Invoke-Git @('fetch', 'upstream', $Branch)

$behind = [int](Get-GitOutput @('rev-list', '--count', "HEAD..upstream/$Branch") | Select-Object -First 1)

if ($behind -eq 0 -and -not $Force) {
  Write-Host 'Already up to date with upstream. Use -Force to rebuild and reinstall anyway.'
  return
}

if ($behind -gt 0) {
  Write-Host "==> Merging $behind upstream commit(s)"
  & $git -C $Repo merge "upstream/$Branch" -m "Merge upstream/$Branch into fork"
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Merge stopped with conflicts. Nothing was built or installed.' -ForegroundColor Yellow
    Write-Host 'Conflicted files:'
    Get-GitOutput @('diff', '--name-only', '--diff-filter=U') | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
    Write-Host 'Either resolve them, `git commit`, then rerun this script with -Force,'
    Write-Host 'or back out with:  git merge --abort'
    exit 1
  }
}

if ($NoInstall) {
  Write-Host 'Merged. Skipping install (-NoInstall).'
  return
}

$install = Join-Path $PSScriptRoot 'install-spicetify.ps1'
if ($NoApply) { & $install -NoApply } else { & $install }
