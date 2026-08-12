# Генерирует пару ключей для выпуска лицензий из личного кабинета на сайте.
#
# Это НЕ сертификат «LVA Code Signing». Он отдельный намеренно: приватная часть
# уезжает в облако (секреты Supabase), и её утечка обесценивает только лицензии.
# Утечка ключа подписи кода позволила бы выпускать сборки от вашего имени.
#
#   .\New-LvaWebKey.ps1                 # 10 лет, файлы в .\license-keys
#   .\New-LvaWebKey.ps1 -Years 5 -OutDir C:\Temp\keys
#
# Что делать с результатом:
#   private-key.b64  → секрет LICENSE_SIGNING_KEY в Supabase, затем удалить файл
#   pubkey-web.cer   → в LVA.BIM.Common\Licensing\, пересобрать плагины
#
# Приватный ключ не коммитить и никому не передавать.

param(
    [int]$Years = 10,
    [string]$OutDir = (Join-Path $PSScriptRoot "..\license-keys")
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

# Ключ 3072 бит: заметно прочнее 2048 и без платы за это — подпись считается
# один раз за лицензию, проверка в плагине и так мгновенная.
$cert = New-SelfSignedCertificate `
    -Subject "CN=LVA BIM License Signing (web), O=LVA.BIM, OU=License Issuing" `
    -KeyAlgorithm RSA -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($Years) `
    -CertStoreLocation Cert:\CurrentUser\My `
    -Type Custom -KeyUsage DigitalSignature

Write-Host "Сертификат создан: $($cert.Thumbprint)" -ForegroundColor Green

# Публичная часть — DER (.cer). Именно её читает X509Certificate2 в LicenseGate.
$cerPath = Join-Path $OutDir "pubkey-web.cer"
[IO.File]::WriteAllBytes($cerPath, $cert.RawData)

# Приватная часть — PKCS#8 в base64: в таком виде её принимает Web Crypto в
# Edge Function. Способ зависит от версии PowerShell.
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
if (-not $rsa) { throw "У созданного сертификата нет доступного приватного ключа" }

$privB64 = $null
if ($rsa.PSObject.Methods.Name -contains 'ExportPkcs8PrivateKey') {
    # PowerShell 7 / .NET Core — умеет сам.
    $privB64 = [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey())
} else {
    # Windows PowerShell 5.1 (.NET Framework) такого метода не имеет. Вытаскиваем
    # ключ через временный PFX и openssl — он есть в составе Git for Windows.
    $openssl = Get-Command openssl -ErrorAction SilentlyContinue
    if (-not $openssl) {
        foreach ($guess in @(
            "$env:ProgramFiles\Git\usr\bin\openssl.exe",
            "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
            "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe")) {
            if (Test-Path $guess) { $openssl = Get-Command $guess; break }
        }
    }
    if (-not $openssl) {
        throw @"
Не удалось экспортировать приватный ключ.
Windows PowerShell 5.1 этого не умеет, а openssl не найден.
Выберите одно:
  * запустите скрипт в PowerShell 7:  pwsh -File tools\New-LvaWebKey.ps1
  * или установите Git for Windows (в нём есть openssl) и повторите
Сертификат уже создан, он в Cert:\CurrentUser\My, отпечаток $($cert.Thumbprint).
"@
    }

    $pfx = Join-Path $env:TEMP ("lva-web-" + [Guid]::NewGuid().ToString("N") + ".pfx")
    $pem = "$pfx.p8"
    # Пароль случайный и живёт только между двумя вызовами ниже.
    $pass = [Guid]::NewGuid().ToString("N")
    try {
        $secure = ConvertTo-SecureString -String $pass -AsPlainText -Force
        Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
        & $openssl.Source pkcs12 -in $pfx -nocerts -nodes -passin "pass:$pass" -out $pem 2>$null
        & $openssl.Source pkcs8 -topk8 -nocrypt -in $pem -outform DER -out "$pem.der" 2>$null
        $privB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$pem.der"))
    } finally {
        # Уборка временных файлов — best-effort и не должна ронять весь запуск:
        # ключ (в $privB64) к этому моменту уже посчитан. На некоторых профилях
        # (короткие 8.3-имена в пути пользователя и т.п.) Remove-Item падает
        # даже когда Test-Path перед этим сказал true — не критично, само тело
        # $env:TEMP всё равно периодически чистит система.
        foreach ($f in @($pfx, $pem, "$pem.der")) {
            if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
        }
    }
}

$privPath = Join-Path $OutDir "private-key.b64"
Set-Content -Path $privPath -Value $privB64 -Encoding Ascii -NoNewline

Write-Host ""
Write-Host "Готово. Файлы в $OutDir" -ForegroundColor Green
Write-Host "  private-key.b64  → секрет LICENSE_SIGNING_KEY в Supabase, потом удалить файл"
Write-Host "  pubkey-web.cer   → в LVA.BIM.Common\Licensing\, пересобрать плагины"
Write-Host ""
Write-Host "Срок действия: $Years лет. Приватный ключ не коммитить." -ForegroundColor Yellow
Write-Host "Сертификат остался и в Cert:\CurrentUser\My — при желании удалите его оттуда:"
Write-Host "  Remove-Item Cert:\CurrentUser\My\$($cert.Thumbprint)"
