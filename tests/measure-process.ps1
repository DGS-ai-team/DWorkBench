param([Parameter(Mandatory)][int]$AppProcessId,[int]$Seconds=15,[Parameter(Mandatory)][string]$OutputFile)
$ErrorActionPreference='Stop'
$item=Get-Process -Id $AppProcessId
$cores=[Environment]::ProcessorCount
$before=$item.TotalProcessorTime.TotalMilliseconds
$clock=[Diagnostics.Stopwatch]::StartNew()
$samples=@()
while($clock.Elapsed.TotalSeconds -lt $Seconds){
 Start-Sleep -Milliseconds 500
 $item.Refresh()
 $samples += [pscustomobject]@{workingSetMiB=[Math]::Round($item.WorkingSet64/1MB,2);privateMiB=[Math]::Round($item.PrivateMemorySize64/1MB,2);threads=$item.Threads.Count}
}
$delta=$item.TotalProcessorTime.TotalMilliseconds-$before
@{seconds=$clock.Elapsed.TotalSeconds;logicalCores=$cores;cpuOneCorePercent=$delta/($clock.Elapsed.TotalSeconds*10);cpuMachinePercent=$delta/($clock.Elapsed.TotalSeconds*10*$cores);workingSetPeakMiB=($samples|Measure-Object workingSetMiB -Maximum).Maximum;workingSetMeanMiB=($samples|Measure-Object workingSetMiB -Average).Average;privatePeakMiB=($samples|Measure-Object privateMiB -Maximum).Maximum;threadPeak=($samples|Measure-Object threads -Maximum).Maximum}|ConvertTo-Json|Set-Content -LiteralPath $OutputFile -Encoding utf8
