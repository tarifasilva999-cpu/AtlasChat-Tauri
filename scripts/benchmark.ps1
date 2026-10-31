$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$meta=Get-Content (Join-Path $taskRoot 'migration-data\source.json') -Raw | ConvertFrom-Json
$env:ATLAS_BASELINE_PROFILE=$meta.snapshot
$env:ATLAS_TAURI_DATA_DIR=Join-Path $taskRoot 'migration-data\validation-profile'
$env:ATLAS_VALIDATION_SCRIPT=Join-Path $taskRoot 'migration\idle.js'
function Get-AppTree([int]$rootPid){
 $all=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();$null=$ids.Add($rootPid)
 do{$changed=$false;foreach($proc in $all){if($ids.Contains([int]$proc.ParentProcessId)-and -not $ids.Contains([int]$proc.ProcessId)){$null=$ids.Add([int]$proc.ProcessId);$changed=$true}}}while($changed)
 @(foreach($id in $ids){Get-Process -Id $id -ErrorAction SilentlyContinue})
}
$cases=@(
 @{name='Electron 40';file=(Join-Path $taskRoot '..\Atlas\node_modules\electron\dist\electron.exe');arg=('"'+(Join-Path $taskRoot 'migration\baseline.cjs')+'"')},
 @{name='Tauri 2 debug';file=(Join-Path $taskRoot 'src-tauri\target\debug\atlaschat-tauri.exe');arg=$null}
)
$results=@()
foreach($case in $cases){
 $start=[Diagnostics.Stopwatch]::StartNew()
 $options=@{FilePath=$case.file;WorkingDirectory=$taskRoot;PassThru=$true;WindowStyle='Hidden'}
 if($case.arg){$options.ArgumentList=$case.arg}
 $proc=Start-Process @options
 try{
  while($start.Elapsed.TotalSeconds -lt 20){$proc.Refresh();if($proc.HasExited){throw 'Benchmark app exited unexpectedly'};if($proc.MainWindowHandle -ne 0){break};Start-Sleep -Milliseconds 50}
  $windowMs=$start.ElapsedMilliseconds
  Start-Sleep -Seconds 15
  $before=@(Get-AppTree $proc.Id);$cpuBefore=($before|Measure-Object CPU -Sum).Sum
  Start-Sleep -Seconds 5
  $after=@(Get-AppTree $proc.Id);$cpuAfter=($after|Measure-Object CPU -Sum).Sum
  $results+=@{name=$case.name;windowAppearedMs=$windowMs;processes=$after.Count;workingSetMiB=[Math]::Round(($after|Measure-Object WorkingSet64 -Sum).Sum/1MB,1);privateMiB=[Math]::Round(($after|Measure-Object PrivateMemorySize64 -Sum).Sum/1MB,1);idleCpuPercentOfOneCore=[Math]::Round(($cpuAfter-$cpuBefore)/5*100,2)}
 }finally{$null=$proc.CloseMainWindow();if(-not $proc.WaitForExit(10000)){Stop-Process -Id $proc.Id};Start-Sleep -Seconds 2}
}
$results|ConvertTo-Json -Depth 5|Set-Content (Join-Path $taskRoot 'migration-data\performance.json')
$results|ConvertTo-Json -Depth 5
