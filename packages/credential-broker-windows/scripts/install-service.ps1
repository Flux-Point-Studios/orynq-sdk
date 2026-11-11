#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs or removes one orynq broker service (spec §16(a)) under its own virtual account.

.DESCRIPTION
  The service runs as NT SERVICE\<Name> through orynq-service-host.exe. Its state directory
  %ProgramData%\<Name> admits only SYSTEM and the service SID. Only SYSTEM and Administrators may
  start, stop or reconfigure it. The host and program must sit under %ProgramFiles%, so that no
  account a non-admin controls can replace what the service executes.

.EXAMPLE
  .\install-service.ps1 -Name orynq-sealed -Program "$env:ProgramFiles\orynq\node\node.exe" -Arguments "$env:ProgramFiles\orynq\app\dist\sealed.js"

.EXAMPLE
  .\install-service.ps1 -Name orynq-sealed -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(Mandatory)][ValidatePattern('^orynq-[a-z][a-z-]*$')][string]$Name,
  [Parameter(Mandatory, ParameterSetName = 'Install')][string]$Program,
  [Parameter(ParameterSetName = 'Install')][string[]]$Arguments = @(),
  [Parameter(ParameterSetName = 'Install')][string]$ServiceHost = (Join-Path $env:ProgramFiles 'orynq\orynq-service-host.exe'),
  [Parameter(Mandatory, ParameterSetName = 'Remove')][switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Invoke-Sc([string[]]$ScArguments) {
  $output = & "$env:SystemRoot\System32\sc.exe" @ScArguments
  if ($LASTEXITCODE -ne 0) { throw "sc.exe $($ScArguments -join ' ') failed ($LASTEXITCODE): $output" }
}

function Assert-AdminOwnedPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') + '\'
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw "$full is outside $root" }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$full does not exist" }
  $full
}

if ($Remove) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { throw "service $Name is not installed" }
  if ($service.Status -ne 'Stopped') { Stop-Service -Name $Name; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
  Invoke-Sc @('delete', $Name)
  "removed $Name; state in $env:ProgramData\$Name is kept"
  return
}

if (Get-Service -Name $Name -ErrorAction SilentlyContinue) { throw "service $Name is already installed" }
$hostPath = Assert-AdminOwnedPath $ServiceHost
$programPath = Assert-AdminOwnedPath $Program
$quoted = @($Name) + (@($programPath) + $Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' })
$binaryPath = '"' + $hostPath + '" ' + ($quoted -join ' ')

New-Service -Name $Name -BinaryPathName $binaryPath -DisplayName "orynq $Name" -StartupType Manual | Out-Null
# A virtual account takes no password; the service manager requires it to be absent.
Invoke-Sc @('config', $Name, 'obj=', "NT SERVICE\$Name")
Invoke-Sc @('sidtype', $Name, 'unrestricted')
Invoke-Sc @('sdset', $Name, 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)')
Invoke-Sc @('failure', $Name, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000')
Invoke-Sc @('failureflag', $Name, '1')

$state = Join-Path $env:ProgramData $Name
New-Item -ItemType Directory -Path $state -Force | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $state /setowner '*S-1-5-18' /q | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $state /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' "NT SERVICE\${Name}:(OI)(CI)F" /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls on $state failed ($LASTEXITCODE)" }

$sid = ((& "$env:SystemRoot\System32\sc.exe" showsid $Name) -match 'SERVICE SID' -replace '.*:\s*', '').Trim()
"installed $Name as NT SERVICE\$Name ($sid); state $state"
