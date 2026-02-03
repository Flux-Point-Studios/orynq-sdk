$ErrorActionPreference = "Stop"

Write-Host "`n1) Installing OpenClaw (official)...`n" -ForegroundColor Cyan

$hasWsl = (Get-Command wsl -ErrorAction SilentlyContinue) -ne $null
if (-not $hasWsl) {
  Write-Host "WSL not found. Install WSL or Git Bash, then run:" -ForegroundColor Yellow
  Write-Host "curl -fsSL https://openclaw.ai/install.sh | bash"
  exit 1
}

wsl bash -lc "curl -fsSL https://openclaw.ai/install.sh | bash"

Write-Host "`n2) Installing Orynq OpenClaw integration...`n" -ForegroundColor Cyan

$hasNode = (Get-Command node -ErrorAction SilentlyContinue) -ne $null
if (-not $hasNode) {
  Write-Host "Node.js not found. Install Node.js 18+ then rerun." -ForegroundColor Yellow
  exit 1
}

npx --yes @fluxpointstudios/orynq-openclaw@latest install --service

Write-Host "`nDone.`n" -ForegroundColor Green
Write-Host "Next:"
Write-Host "  - Put your key in: %APPDATA%\orynq-openclaw\service.env"
Write-Host "  - Check status:   orynq-openclaw status"
Write-Host "  - Tail logs:      orynq-openclaw logs -f"
