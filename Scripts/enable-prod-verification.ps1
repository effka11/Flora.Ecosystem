# Enables production email verification on VPS: PostgreSQL + flora-api.env + migrations + API restart.
param(
    [string] $Server = "157.22.187.100",
    [string] $User = "root",
    [string] $IdentityFile = "$env:USERPROFILE\.ssh\id_ed25519_flora",
    [string] $GmailAddress = "",
    [string] $GmailAppPassword = "",
    [switch] $SkipApiDeploy
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sshTarget = "${User}@${Server}"

function Invoke-Ssh {
    param([string] $Command)
    & ssh -i $IdentityFile -o BatchMode=yes $sshTarget $Command
    if ($LASTEXITCODE -ne 0) { throw "ssh failed: $Command" }
}

Write-Host "Installing PostgreSQL on VPS..."
$pgScript = Join-Path $PSScriptRoot "setup-prod-vps-postgres.sh"
& scp -i $IdentityFile -o StrictHostKeyChecking=no $pgScript "${sshTarget}:/tmp/setup-prod-vps-postgres.sh"
if ($LASTEXITCODE -ne 0) { throw "scp failed." }

$dbPassLine = Invoke-Ssh "chmod +x /tmp/setup-prod-vps-postgres.sh; bash /tmp/setup-prod-vps-postgres.sh"
$dbPass = ($dbPassLine | Where-Object { $_ -match "^DB_PASS=" }) -replace "^DB_PASS=", ""
if (-not $dbPass) { throw "Failed to read generated DB password from server." }

$jwtSecret = [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
$dbConn = "Host=127.0.0.1;Port=5432;Database=flora_social;Username=flora;Password=$dbPass;Include Error Detail=false;Search Path=flora_core"

$smtpLines = @(
    "Smtp__Host=smtp.gmail.com",
    "Smtp__Port=587",
    "Smtp__EnableSsl=true",
    "Smtp__FromName=Flora"
)
if ($GmailAddress -and $GmailAppPassword) {
    $smtpLines += @(
        "Smtp__Username=$GmailAddress",
        "Smtp__Password=$GmailAppPassword",
        "Smtp__FromEmail=$GmailAddress"
    )
}
else {
    Write-Warning "Gmail not passed - set Smtp credentials in /etc/flora-ecosystem/flora-api.env on server."
    $smtpLines += @(
        "Smtp__Username=YOUR_GMAIL@gmail.com",
        "Smtp__Password=GMAIL_APP_PASSWORD",
        "Smtp__FromEmail=YOUR_GMAIL@gmail.com"
    )
}

$envContent = @(
    "ConnectionStrings__FloraDatabase=$dbConn",
    "Jwt__Secret=$jwtSecret",
    "Jwt__Issuer=Flora.Auth",
    "Jwt__Audience=Flora.Ecosystem",
    "Jwt__AccessTokenMinutes=15",
    "Jwt__RefreshTokenDays=7"
) + $smtpLines

$localEnv = Join-Path $env:TEMP "flora-api.env"
[System.IO.File]::WriteAllText($localEnv, ($envContent -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
& scp -i $IdentityFile -o StrictHostKeyChecking=no $localEnv "${sshTarget}:/etc/flora-ecosystem/flora-api.env"
if ($LASTEXITCODE -ne 0) { throw "scp flora-api.env failed." }
Invoke-Ssh "chmod 600 /etc/flora-ecosystem/flora-api.env"
Remove-Item -LiteralPath $localEnv -Force -ErrorAction SilentlyContinue

Write-Host "Applying EF migrations via SSH tunnel..."
$tunnel = Start-Process -FilePath "ssh" -ArgumentList @(
    "-i", $IdentityFile, "-o", "BatchMode=yes", "-N", "-L", "15432:127.0.0.1:5432", $sshTarget
) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
try {
    $env:ConnectionStrings__FloraDatabase = "Host=127.0.0.1;Port=15432;Database=flora_social;Username=flora;Password=$dbPass;Include Error Detail=true;Search Path=flora_core"
    Push-Location $repo
    & (Join-Path $PSScriptRoot "apply-flora-migrations.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Migrations failed." }
}
finally {
    Pop-Location
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}

if (-not $SkipApiDeploy) {
    Write-Host "Deploying API with production SMTP guard..."
    Push-Location (Join-Path $repo "Apps\Web")
    & .\scripts\deploy.ps1 -SkipBuild -Server $Server -User $User -IdentityFile $IdentityFile -Domain flora-s.net -PublicSubdomain social -PublicApiBaseUrl "https://origin.flora-s.net" -AllowedClientIps "-"
    Pop-Location
}
else {
    Invoke-Ssh "systemctl restart flora-api; sleep 2; systemctl is-active flora-api"
}

Write-Host "Done. Production verification requires working Gmail SMTP in flora-api.env."
if (-not ($GmailAddress -and $GmailAppPassword)) {
    Write-Host "On server: edit /etc/flora-ecosystem/flora-api.env then run systemctl restart flora-api"
}
