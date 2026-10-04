<#
  Shows every Elastic Beanstalk environment in your account/region with its health,
  plus a live check of each URL.  Run:  powershell -ExecutionPolicy Bypass -File scripts\eb-status.ps1
#>
param([string]$Region = "")
$ErrorActionPreference = "Continue"
if (-not $Region) { $Region = (& aws configure get region 2>$null) }
if (-not $Region) { $Region = "us-east-1" }

$json = & aws elasticbeanstalk describe-environments --no-include-deleted --region $Region --output json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Could not list environments: $json" -ForegroundColor Red; exit 1 }
$envs = ($json | Out-String | ConvertFrom-Json).Environments
if (-not $envs) { Write-Host "No Elastic Beanstalk environments in $Region." -ForegroundColor Yellow; exit 0 }

Write-Host ""
Write-Host "Elastic Beanstalk environments in $Region  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" -ForegroundColor Cyan
$rows = foreach ($e in $envs) {
  $url = "http://$($e.CNAME)"
  $live = try { (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15).StatusCode } catch { "error" }
  [pscustomobject]@{
    Application = $e.ApplicationName
    Environment = $e.EnvironmentName
    Status      = $e.Status
    Health      = $e.Health
    HTTP        = $live
    Version     = $e.VersionLabel
    URL         = $url
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
foreach ($r in $rows) {
  $color = if ($r.Health -eq "Green" -and $r.HTTP -eq 200) { "Green" } else { "Yellow" }
  Write-Host ("  {0,-22} health={1,-6} live={2}  {3}" -f $r.Environment, $r.Health, $r.HTTP, $r.URL) -ForegroundColor $color
}
