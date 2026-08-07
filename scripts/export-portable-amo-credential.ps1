param(
    [string]$CredentialPath = "D:\Private\NexusLocalCurator\amo-signing.credential.xml",
    [string]$OutputPath = "D:\Backups\NexusLocalCurator\amo-signing.portable.json"
)

$ErrorActionPreference = "Stop"
$iterations = 600000

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

$credential = Import-Clixml -LiteralPath $CredentialPath
$passwordOne = Read-Host "Portable-backup password (hidden)" -AsSecureString
$passwordTwo = Read-Host "Repeat portable-backup password" -AsSecureString
$plainPassword = Read-PlainText $passwordOne
$confirmation = Read-PlainText $passwordTwo
if ($plainPassword.Length -lt 12) {
    throw "Use a portable-backup password of at least 12 characters."
}
if ($plainPassword -cne $confirmation) {
    throw "The portable-backup passwords did not match."
}

$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
$aes = $null
$derive = $null
$hmac = $null
try {
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $payload = @{
        issuer = $credential.UserName
        secret = $secret
    } | ConvertTo-Json -Compress
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payload)

    $salt = [byte[]]::new(16)
    $iv = [byte[]]::new(16)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($salt)
    $random.GetBytes($iv)
    $random.Dispose()

    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $plainPassword,
        $salt,
        $iterations,
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $keyMaterial = $derive.GetBytes(64)
    [byte[]]$encryptionKey = $keyMaterial[0..31]
    [byte[]]$authenticationKey = $keyMaterial[32..63]

    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key = $encryptionKey
    $aes.IV = $iv
    $encryptor = $aes.CreateEncryptor()
    $ciphertext = $encryptor.TransformFinalBlock($payloadBytes, 0, $payloadBytes.Length)
    $encryptor.Dispose()

    $authenticatedData = Join-Bytes $salt $iv $ciphertext
    $hmac = [Security.Cryptography.HMACSHA256]::new($authenticationKey)
    $mac = $hmac.ComputeHash($authenticatedData)

    $document = [ordered]@{
        format = "NLC-AMO-CREDENTIAL"
        version = 1
        kdf = "PBKDF2-HMAC-SHA256"
        iterations = $iterations
        cipher = "AES-256-CBC-HMAC-SHA256"
        salt = [Convert]::ToBase64String($salt)
        iv = [Convert]::ToBase64String($iv)
        ciphertext = [Convert]::ToBase64String($ciphertext)
        mac = [Convert]::ToBase64String($mac)
    } | ConvertTo-Json

    $outputDirectory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    [IO.File]::WriteAllText($OutputPath, $document, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "restore-portable-amo-credential.ps1") `
        -Destination (Join-Path $outputDirectory "restore-portable-amo-credential.ps1") -Force
    Write-Host "Portable encrypted credential written to:"
    Write-Host $OutputPath
} finally {
    if ($hmac) { $hmac.Dispose() }
    if ($derive) { $derive.Dispose() }
    if ($aes) { $aes.Dispose() }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    $credential = $null
    $secret = $null
    $payload = $null
    $plainPassword = $null
    $confirmation = $null
}
