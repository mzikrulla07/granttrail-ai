<#
  GrantTrail AI - one-time AWS Elastic Beanstalk + GitHub setup (Windows PowerShell).

  Run from the granttrail-ai folder:
      powershell -ExecutionPolicy Bypass -File scripts\setup-aws.ps1

  It is safe to run again: every step checks what already exists.
  What it does:
    1. Checks your AWS CLI sign-in and region
    2. Makes sure the standard Elastic Beanstalk roles exist
    3. Creates a NEW Elastic Beanstalk application + environment
       (Node.js 22, single instance, t3.micro, no load balancer)
    4. Lets GitHub Actions deploy without storing AWS keys (OIDC role limited to this repo's main branch)
    5. Creates the GitHub repo, commits and pushes -> GitHub Actions builds, tests and deploys
    6. Waits for the deploy, then shows the live URL and the health of ALL your EB environments
  No secrets are printed or written to the repository.
#>
param(
  [string]$GitHubUser = "mzikrulla07",
  [string]$RepoName = "granttrail-ai",
  [string]$AppName = "GrantTrail-AI",
  [string]$EnvName = "GrantTrail-AI-env",
  [string]$Region = ""
)

$ErrorActionPreference = "Continue"
$RoleName = "granttrail-github-deploy"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Tmp = Join-Path $env:TEMP "granttrail-setup"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host ""; Write-Host "STOPPED: $msg" -ForegroundColor Red; exit 1 }

# Run the AWS CLI; returns @{ Code; Out }. Never throws on stderr (Windows PowerShell 5.1 safe).
function AwsTry {
  $out = & aws.exe @args 2>&1
  return @{ Code = $LASTEXITCODE; Out = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
}
function AwsMust {
  $r = AwsTry @args
  if ($r.Code -ne 0) { Fail "aws $($args -join ' ')`n$($r.Out)" }
  return $r.Out
}
function WriteJson($name, $json) {
  $path = Join-Path $Tmp $name
  [System.IO.File]::WriteAllText($path, $json)   # UTF-8 without BOM
  return "file://$path"
}

# ---------------------------------------------------------------- 1. tools + identity
Step "Checking tools and your AWS sign-in"
if (-not (Get-Command aws.exe -ErrorAction SilentlyContinue)) { Fail "AWS CLI not found. Install it from https://aws.amazon.com/cli/ and run 'aws configure'." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Git not found. Install it from https://git-scm.com/download/win" }
if (-not (Test-Path "package.json") -or -not (Test-Path "deploy/github-actions-deploy.yml")) { Fail "Run this from the granttrail-ai folder." }

$Account = AwsMust sts get-caller-identity --query Account --output text
if (-not $Region) { $Region = (AwsTry configure get region).Out }
if (-not $Region) { $Region = "us-east-1" }
$env:AWS_DEFAULT_REGION = $Region
Ok "AWS account $Account, region $Region"

# ---------------------------------------------------------------- 2. EB roles
Step "Checking the standard Elastic Beanstalk roles"
$ec2Role = "aws-elasticbeanstalk-ec2-role"
if ((AwsTry iam get-instance-profile --instance-profile-name $ec2Role).Code -ne 0) {
  $trust = WriteJson "ec2-trust.json" '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  if ((AwsTry iam get-role --role-name $ec2Role).Code -ne 0) { AwsMust iam create-role --role-name $ec2Role --assume-role-policy-document $trust | Out-Null }
  AwsMust iam attach-role-policy --role-name $ec2Role --policy-arn arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier | Out-Null
  AwsMust iam create-instance-profile --instance-profile-name $ec2Role | Out-Null
  AwsMust iam add-role-to-instance-profile --instance-profile-name $ec2Role --role-name $ec2Role | Out-Null
  Write-Host "    created $ec2Role (waiting 15 s for IAM to propagate)"; Start-Sleep 15
}
Ok "instance profile $ec2Role"

$svcRole = "aws-elasticbeanstalk-service-role"
# Always (re)apply the standard trust policy: a pre-existing role with a different trust
# policy makes EB suspend health monitoring ("Unable to assume role" -> Grey health).
$trust = WriteJson "svc-trust.json" '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"elasticbeanstalk.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"sts:ExternalId":"elasticbeanstalk"}}}]}'
if ((AwsTry iam get-role --role-name $svcRole).Code -ne 0) {
  AwsMust iam create-role --role-name $svcRole --assume-role-policy-document $trust | Out-Null
  Write-Host "    created $svcRole"; Start-Sleep 10
} else {
  AwsMust iam update-assume-role-policy --role-name $svcRole --policy-document $trust | Out-Null
}
AwsMust iam attach-role-policy --role-name $svcRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth | Out-Null
AwsMust iam attach-role-policy --role-name $svcRole --policy-arn arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy | Out-Null
Ok "service role $svcRole"

# ---------------------------------------------------------------- 3. EB application + environment
Step "Creating the Elastic Beanstalk application '$AppName'"
$exists = AwsMust elasticbeanstalk describe-applications --application-names $AppName --query "length(Applications)" --output text
if ($exists -eq "0") {
  AwsMust elasticbeanstalk create-application --application-name $AppName --description "GrantTrail AI - Subaward Reporting Assistant (AIML-515)" | Out-Null
  Ok "application created"
} else { Ok "application already exists" }

Step "Creating environment '$EnvName' (Node.js, single instance, t3.micro, no load balancer)"
$envStatus = (AwsTry elasticbeanstalk describe-environments --application-name $AppName --environment-names $EnvName --no-include-deleted --query "Environments[0].Status" --output text).Out
if ($envStatus -and $envStatus -ne "None") {
  Ok "environment already exists (status: $envStatus)"
} else {
  $stack = AwsMust elasticbeanstalk list-available-solution-stacks --query "SolutionStacks[?contains(@, 'Amazon Linux 2023') && contains(@, 'Node.js 22')] | [0]" --output text
  if (-not $stack -or $stack -eq "None") { Fail "No 'Node.js 22 on Amazon Linux 2023' platform found in $Region." }
  Ok "platform: $stack"

  $prefix = $null
  foreach ($candidate in @("granttrail-ai", "granttrail-ai-$($Account.Substring($Account.Length - 4))", "granttrail-ai-$(Get-Random -Minimum 1000 -Maximum 9999)")) {
    if ((AwsMust elasticbeanstalk check-dns-availability --cname-prefix $candidate --query Available --output text) -eq "True") { $prefix = $candidate; break }
  }
  if (-not $prefix) { Fail "Could not find a free URL prefix." }
  Ok "URL will be http://$prefix.$Region.elasticbeanstalk.com"

  $options = WriteJson "options.json" @"
[
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"EnvironmentType","Value":"SingleInstance"},
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"ServiceRole","Value":"$svcRole"},
  {"Namespace":"aws:ec2:instances","OptionName":"InstanceTypes","Value":"t3.micro"},
  {"Namespace":"aws:autoscaling:launchconfiguration","OptionName":"IamInstanceProfile","Value":"$ec2Role"},
  {"Namespace":"aws:autoscaling:launchconfiguration","OptionName":"DisableIMDSv1","Value":"true"},
  {"Namespace":"aws:elasticbeanstalk:healthreporting:system","OptionName":"SystemType","Value":"basic"},
  {"Namespace":"aws:elasticbeanstalk:managedactions","OptionName":"ManagedActionsEnabled","Value":"false"}
]
"@
  AwsMust elasticbeanstalk create-environment --application-name $AppName --environment-name $EnvName `
    --solution-stack-name $stack --cname-prefix $prefix --tier "Name=WebServer,Type=Standard" `
    --option-settings $options | Out-Null
  Ok "environment creation started (it starts with the AWS sample app)"
}

# ---------------------------------------------------------------- 4. GitHub -> AWS trust (OIDC, no stored keys)
Step "Letting GitHub Actions deploy without AWS keys (OIDC role '$RoleName')"
$oidcArn = "arn:aws:iam::${Account}:oidc-provider/token.actions.githubusercontent.com"
if ((AwsTry iam get-open-id-connect-provider --open-id-connect-provider-arn $oidcArn).Code -ne 0) {
  AwsMust iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com `
    --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd | Out-Null
  Ok "GitHub OIDC provider added to your account"
} else { Ok "GitHub OIDC provider already present" }

# GitHub's OIDC "sub" claim: older repos use "repo:owner/name:ref:...", repos created after
# July 2026 use the immutable "repo:owner@<repo id>:ref:...". Trust both (main branch only).
$subs = @("repo:$GitHubUser/${RepoName}:ref:refs/heads/main")
try {
  $repoId = (Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubUser/$RepoName" -TimeoutSec 15).id
  if ($repoId) { $subs += "repo:*@${repoId}:ref:refs/heads/main" }
} catch { Write-Host "    (repo not on GitHub yet - re-run this script after the first push to add its ID)" -ForegroundColor Yellow }
$subJson = ($subs | ForEach-Object { '"' + $_ + '"' }) -join ","
$trust = WriteJson "gh-trust.json" @"
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$oidcArn"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},"StringLike":{"token.actions.githubusercontent.com:sub":[$subJson]}}}]}
"@
if ((AwsTry iam get-role --role-name $RoleName).Code -ne 0) {
  AwsMust iam create-role --role-name $RoleName --assume-role-policy-document $trust --description "GitHub Actions deploy for $GitHubUser/$RepoName (main branch only)" | Out-Null
} else {
  AwsMust iam update-assume-role-policy --role-name $RoleName --policy-document $trust | Out-Null
}
AwsMust iam attach-role-policy --role-name $RoleName --policy-arn arn:aws:iam::aws:policy/AdministratorAccess-AWSElasticBeanstalk | Out-Null
Ok "role $RoleName trusts only $GitHubUser/$RepoName (main)"

# Install the GitHub Actions workflow and fill in the account + region (not secrets).
$wf = ".github/workflows/deploy.yml"
New-Item -ItemType Directory -Force -Path (Join-Path $Root ".github/workflows") | Out-Null
$text = [System.IO.File]::ReadAllText((Join-Path $Root "deploy/github-actions-deploy.yml"))
$text = $text -replace "__AWS_REGION__", $Region -replace "__AWS_ACCOUNT_ID__", $Account
$text = $text -replace "(?m)^(\s*AWS_REGION:\s*)\S+$", "`${1}$Region"
$text = $text -replace "arn:aws:iam::\d{12}:role/", "arn:aws:iam::${Account}:role/"
[System.IO.File]::WriteAllText((Join-Path $Root $wf), $text)
Ok "workflow configured for account $Account / $Region"

# ---------------------------------------------------------------- 5. wait for environment before first deploy
Step "Waiting for the environment to finish launching (about 3-6 minutes)"
for ($i = 0; $i -lt 60; $i++) {
  $s = (AwsTry elasticbeanstalk describe-environments --environment-names $EnvName --no-include-deleted --query "Environments[0].[Status,Health]" --output text).Out
  Write-Host "    $s"
  if ($s -match "^Ready") { break }
  Start-Sleep 15
}
if ($s -notmatch "^Ready") { Fail "Environment did not become Ready. Check the Elastic Beanstalk console -> $EnvName -> Events." }
Ok "environment ready"

# ---------------------------------------------------------------- 6. git + GitHub
Step "Committing the code"
if (-not (Test-Path ".git")) { git init -b main | Out-Null }
git add -A
git update-index --chmod=+x scripts/build-eb-bundle.sh .platform/hooks/predeploy/01_data_dir.sh .platform/confighooks/predeploy/01_data_dir.sh 2>$null
$secretFiles = git diff --cached --name-only | Where-Object { $_ -match '(^|/)\.env$' -or $_ -match '(^|/)\.env\.(?!example$)' }
if ($secretFiles) { Fail ".env is staged for commit - aborting so your API key is never pushed." }
$pending = git status --porcelain
if ($pending) {
  git commit -q -m "GrantTrail AI: production build + Elastic Beanstalk auto-deploy via GitHub Actions"
  if ($LASTEXITCODE -ne 0) { Fail "git commit failed. Set your name/email first:  git config --global user.name 'Your Name'  and  git config --global user.email you@example.com" }
  Ok "committed $(git rev-parse --short HEAD)"
} else { Ok "nothing new to commit" }
git branch -M main

$repoUrl = "https://github.com/$GitHubUser/$RepoName"
Step "Creating the GitHub repository $repoUrl"
$remote = (git remote get-url origin 2>$null)
if (-not $remote) {
  if ((Get-Command gh -ErrorAction SilentlyContinue) -and ((gh auth status 2>&1) -match "Logged in")) {
    gh repo create "$GitHubUser/$RepoName" --public --description "GrantTrail AI - subaward reporting assistant (AI extracts. Code validates. Humans approve.)" | Out-Null
  } else {
    Write-Host "    Your browser will open. Create an EMPTY public repo named '$RepoName' (no README, no .gitignore)." -ForegroundColor Yellow
    Start-Process "https://github.com/new?name=$RepoName&visibility=public&description=GrantTrail+AI+-+subaward+reporting+assistant"
    Read-Host "    Press Enter after you click 'Create repository'"
  }
  git remote add origin "$repoUrl.git"
}
Step "Pushing to GitHub (this starts the GitHub Actions deploy)"
git push -u origin main
if ($LASTEXITCODE -ne 0) { Fail "git push failed. Sign in to GitHub when prompted, then run this script again." }
Ok "pushed - watch it at $repoUrl/actions"

# ---------------------------------------------------------------- 7. wait for deploy + show health
Step "Waiting for GitHub Actions to test, build and deploy (about 5-10 minutes)"
for ($i = 0; $i -lt 80; $i++) {
  $s = (AwsTry elasticbeanstalk describe-environments --environment-names $EnvName --no-include-deleted --query "Environments[0].[Status,Health,VersionLabel]" --output text).Out
  Write-Host "    $s"
  if ($s -match "^Ready\s+\S+\s+gh-") { break }
  Start-Sleep 15
}
& (Join-Path $PSScriptRoot "eb-status.ps1") -Region $Region
