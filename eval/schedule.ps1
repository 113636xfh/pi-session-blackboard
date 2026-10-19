param(
  [Parameter(Mandatory=$true)][string]$TaskName,
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Log,
  [Parameter(Mandatory=$true)][datetime]$At,
  [Parameter(Mandatory=$true)][string]$Node
)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'scheduled.mjs'
if (!(Test-Path -LiteralPath $entry) -or !(Test-Path -LiteralPath $Manifest) -or !(Test-Path -LiteralPath $Node)) { throw 'Missing action input' }
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
$Node = (Resolve-Path -LiteralPath $Node).Path
$Log = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)
$arguments = '"' + $entry + '" "' + $Manifest + '" "' + $Log + '"'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Execute -ne $Node -or $existing.Actions.Arguments -ne $arguments)) { throw 'Refusing to replace a different scheduled action' }
$action = New-ScheduledTaskAction -Execute $Node -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -Once -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 7)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'User-authorized bounded session-blackboard experiment; internal manifest enforces start/deadline.' -Force
$task | Select-Object TaskName,State,@{Name='Execute';Expression={$_.Actions.Execute}},@{Name='Arguments';Expression={$_.Actions.Arguments}},@{Name='StartBoundary';Expression={$_.Triggers.StartBoundary}} | ConvertTo-Json -Depth 4
