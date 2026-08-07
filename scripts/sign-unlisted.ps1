$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$webExt = Join-Path $projectRoot "node_modules\.bin\web-ext.cmd"
$sourceDir = Join-Path $projectRoot "extension"
$artifactsDir = Join-Path $projectRoot "web-ext-artifacts"

if (-not (Test-Path -LiteralPath $webExt)) {
    throw "web-ext is not installed. Run npm install in $projectRoot first."
}

$issuer = (Read-Host "AMO API key (JWT issuer)").Trim()
$secretSecure = Read-Host "AMO API secret (hidden)" -AsSecureString
if (-not $issuer) {
    throw "The AMO API key cannot be empty."
}

$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)
try {
    $env:WEB_EXT_API_KEY = $issuer
    $env:WEB_EXT_API_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    & $webExt sign `
        --source-dir $sourceDir `
        --artifacts-dir $artifactsDir `
        --channel unlisted
    if ($LASTEXITCODE -ne 0) {
        throw "Mozilla signing failed with exit code $LASTEXITCODE."
    }
} finally {
    Remove-Item Env:WEB_EXT_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    $secretSecure = $null
}

Write-Host ""
Write-Host "Signing was accepted. Install the signed .xpi from:"
Write-Host $artifactsDir
