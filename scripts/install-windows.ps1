param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [ValidateRange(1024, 65535)][int]$Port = 17842
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This release provides a Windows x64 launcher. See README.zh-TW.md for details.'
}

$project = Split-Path -Parent $PSScriptRoot
$workspacePath = (Get-Item -LiteralPath $Workspace).FullName
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
if ([version]((& $node --version).TrimStart('v')) -lt [version]'22.15') {
    throw 'Node.js 22.15 or newer is required.'
}
$agyCommand = Get-Command agy.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$agy = if ($agyCommand) { $agyCommand.Source } else { Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe' }
if (!(Test-Path -LiteralPath $agy -PathType Leaf)) {
    throw 'Install Antigravity CLI and sign in first. See https://antigravity.google/docs/getting-started?tab=cli'
}

$launcher = Join-Path $project 'bin\bridge-service.exe'
$releaseUrl = 'https://github.com/HolyBearTW/codex-bridge-antigravity/releases/download/v0.1.0-holybear.1/bridge-service-windows-x64.exe'
$expectedHash = 'D81EB21EB91629EC1E2F9CDF5F69ED91F7730488A8C1425DD878B5C03B35436F'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $launcher) -Force | Out-Null
    $download = "$launcher.download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $releaseUrl -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expectedHash) {
            throw 'The release launcher did not match its SHA-256.'
        }
        Move-Item -LiteralPath $download -Destination $launcher
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
} elseif ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'The launcher in bin has a different hash. For a locally built launcher, use node src/cli.mjs setup directly.'
}

& $node (Join-Path $project 'src\cli.mjs') setup --cwd $workspacePath --port $Port --agy-path $agy
if ($LASTEXITCODE -ne 0) { throw 'Codex bridge setup failed. See the error above.' }
