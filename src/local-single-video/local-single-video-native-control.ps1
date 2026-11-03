param([int]$OwnerPid,[ValidateSet('check','focus','restore')][string]$Action,[double]$Seconds=0,[double]$Duration=0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$browser = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'msedge.exe' AND ParentProcessId = $OwnerPid" | Where-Object { $_.CommandLine -match '--user-data-dir=.*educoder-local-study-control.*browser-profile-edge' })
if ($browser.Count -ne 1) { throw 'OWNED_BROWSER_UNAVAILABLE' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$browser[0].ProcessId)
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
if ($windows.Count -ne 1) { throw 'OFFICIAL_WINDOW_AMBIGUOUS' }
if ($Action -eq 'focus') { $windows[0].SetFocus() }
if ($Action -eq 'restore') {
  if ($Seconds -lt 0 -or $Seconds -gt $Duration) { throw 'INVALID_RESTORE_POSITION' }
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Slider)
  $sliders = $windows[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if ($sliders.Count -ne 1) { throw 'OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS' }
  $range = $sliders[0].GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
  if ($range.Current.IsReadOnly -or [Math]::Abs($range.Current.Maximum - $Duration) -gt 2) { throw 'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE' }
  $range.SetValue($Seconds)
}
[PSCustomObject]@{ BrowserPid = $browser[0].ProcessId; Action = $Action; Seconds = $Seconds } | ConvertTo-Json -Compress
