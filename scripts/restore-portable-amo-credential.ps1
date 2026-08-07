param(
    [string]$PortablePath = "D:\Backups\NexusLocalCurator\amo-signing.portable.json",
    [string]$CredentialPath = "D:\Private\NexusLocalCurator\amo-signing.credential.xml"
)

$ErrorActionPreference = "Stop"

function Read-PlainText([Security.SecureString]$SecureValue) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Join-Bytes([byte[]]$First, [byte[]]$Second, [byte[]]$Third) {
    $result = [byte[]]::new($First.Length + $Second.Length + $Third.Length)
    [Array]::Copy($First, 0, $result, 0, $First.Length)
    [Array]::Copy($Second, 0, $result, $First.Length, $Second.Length)
    [Array]::Copy($Third, 0, $result, $First.Length + $Second.Length, $Third.Length)
    return $result
}

function Test-FixedTimeEqual([byte[]]$Left, [byte[]]$Right) {
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
    }
    return $difference -eq 0
}

$document = Get-Content -LiteralPath $PortablePath -Raw | ConvertFrom-Json
if ($document.format -ne "NLC-AMO-CREDENTIAL" -or $document.version -ne 1) {
    throw "This is not a supported Nexus Local Curator credential backup."
}

$passwordSecure = Read-Host "Portable-backup password" -AsSecureString
$plainPassword = Read-PlainText $passwordSecure
$derive = $null
$aes = $null
$hmac = $null
try {
    $salt = [Convert]::FromBase64String($document.salt)
    $iv = [Convert]::FromBase64String($document.iv)
    $ciphertext = [Convert]::FromBase64String($document.ciphertext)
    $expectedMac = [Convert]::FromBase64String($document.mac)
    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $plainPassword,
        $salt,
        [int]$document.iterations,
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $keyMaterial = $derive.GetBytes(64)
    [byte[]]$encryptionKey = $keyMaterial[0..31]
    [byte[]]$authenticationKey = $keyMaterial[32..63]

    $authenticatedData = Join-Bytes $salt $iv $ciphertext
    $hmac = [Security.Cryptography.HMACSHA256]::new($authenticationKey)
    $actualMac = $hmac.ComputeHash($authenticatedData)
    if (-not (Test-FixedTimeEqual $actualMac $expectedMac)) {
        throw "Wrong password or damaged portable credential."
    }

    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key = $encryptionKey
    $aes.IV = $iv
    $decryptor = $aes.CreateDecryptor()
    $plainBytes = $decryptor.TransformFinalBlock($ciphertext, 0, $ciphertext.Length)
    $decryptor.Dispose()
    $payload = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json

    $outputDirectory = Split-Path -Parent $CredentialPath
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $restoredSecret = ConvertTo-SecureString ([string]$payload.secret) -AsPlainText -Force
    [PSCredential]::new([string]$payload.issuer, $restoredSecret) |
        Export-Clixml -LiteralPath $CredentialPath
    Write-Host "Credential restored for this Windows account at:"
    Write-Host $CredentialPath
} finally {
    if ($hmac) { $hmac.Dispose() }
    if ($derive) { $derive.Dispose() }
    if ($aes) { $aes.Dispose() }
    $plainPassword = $null
    $payload = $null
}
