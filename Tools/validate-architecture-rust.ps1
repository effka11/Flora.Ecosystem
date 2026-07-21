# Валидатор границ Rust-workspace (next-architecture.md §2.3).
# Категории учитывают Products/* (App Social + Functional) и Backend/crates host.

param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $RepoRoot "Cargo.toml"
if (-not (Test-Path $manifestPath)) {
    Write-Error "Не найден $manifestPath"
    exit 1
}

$repoRoot = $RepoRoot
$metadataJson = cargo metadata --format-version 1 --no-deps --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "cargo metadata завершился с ошибкой"
    exit 1
}
$metadata = $metadataJson | ConvertFrom-Json

$packages = @($metadata.packages)
$internalNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($package in $packages) { [void]$internalNames.Add($package.name) }

# Social module root names (App product internals)
$socialModuleRoots = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
@(
    "flora-auth", "flora-users", "flora-content", "flora-messaging",
    "flora-music", "flora-notifications", "flora-verification"
) | ForEach-Object { [void]$socialModuleRoots.Add($_) }

$functionalKernels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
@(
    "fscp-core", "fscp-crypto", "fscp-contracts",
    "fira-core", "fira-contracts",
    "flora-economy-crypto", "flora-economy-contracts",
    "flora-economy-wasm", "flora-economy-witness",
    "flora-governance-crypto", "flora-governance-contracts",
    "fpp-crypto", "fpp-contracts", "fpp-core",
    "frc-i", "frc-i-integration", "frc-i-wasm", "frc-i-mobile-ffi",
    "frc-a-core", "frc-a-cli", "frc-a-polygon", "frc-v", "frc-v-cli", "frc-v-polygon", "frc-v-wasm", "flora-codec-tools"
) | ForEach-Object { [void]$functionalKernels.Add($_) }

function Get-CrateCategory {
    param($Package)

    $name = $Package.name
    $manifestDir = Split-Path -Parent $Package.manifest_path
    $relative = [System.IO.Path]::GetRelativePath($repoRoot, $manifestDir).Replace("\", "/")

    if ($relative -eq "Backend/crates/flora-api") { return "api" }
    if ($relative -eq "Backend/crates/flora-shared") { return "shared" }
    if ($relative -eq "Backend/crates/flora-migrate") { return "migrate" }
    if ($relative -eq "Backend/Tests/parity") { return "parity" }
    if ($relative.StartsWith("Backend/crates/infrastructure/")) { return "infrastructure" }

    if ($relative -eq "Products/Flora.Social/crates/flora-social") { return "product" }
    if ($relative.StartsWith("Products/Flora.Social/crates/modules/")) {
        if ($name.EndsWith("-contracts")) { return "module-contracts" }
        return "module-root"
    }

    if ($relative.StartsWith("Products/FSCP/") -or
        $relative.StartsWith("Products/FIRA/") -or
        $relative.StartsWith("Products/FEP/") -or
        $relative.StartsWith("Products/FGP/") -or
        $relative.StartsWith("Products/FPP/") -or
        $relative.StartsWith("Products/FRC/")) {
        if ($name -eq "flora-economy") { return "functional-runtime" }
        if ($name.EndsWith("-contracts")) { return "functional-contracts" }
        if ($name.EndsWith("-crypto") -or $name -eq "fscp-core" -or $name -eq "fira-core" -or
            $name.StartsWith("frc-") -or $name -eq "flora-codec-tools") {
            return "functional-kernel"
        }
        return "functional-kernel"
    }

    return "unknown"
}

$errors = [System.Collections.Generic.List[string]]::new()

foreach ($package in $packages) {
    $category = Get-CrateCategory -Package $package
    if ($category -eq "unknown") {
        $errors.Add("[$($package.name)] не классифицирован — обновите validate-architecture-rust.ps1 / next-architecture.md §2.3.")
        continue
    }
    if ($category -eq "parity") { continue }

    $internalDeps = @($package.dependencies | Where-Object {
            $internalNames.Contains($_.name) -and
            (-not $_.kind -or $_.kind -eq "normal")
        })

    foreach ($dependency in $internalDeps) {
        $dep = $dependency.name
        $allowed = switch ($category) {
            "api" { ($dep -eq "flora-social") -or ($dep -eq "flora-shared") }
            "product" {
                # Composition: module roots + their contracts (ports) + shared + functional.
                $socialModuleRoots.Contains($dep) -or ($dep -eq "flora-shared") -or
                ($dep -eq "flora-economy") -or $functionalKernels.Contains($dep) -or
                ($dep.StartsWith("flora-") -and $dep.EndsWith("-contracts"))
            }
            "module-root" {
                $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") -or
                ($dep -eq "$($package.name)-crypto") -or
                $functionalKernels.Contains($dep) -or ($dep -eq "fira-core") -or ($dep -eq "fscp-core")
            }
            "module-contracts" { $dep -eq "flora-shared" }
            "shared" { $false }
            "migrate" { $socialModuleRoots.Contains($dep) -or ($dep -eq "flora-shared") -or ($dep -eq "flora-economy") }
            "infrastructure" { $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") }
            "functional-kernel" {
                # Portable: only other functional crates + flora-shared for FIRA parity primitives.
                $functionalKernels.Contains($dep) -or ($dep -eq "flora-shared") -or
                $dep.EndsWith("-contracts")
            }
            "functional-contracts" {
                $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") -or $functionalKernels.Contains($dep)
            }
            "functional-runtime" {
                $dep.EndsWith("-contracts") -or ($dep -eq "flora-shared") -or
                ($dep -eq "$($package.name)-crypto") -or $functionalKernels.Contains($dep)
            }
        }
        # Hard ban: functional must never depend on Social modules / flora-social
        if ($category.StartsWith("functional") -and (
                $socialModuleRoots.Contains($dep) -or ($dep -eq "flora-social"))) {
            $allowed = $false
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
