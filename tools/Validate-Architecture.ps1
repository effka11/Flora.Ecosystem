param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$normalizedRoot = (Resolve-Path $Root).Path
$projectFiles = Get-ChildItem -Path $normalizedRoot -Recurse -Filter *.csproj |
    Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' }

$errors = [System.Collections.Generic.List[string]]::new()

function Get-RelativePath {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $baseUri = [System.Uri]((Resolve-Path $BasePath).Path.TrimEnd("\") + "\")
    $targetUri = [System.Uri](Resolve-Path $TargetPath).Path
    $relativePath = $baseUri.MakeRelativeUri($targetUri).ToString()
    return [System.Uri]::UnescapeDataString($relativePath).Replace("\", "/")
}

function Get-ModuleBaseName {
    param([string]$ProjectName)

    $match = [regex]::Match($ProjectName, '^(?<base>Flora\.[^.]+)\.(Application|Domain|Infrastructure|Contracts)$')
    if ($match.Success) {
        return $match.Groups["base"].Value
    }

    return $null
}

function Get-ProjectCategory {
    param(
        [string]$RelativePath,
        [string]$ProjectName
    )

    if ($RelativePath -eq "Flora.API/Flora.API.csproj") {
        return "api"
    }

    if ($RelativePath -eq "Flora.Shared/Flora.Shared.csproj") {
        return "shared"
    }

    if ($RelativePath -eq "Infrastructure/Flora.gRPC/Flora.gRPC.csproj") {
        return "grpc"
    }

    if ($RelativePath.StartsWith("Modules/")) {
        if ($ProjectName.EndsWith(".Application")) { return "module-application" }
        if ($ProjectName.EndsWith(".Domain")) { return "module-domain" }
        if ($ProjectName.EndsWith(".Infrastructure")) { return "module-infrastructure" }
        if ($ProjectName.EndsWith(".Contracts")) { return "module-contracts" }
        return "module-root"
    }

    if ($RelativePath.StartsWith("Products/")) {
        return "product-root"
    }

    return "other"
}

foreach ($projectFile in $projectFiles) {
    $projectPath = $projectFile.FullName
    $projectName = [System.IO.Path]::GetFileNameWithoutExtension($projectPath)
    $relativeProjectPath = Get-RelativePath -BasePath $normalizedRoot -TargetPath $projectPath
    $projectCategory = Get-ProjectCategory -RelativePath $relativeProjectPath -ProjectName $projectName

    [xml]$projectXml = Get-Content -Path $projectPath -Raw
    $references = @($projectXml.SelectNodes("//ProjectReference")) | Where-Object { $_ -and $_.Include }

    foreach ($reference in $references) {
        $referencePath = [System.IO.Path]::GetFullPath((Join-Path $projectFile.Directory.FullName $reference.Include))
        $relativeReferencePath = Get-RelativePath -BasePath $normalizedRoot -TargetPath $referencePath
        $referenceName = [System.IO.Path]::GetFileNameWithoutExtension($referencePath)

        $isShared = $referenceName -eq "Flora.Shared"
        $isModuleLayer = $referenceName -match '\.(Application|Domain|Infrastructure|Contracts)$'
        $isModuleRoot = $relativeReferencePath.StartsWith("Modules/") -and -not $isModuleLayer
        $isProductRoot = $relativeReferencePath.StartsWith("Products/") -and -not $isModuleLayer
        $isGrpc = $referenceName -eq "Flora.gRPC"

        switch ($projectCategory) {
            "api" {
                if (-not ($isProductRoot -or $isShared)) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. API may depend only on product roots or Flora.Shared.")
                }
            }
            "product-root" {
                if (-not ($isModuleRoot -or $isShared -or ($relativeReferencePath.Contains("/Modules/") -and -not $isModuleLayer))) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Products may depend only on module roots or Flora.Shared.")
                }
            }
            "module-root" {
                $allowed = @(
                    "$projectName.Application",
                    "$projectName.Domain",
                    "$projectName.Infrastructure",
                    "$projectName.Contracts",
                    "Flora.Shared"
                )

                if ($allowed -notcontains $referenceName) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Module roots may depend only on their own layers or Flora.Shared.")
                }
            }
            "module-application" {
                $moduleBaseName = Get-ModuleBaseName -ProjectName $projectName
                $allowed = @(
                    "$moduleBaseName.Domain",
                    "$moduleBaseName.Contracts",
                    "Flora.Shared"
                )

                if ($allowed -notcontains $referenceName) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Application may depend only on its own Domain, Contracts, or Flora.Shared.")
                }
            }
            "module-domain" {
                if (-not $isShared) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Domain may depend only on Flora.Shared.")
                }
            }
            "module-contracts" {
                if (-not $isShared) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Contracts may depend only on Flora.Shared.")
                }
            }
            "module-infrastructure" {
                $moduleBaseName = Get-ModuleBaseName -ProjectName $projectName
                $allowed = @(
                    "$moduleBaseName.Application",
                    "$moduleBaseName.Domain",
                    "$moduleBaseName.Contracts",
                    "Flora.gRPC",
                    "Flora.Shared"
                )

                if ($allowed -notcontains $referenceName) {
                    $errors.Add("[$relativeProjectPath] invalid reference to [$relativeReferencePath]. Infrastructure may depend only on its own Application, Domain, Contracts, Flora.gRPC, or Flora.Shared.")
                }
            }
        }
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Architecture validation passed."
