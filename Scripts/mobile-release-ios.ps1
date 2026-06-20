# Production iOS build via EAS Cloud (requires macOS workers; run on Windows after `eas login`).
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mobile = Join-Path $root "Apps\Mobile"

$envFile = Join-Path $mobile ".env"
if (-not (Test-Path $envFile)) {
    throw "Missing Apps/Mobile/.env with EXPO_PUBLIC_API_URL (see .env.production.example)."
}

Push-Location $mobile
try {
    $whoami = npx eas whoami 2>&1
    if ($LASTEXITCODE -ne 0 -or ($whoami -match "Not logged in")) {
        throw @"
EAS: not logged in. Run interactively:
  cd Apps/Mobile
  npx eas login
  npx eas init   # links projectId in app.json if placeholder
Then re-run: npm run build:ios:production
"@
    }

    Write-Host "eas build --platform ios --profile production ..."
    npx eas build --platform ios --profile production --non-interactive
    if ($LASTEXITCODE -ne 0) { throw "EAS iOS build failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
