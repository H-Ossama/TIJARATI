[CmdletBinding()]
param(
  [switch]$SetGeminiKey,
  [string]$GeminiApiKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[deploy] $msg" }

$repoRoot = Split-Path -Parent $PSCommandPath
Set-Location -Path $repoRoot

Write-Info "Repo: $repoRoot"

# Sanity checks
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  throw "Firebase CLI not found. Install it with: npm i -g firebase-tools"
}

if (-not (Test-Path -Path (Join-Path $repoRoot 'firebase.json'))) {
  throw "firebase.json not found. Run this script from the repo root."
}

# Ensure we target the intended project
Write-Info "Using Firebase project: tijarati-ec23b"
& firebase use tijarati-ec23b | Out-Host

# Install server dependencies (Functions source)
Write-Info "Installing server dependencies (server/)"
& npm --prefix (Join-Path $repoRoot 'server') install | Out-Host

# Optionally set secret (recommended)
if ($SetGeminiKey) {
  $key = ($GeminiApiKey ?? '').Trim()
  if (-not $key) {
    $key = ($env:GEMINI_API_KEY ?? '').Trim()
  }

  if (-not $key) {
    $secure = Read-Host -Prompt 'Enter GEMINI_API_KEY (input hidden)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }

  if (-not $key) {
    throw "GEMINI_API_KEY was empty. Provide -GeminiApiKey, set env:GEMINI_API_KEY, or enter it when prompted."
  }

  Write-Info "Setting Firebase Functions secret GEMINI_API_KEY"
  $tmp = New-TemporaryFile
  try {
    Set-Content -Path $tmp.FullName -Value $key -NoNewline -Encoding utf8
    & firebase functions:secrets:set GEMINI_API_KEY --data-file $tmp.FullName | Out-Host
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp.FullName
  }
}

# Deploy
Write-Info "Deploying Hosting + Functions"
& firebase deploy --only functions,hosting | Out-Host

Write-Info "Done. Base URL: https://tijarati-ec23b.web.app"
Write-Info "Set EAS env: TIJARATI_AI_SERVER_URL=https://tijarati-ec23b.web.app"
