param(
    [string]$CredentialPath = "D:\Private\NexusLocalCurator\amo-signing.credential.xml"
)

$ErrorActionPreference = "Stop"
$issuer = (Read-Host "AMO API key (JWT issuer)").Trim()
$secret = Read-Host "AMO API secret (hidden)" -AsSecureString
if (-not $issuer) {
    throw "The AMO API key cannot be empty."
}

$credentialDirectory = Split-Path -Parent $CredentialPath
New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
[PSCredential]::new($issuer, $secret) | Export-Clixml -LiteralPath $CredentialPath

$userGrant = "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F"
& icacls.exe $credentialDirectory /inheritance:r /grant:r $userGrant "SYSTEM:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "The credential was encrypted, but its directory permissions could not be restricted."
}

Write-Host "DPAPI-encrypted credential saved for this Windows account at:"
Write-Host $CredentialPath
