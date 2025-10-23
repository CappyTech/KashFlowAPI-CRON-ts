# Requires: PowerShell 5+
# Purpose: Authenticate to KashFlow API and fetch /nominals to sanity-check connectivity and payload shape.
# Reads credentials from environment variables:
#   KASHFLOW_USERNAME, KASHFLOW_PASSWORD, KASHFLOW_MEMORABLE_WORD
# Optional: KASHFLOW_BASE_URL (defaults to https://api.kashflow.com/v2)
#
# .env support: Place a .env file next to this script (scripts/.env) with lines like:
#   KASHFLOW_USERNAME=your-user
#   KASHFLOW_PASSWORD=your-pass
#   KASHFLOW_MEMORABLE_WORD=your-memorable
#   KASHFLOW_BASE_URL=https://api.kashflow.com/v2
# Or provide -EnvFile to point to a custom env file.

param(
  [string]$EnvFile,
  [string]$Username = $env:KASHFLOW_USERNAME,
  [string]$Password = $env:KASHFLOW_PASSWORD,
  [string]$MemorableWord = $env:KASHFLOW_MEMORABLE_WORD,
  [string]$BaseUrl = $(if ($env:KASHFLOW_BASE_URL) { $env:KASHFLOW_BASE_URL } else { 'https://api.kashflow.com/v2' }),
  [int]$Page = 1,
  [int]$PerPage = 100
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Load-EnvFile {
  param([Parameter(Mandatory=$true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Write-Host "[env] Loading $Path" -ForegroundColor Gray
  $lines = Get-Content -LiteralPath $Path -ErrorAction Stop
  foreach ($ln in $lines) {
    if (-not $ln) { continue }
    $line = $ln.Trim()
    if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2) { continue }
    $k = $parts[0].Trim()
    $v = $parts[1].Trim()
    # Strip surrounding quotes if present
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length-2)
    }
    # Set process-scoped environment variable
    Set-Item -Path "Env:$k" -Value $v -ErrorAction SilentlyContinue
  }
}

# Load .env from alongside the script unless a custom file is provided
try {
  if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $defaultA = Join-Path $PSScriptRoot '.env'
    $defaultB = Join-Path $PSScriptRoot 'test-nominals.env'
    if (Test-Path -LiteralPath $defaultA) { $EnvFile = $defaultA }
    elseif (Test-Path -LiteralPath $defaultB) { $EnvFile = $defaultB }
  }
  if ($EnvFile) { Load-EnvFile -Path $EnvFile }
} catch { Write-Host "[env] Failed to load env file: $($_.Exception.Message)" -ForegroundColor Yellow }

# Re-resolve parameters from env if not supplied explicitly
if (-not $Username) { $Username = $env:KASHFLOW_USERNAME }
if (-not $Password) { $Password = $env:KASHFLOW_PASSWORD }
if (-not $MemorableWord) { $MemorableWord = $env:KASHFLOW_MEMORABLE_WORD }
if (-not $BaseUrl) { $BaseUrl = ($env:KASHFLOW_BASE_URL | ForEach-Object { if ($_) { $_ } else { 'https://api.kashflow.com/v2' } }) }

function Get-SessionToken {
  param(
    [Parameter(Mandatory=$true)][string]$BaseUrl,
    [Parameter(Mandatory=$true)][string]$Username,
    [Parameter(Mandatory=$true)][string]$Password,
    [Parameter(Mandatory=$true)][string]$MemorableWord
  )
  Write-Host "[auth] POST $BaseUrl/sessiontoken" -ForegroundColor Cyan
  $postBody = @{ username = $Username; password = $Password } | ConvertTo-Json -Depth 5
  $post = Invoke-RestMethod -Method Post -Uri "$BaseUrl/sessiontoken" -ContentType 'application/json' -Body $postBody
  $temp = $post.TemporaryToken
  if (-not $temp) { throw "No TemporaryToken returned" }
  $rawList = $post.MemorableWordList
  if (-not $rawList) { throw "No MemorableWordList positions returned" }
  $positions = @()
  foreach ($x in $rawList) {
    if ($x -is [int] -or $x -is [long] -or $x -is [double]) { $positions += [int]$x; continue }
    if ($null -ne $x.Position) { $positions += [int]$x.Position; continue }
    if ($null -ne $x.pos) { $positions += [int]$x.pos; continue }
  }
  if ($positions.Count -eq 0) { throw "Could not parse MemorableWordList positions" }
  $letters = @()
  foreach ($pos in $positions) {
    if ($pos -lt 1 -or $pos -gt $MemorableWord.Length) { throw "MemorableWord position out of range: $pos (length $($MemorableWord.Length))" }
    $letters += @{ Position = $pos; Value = $MemorableWord.Substring($pos-1,1) }
  }
  Write-Host "[auth] PUT $BaseUrl/sessiontoken (positions: $($positions -join ', '))" -ForegroundColor Cyan
  $putBody = @{ TemporaryToken = $temp; MemorableWordList = $letters } | ConvertTo-Json -Depth 5
  $put = Invoke-RestMethod -Method Put -Uri "$BaseUrl/sessiontoken" -ContentType 'application/json' -Body $putBody
  $sess = $put.SessionToken
  if (-not $sess) { throw "No SessionToken returned" }
  return $sess
}

if (-not $Username -or -not $Password -or -not $MemorableWord) {
  Write-Host "Missing KASHFLOW credentials. Please set environment variables:" -ForegroundColor Yellow
  Write-Host "  KASHFLOW_USERNAME, KASHFLOW_PASSWORD, KASHFLOW_MEMORABLE_WORD" -ForegroundColor Yellow
  exit 1
}

Write-Host "BaseUrl: $BaseUrl" -ForegroundColor Gray
$token = Get-SessionToken -BaseUrl $BaseUrl -Username $Username -Password $Password -MemorableWord $MemorableWord
Write-Host "[auth] OK" -ForegroundColor Green

# Fetch nominals
$headers = @{ Authorization = "KfToken $token" }
$uri = "$BaseUrl/nominals?page=$Page&perpage=$PerPage"
Write-Host "[GET] $uri" -ForegroundColor Cyan
try {
  $resp = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  throw
}

# Normalize list shape
if ($resp -is [System.Collections.IEnumerable] -and -not ($resp.PSObject.Properties.Name -contains 'Data')) {
  $items = @($resp)
  $total = $items.Count
} else {
  $items = @($resp.Data)
  $total = if ($resp.MetaData -and $resp.MetaData.TotalRecords) { [int]$resp.MetaData.TotalRecords } else { $items.Count }
}

Write-Host ("Nominals: count={0}, total={1}" -f $items.Count, $total) -ForegroundColor Green
$preview = $items | Select-Object -First 5 | ForEach-Object { "Id=$($_.Id) Code=$($_.Code) Name=$($_.Name) Type=$($_.Type)" }
$preview | ForEach-Object { Write-Host "  $_" }

# Exit success
exit 0
