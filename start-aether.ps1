# One-command launcher for AETHER Proof of Concept (Backend + Holographic C2 UI)
$ErrorActionPreference = "Stop"

Write-Host "=== Booting AETHER Backend (FastAPI + SQLite RAG + 17Hz Telemetry) ===" -ForegroundColor Cyan
$backendDir = Join-Path $PSScriptRoot "backend"
$venvPython = Join-Path $backendDir ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv (Join-Path $backendDir ".venv")
    & $venvPython -m pip install -r (Join-Path $backendDir "requirements.txt")
}

Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd '$backendDir'; & '$venvPython' -m uvicorn app.main:app --reload --port 8765"

Write-Host "=== Booting AETHER Holographic C2 Frontend (Vite + React + Three.js) ===" -ForegroundColor Cyan
$frontendDir = Join-Path $PSScriptRoot "frontend"
if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Push-Location $frontendDir
    npm install
    Pop-Location
}

Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd '$frontendDir'; npm run dev"
Write-Host "AETHER launching -> Open http://localhost:5173" -ForegroundColor Green
