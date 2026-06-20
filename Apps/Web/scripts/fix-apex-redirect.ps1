# Apex HTTP/HTTPS redirect to https://social.<Domain>. Requires: A @ -> VPS, NO AAAA on apex.
param(
    [string] $Server = "",
    [string] $User = "deploy",
    [string] $Domain = "flora-s.net",
    [string] $PublicSubdomain = "social",
    [string] $IdentityFile = "",
    [string] $CertbotEmail = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = $env:FLORA_DEPLOY_HOST
}
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw "Server host required: pass -Server <host> or set FLORA_DEPLOY_HOST."
}
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $IdentityFile = Join-Path $env:USERPROFILE ".ssh\flora_cursor_temp"
}

Write-Host "Checking DNS for $Domain ..."
$aaaa = Resolve-DnsName $Domain -Type AAAA -Server 8.8.8.8 -ErrorAction SilentlyContinue
if ($aaaa) {
    Write-Host ""
    Write-Host "BLOCKER: apex still has AAAA -> $($aaaa[0].IPAddress)" -ForegroundColor Red
    Write-Host "Delete the AAAA record for $Domain in Selectel DNS, wait 5-15 min, then re-run:"
    Write-Host "  .\scripts\fix-apex-redirect.ps1 -CertbotEmail you@mail.com"
    exit 1
}

$scriptDir = Split-Path $PSScriptRoot -Parent
$remoteSh = Join-Path $PSScriptRoot "fix-apex-nginx-ssl.sh"
if (-not (Test-Path $remoteSh)) { throw "Missing $remoteSh" }

$sshTarget = "${User}@${Server}"
scp -i $IdentityFile -o StrictHostKeyChecking=no $remoteSh "${sshTarget}:/tmp/fix-apex-nginx-ssl.sh"
$emailArg = if ([string]::IsNullOrWhiteSpace($CertbotEmail)) { "" } else { "CERTBOT_EMAIL=$CertbotEmail" }
ssh -i $IdentityFile -o StrictHostKeyChecking=no $sshTarget "sudo DOMAIN=$Domain PUBLIC_SUBDOMAIN=$PublicSubdomain $emailArg bash /tmp/fix-apex-nginx-ssl.sh"

# HTTP redirect vhost (fix-apex-nginx-ssl.sh only handles HTTPS after certbot).
ssh -i $IdentityFile -o StrictHostKeyChecking=no $sshTarget @"
sudo tee /etc/nginx/sites-available/flora-apex-redirect.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name $Domain www.$Domain;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://${PublicSubdomain}.$Domain`$request_uri;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/flora-apex-redirect.conf /etc/nginx/sites-enabled/00-flora-apex-redirect.conf
sudo rm -f /etc/nginx/conf.d/flora-web.conf /etc/nginx/sites-enabled/00-flora-apex-site.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf
sudo nginx -t && sudo systemctl reload nginx
"@

Write-Host ""
Write-Host "Verify:"
Write-Host "  curl.exe -4 -sI http://$Domain"
Write-Host "  curl.exe -4 -sI https://$Domain"
