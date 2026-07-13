# Валидатор границ Rust-workspace (next-architecture.md §2.3) — аналог Validate-Architecture.ps1 для C#.
# Работает поверх `cargo metadata`: правила зависимостей между crate'ами компилируемы (path-deps),
# скрипт закрывает обратное — запрещённые рёбра, добавленные по невнимательности.
#
# Категории и разрешённые внутренние зависимости:
#   flora-api        -> flora-social, flora-shared
#   flora-social     -> корни модулей, flora-shared
#   flora-<module>   -> свой *-contracts, чужие *-contracts, flora-shared
#   *-contracts      -> flora-shared
#   flora-shared     -> (только внешние crates)
#   flora-migrate    -> корни модулей (их миграторы), flora-shared
#   flora-grpc-bridge-> любые *-contracts, flora-shared (§5.2)
#   flora-parity     -> без ограничений (диф-харнесс сравнивает реализации)

param(
    [string]$BackendDir = (Resolve-Path (Join-Path $PSScriptRoot "..\Backend"))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $BackendDir "Cargo.toml"
if (-not (Test-Path $manifestPath)) {
    Write-Error "Не найден $manifestPath"
    exit 1
}

$metadataJson = cargo metadata --format-version 1 --no-deps --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "cargo metadata завершился с ошибкой"
    exit 1
}
$metadata = $metadataJson | ConvertFrom-Json

$packages = @($metadata.packages)
$internalNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($package in $packages) { [void]$internalNames.Add($package.name) }

function Get-CrateCategory {
    param($Package, [string]$BackendRoot)

    $manifestDir = Split-Path -Parent $Package.manifest_path
    $relative = [System.IO.Path]::GetRelativePath($BackendRoot, $manifestDir).Replace("\", "/")

    if ($relative -eq "crates/flora-api") { return "api" }
    if ($relative -eq "crates/flora-social") { return "product" }
    if ($relative -eq "crates/flora-shared") { return "shared" }
    if ($relative -eq "crates/flora-migrate") { return "migrate" }
    if ($relative -eq "tests/parity") { return "parity" }
    if ($relative.StartsWith("crates/infrastructure/")) { return "infrastructure" }
    if ($relative.StartsWith("crates/modules/")) {
        if ($Package.name.EndsWith("-contracts")) { return "module-contracts" }
        return "module-root"
    }
    return "unknown"
}

$moduleRoots = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($package in $packages) {
    if ((Get-CrateCategory -Package $package -BackendRoot $BackendDir) -eq "module-root") {
        [void]$moduleRoots.Add($package.name)
    }
}

$errors = [System.Collections.Generic.List[string]]::new()

foreach ($package in $packages) {
    $category = Get-CrateCategory -Package $package -BackendRoot $BackendDir
    if ($category -eq "unknown") {
        $errors.Add("[$($package.name)] не классифицирован — новый crate добавьте в validate-architecture-rust.ps1 и §2.3.")
        continue
    }
    if ($category -eq "parity") { continue }

    # dev- и build-зависимости проверяются теми же правилами: тестовая обвязка
    # не имеет права протаскивать межмодульные рёбра (для этого есть tests/parity).
    $internalDeps = @($package.dependencies | Where-Object { $internalNames.Contains($_.name) })

    foreach ($dependency in $internalDeps) {
        $dep = $dependency.name
        $allowed = switch ($category) {
            "api" { ($dep -eq "flora-social") -or ($dep -eq "flora-shared") }
            "product" { $moduleRoots.Contains($dep) -or ($dep -eq "flora-shared") }
            "module-root" { $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") }
            "module-contracts" { $dep -eq "flora-shared" }
            "shared" { $false }
            "migrate" { $moduleRoots.Contains($dep) -or ($dep -eq "flora-shared") }
            "infrastructure" { $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") }
        }
        if (-not $allowed) {
            $errors.Add("[$($package.name)] ($category) недопустимая зависимость -> [$dep]. Правила: next-architecture.md §2.3.")
        }
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Rust architecture validation passed ($($packages.Count) crates)."
