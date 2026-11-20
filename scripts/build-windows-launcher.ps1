$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$output = Join-Path $project 'bin'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$object = Join-Path $output 'launcher.obj'
$executable = Join-Path $output 'bridge-service.exe'
# Run from an initialized Visual Studio 2026 x64 environment.
& cl.exe /nologo /W4 /WX /O2 /c "/Fo$object" (Join-Path $project 'windows\launcher.cpp')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
& link.exe /nologo /SUBSYSTEM:WINDOWS /ENTRY:Start /NODEFAULTLIB /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA "/OUT:$executable" $object kernel32.lib shell32.lib
if ($LASTEXITCODE -ne 0) { throw 'Launcher linking failed' }
Write-Output $executable
