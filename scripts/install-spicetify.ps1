<#
.SYNOPSIS
  Builds this fork of Spicy Lyrics and installs it into Spicetify as its own
  extension, "spicy-lyrics-providers.js".

.DESCRIPTION
  The official Spicy Lyrics install is a tiny loader that pulls its code from a CDN,
  so it updates itself. This fork is a self-contained build under a different file
  name, so upstream updates never touch it. See RUNBOOK.md.

  Steps: bun install -> bun run build -> rename the output -> register it in
  Spicetify -> spicetify apply (restarts Spotify).

.PARAMETER NoApply
  Build and register, but do not run `spicetify apply` (Spotify keeps running).

.PARAMETER SkipInstall
  Skip `bun install` (use when dependencies have not changed).

.PARAMETER Uninstall
  Remove the extension from Spicetify config, delete the file and re-apply.
#>
[CmdletBinding()]
param(
  [switch]$NoApply,
  [switch]$SkipInstall,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$ExtName = 'spicy-lyrics-providers.js'
# What spicetify-creator calls the file it builds (from "name" in spice.config.ts).
$BuiltName = 'spicy-lyrics.js'
$Repo = Split-Path -Parent $PSScriptRoot

function Resolve-Tool([string]$Name, [string[]]$Fallbacks) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($path in $Fallbacks) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  throw "Could not find '$Name'. Install it or add it to PATH (see RUNBOOK.md, Prerequisites)."
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "'$([IO.Path]::GetFileName($Exe)) $($Arguments -join ' ')' failed with exit code $LASTEXITCODE"
  }
}

$spicetify = Resolve-Tool 'spicetify' @("$env:LOCALAPPDATA\spicetify\spicetify.exe")

$userData = (& $spicetify path userdata | Select-Object -First 1).Trim()
if (-not $userData -or -not (Test-Path $userData)) { $userData = Join-Path $env:APPDATA 'spicetify' }
$extDir = Join-Path $userData 'Extensions'
$target = Join-Path $extDir $ExtName

function Set-ExtensionRegistered([string]$Name, [bool]$Registered) {
  # Spicetify: `config extensions X` adds X, `config extensions X-` removes it.
  $arg = if ($Registered) { $Name } else { "$Name-" }
  & $spicetify config extensions $arg | Out-Null
}

if ($Uninstall) {
  Write-Host "Removing $ExtName from Spicetify..."
  Set-ExtensionRegistered $ExtName $false
  if (Test-Path $target) { Remove-Item $target -Force }
  if (-not $NoApply) { Invoke-Native $spicetify @('apply') }
  Write-Host 'Uninstalled.'
  return
}

$bun = Resolve-Tool 'bun' @("$env:USERPROFILE\.bun\bin\bun.exe")

# A running `bun run dev` rewrites the extension folder and registers its own
# live-reload helper; the two would fight over the same files.
$dev = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'run dev' }
if ($dev) {
  throw "A 'bun run dev' watcher is running (PID $($dev.ProcessId -join ', ')). Stop it first."
}

Push-Location $Repo
try {
  if (-not $SkipInstall) {
    Write-Host '==> bun install'
    Invoke-Native $bun @('install')
  }

  Write-Host '==> bun run build'
  $started = Get-Date
  Invoke-Native $bun @('run', 'build')

  # spicetify-creator writes straight into the Spicetify Extensions folder.
  $built = Join-Path $extDir $BuiltName
  if (-not (Test-Path $built) -or (Get-Item $built).LastWriteTime -lt $started) {
    throw "Build finished but $built was not updated. Check the build output above."
  }

  # Give it our own name so it can never collide with an official Spicy Lyrics.
  Move-Item $built $target -Force
  Write-Host "==> Installed $target ($([math]::Round((Get-Item $target).Length / 1KB)) KB)"
}
finally {
  Pop-Location
}

Write-Host '==> Registering in Spicetify'
Set-ExtensionRegistered $ExtName $true
# Leftovers from `bun run dev` / a plain build; this fork loads under its own name.
Set-ExtensionRegistered 'sc-live-reload-helper.js' $false
Set-ExtensionRegistered $BuiltName $false

if ($NoApply) {
  Write-Host 'Done. Run `spicetify apply` when you are ready to load it.'
}
else {
  Write-Host '==> spicetify apply (Spotify will restart)'
  Invoke-Native $spicetify @('apply')
  Write-Host 'Done.'
}
