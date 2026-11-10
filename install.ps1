# One-click installer for WeKnora_plugin_byDHS (Windows / PowerShell).
#
#   .\install.ps1 -Profile desktop
#   .\install.ps1 -Profile desktop -BaseUrl http://10.0.0.12:8090/api/v1 -KnowledgeBaseIds kb-1,kb-2
#
# What it does:
#   1. copies the package into <DSH_HOME>/profiles/<Profile>/node_modules/weknora-plugin-bydhs
#   2. adds the dependency and the bundle entry to that profile's package.json
#   3. appends the plugin row to that profile's cordis.patch.yml (unless present)
#   4. prints the next steps (credential + restart + verification)
#
# It never writes the API key anywhere: the key must already live in the DSH
# credential store (~/.dsh/.credentials.yaml -> refs.<KeyRef>).

param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$PackagePath = $PSScriptRoot,
  [string]$BaseUrl = 'http://localhost:8080/api/v1',
  [string]$KnowledgeBaseIds = '',
  [string]$KeyRef = 'WEKNORA_API_KEY'
)

$ErrorActionPreference = 'Stop'
$PackageName = 'weknora-plugin-bydhs'
$PluginId = 'WeKnora_plugin_byDHS'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
if (-not (Test-Path $profileDir)) {
  throw "Profile directory not found: $profileDir (check -Profile, or start DSH once to create it)"
}

Write-Host "DSH home : $dshHome"
Write-Host "Profile  : $profileDir"
Write-Host "Package  : $PackagePath"

# --- 1. copy the package ----------------------------------------------------
$dest = Join-Path $profileDir (Join-Path 'node_modules' $PackageName)
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -Path $PackagePath -Force | Where-Object {
  $_.Name -notin @('node_modules', '.git', 'install.ps1')
} | Copy-Item -Destination $dest -Recurse -Force
Write-Host "[1/3] copied package to $dest"

# --- 2. profile package.json ------------------------------------------------
$pkgFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgFile)) { throw "Not a DSH profile (package.json missing): $pkgFile" }
$profilePkg = Get-Content -Path $pkgFile -Raw | ConvertFrom-Json
if ($null -eq $profilePkg.dependencies) {
  $profilePkg | Add-Member -MemberType NoteProperty -Name dependencies -Value (New-Object PSObject)
}
$profilePkg.dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value ("file:" + ($PackagePath -replace '\\', '/')) -Force
if ($null -eq $profilePkg.dsh) {
  $profilePkg | Add-Member -MemberType NoteProperty -Name dsh -Value (New-Object PSObject)
}
if ($null -eq $profilePkg.dsh.profile) {
  $profilePkg.dsh | Add-Member -MemberType NoteProperty -Name profile -Value (New-Object PSObject)
}
$bundles = @()
if ($null -ne $profilePkg.dsh.profile.bundles) { $bundles = @($profilePkg.dsh.profile.bundles) }
if ($bundles -notcontains $PackageName) { $bundles += $PackageName }
$profilePkg.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force
$json = $profilePkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($pkgFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[2/3] updated $pkgFile"

# --- 3. profile cordis.patch.yml -------------------------------------------
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$existing = if (Test-Path $patchFile) { Get-Content -Path $patchFile -Raw } else { '' }
if ($existing -match [regex]::Escape($PluginId)) {
  Write-Host "[3/3] $patchFile already mentions $PluginId; left unchanged"
} else {
  $kbYaml = if ($KnowledgeBaseIds.Trim() -ne '') {
    "    knowledgeBaseIds:`r`n" + (($KnowledgeBaseIds.Split(',') | ForEach-Object { "      - " + $_.Trim() }) -join "`r`n") + "`r`n"
  } else { '' }
  $row = @"
- id: $PluginId
  name: "$PackageName"
  disabled: false
  config:
    baseUrl: '$BaseUrl'
    apiKeyRef: $KeyRef
$kbYaml
"@
  $text = if ($existing.Trim() -eq '') { $row } else { $existing.TrimEnd() + "`r`n`r`n" + $row }
  [IO.File]::WriteAllText($patchFile, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[3/3] appended plugin row to $patchFile"
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. put the API key into $dshHome\.credentials.yaml under refs.$KeyRef"
Write-Host '  2. restart DSH (or reload the profile)'
Write-Host "  3. look for: $PluginId: registered ..."
Write-Host '  4. verify first: node scripts\verify-live.mjs --query "<a question your KB answers>"'
