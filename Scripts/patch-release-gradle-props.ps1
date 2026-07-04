# Patch gradle.properties for production release builds (dex merge OOM on Windows).
# Usage: . .\Scripts\patch-release-gradle-props.ps1; Patch-ReleaseGradleProperties -Path "Apps\Mobile\android\gradle.properties"

function Set-GradlePropertyLine {
    param(
        [Parameter(Mandatory = $true)][string] $Content,
        [Parameter(Mandatory = $true)][string] $Key,
        [Parameter(Mandatory = $true)][string] $Value
    )
    $escaped = [regex]::Escape($Key)
    $line = "$Key=$Value"
    if ($Content -match "(?m)^\s*$escaped\s*=") {
        return [regex]::Replace($Content, "(?m)^\s*$escaped\s*=.*$", $line)
    }
    $trimmed = $Content.TrimEnd()
    if ($trimmed.Length -eq 0) { return "$line`n" }
    return "$trimmed`n$line`n"
}

function Patch-ReleaseGradleProperties {
    param(
        [Parameter(Mandatory = $true)][string] $Path
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing gradle.properties: $Path"
    }
    $content = [System.IO.File]::ReadAllText($Path)
    $content = Set-GradlePropertyLine $content "org.gradle.jvmargs" "-Xmx6144m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8"
    $content = Set-GradlePropertyLine $content "org.gradle.parallel" "false"
    $content = Set-GradlePropertyLine $content "reactNativeArchitectures" "arm64-v8a,armeabi-v7a"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

function Invoke-ReleaseGradlePropertiesPatch {
    param(
        [Parameter(Mandatory = $true)][string] $AndroidDir
    )
    $propsPath = Join-Path $AndroidDir "gradle.properties"
    Patch-ReleaseGradleProperties -Path $propsPath
    Write-Host "release gradle.properties: $propsPath"
}
