# Одноразовая настройка GitHub-репозитория под безопасную работу с ИИ (см. next-architecture.md §8):
#   1) защита ветки main: только через PR, обязательные status checks CI, запрет force-push;
#   2) secret scanning + push protection;
#   3) Dependabot alerts + автоматические security-фиксы.
#
# Требования: gh CLI с авторизацией (gh auth login), права admin на репозиторий.
# Запускать ПОСЛЕ того, как .github/workflows/ci.yml попал в main (иначе required checks
# будут висеть в статусе "expected" до первого прогона — это не ошибка, но лучше по порядку).
#
# Запуск:  ./Scripts/setup-github-protection.ps1
# Откат защиты:  gh api -X DELETE "repos/<owner>/<repo>/branches/main/protection"
param(
    [string]$Branch = "main",
    # По умолчанию защита действует и на админов (владелец тоже ходит через PR).
    # -NoEnforceAdmins оставляет владельцу возможность экстренного прямого пуша.
    [switch]$NoEnforceAdmins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Определяем owner/repo из origin (имя репо может содержать точки: Flora.Ecosystem)
$originUrl = git remote get-url origin
if ($originUrl -notmatch "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/]+?)(?:\.git)?/?$") {
    throw "Не удалось разобрать origin '$originUrl' как GitHub-репозиторий."
}
$owner = $Matches.owner
$repo = $Matches.repo
$slug = "$owner/$repo"
Write-Host "Репозиторий: $slug, ветка: $Branch"

gh auth status | Out-Null

function Invoke-GhApiChecked {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [string]$Body
    )
    if ($PSBoundParameters.ContainsKey("Body") -and $null -ne $Body) {
        $Body | gh api -X $Method $Path -H "Accept: application/vnd.github+json" --input -
    } else {
        gh api -X $Method $Path -H "Accept: application/vnd.github+json"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "gh api $Method $Path failed with exit code $LASTEXITCODE"
    }
}

# --- 1. Защита ветки -------------------------------------------------------
# required_approving_review_count = 0: PR обязателен (мержит человек, ИИ не может),
# но одиночный мейнтейнер не заблокирован невозможностью одобрить собственный PR.
# contexts = имена джобов из .github/workflows/ci.yml — синхронизировать при переименовании.
$protection = @{
    required_status_checks = @{
        strict   = $true
        contexts = @("architecture", "ts", "web", "rust", "supply-chain")
    }
    enforce_admins                = -not $NoEnforceAdmins.IsPresent
    required_pull_request_reviews = @{
        required_approving_review_count = 0
    }
    restrictions           = $null
    allow_force_pushes     = $false
    allow_deletions        = $false
    required_linear_history = $false
    lock_branch            = $false
} | ConvertTo-Json -Depth 5

Invoke-GhApiChecked -Method PUT -Path "repos/$slug/branches/$Branch/protection" -Body $protection | Out-Null
Write-Host "✓ Защита ветки $Branch включена (PR + required checks: architecture, ts, web, rust, supply-chain)"

# --- 2. Secret scanning + push protection ----------------------------------
# На публичных репозиториях GitHub Free secret scanning может быть недоступен
# через API — тогда пишем предупреждение и продолжаем.
$securityPayload = @{
    security_and_analysis = @{
        secret_scanning                 = @{ status = "enabled" }
        secret_scanning_push_protection = @{ status = "enabled" }
    }
} | ConvertTo-Json -Depth 5

try {
    Invoke-GhApiChecked -Method PATCH -Path "repos/$slug" -Body $securityPayload | Out-Null
    Write-Host "✓ Secret scanning + push protection включены"
} catch {
    Write-Warning "Secret scanning / push protection не включены (часто недоступно на текущем плане): $_"
}

# --- 3. Dependabot alerts + security-фиксы ----------------------------------
try {
    Invoke-GhApiChecked -Method PUT -Path "repos/$slug/vulnerability-alerts" | Out-Null
    Invoke-GhApiChecked -Method PUT -Path "repos/$slug/automated-security-fixes" | Out-Null
    Write-Host "✓ Dependabot alerts и automated security fixes включены"
} catch {
    Write-Warning "Dependabot alerts/security fixes не включены: $_"
}

Write-Host ""
Write-Host "Готово. Проверить: https://github.com/$slug/settings/branches"
