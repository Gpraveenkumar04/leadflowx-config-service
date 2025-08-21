# Pre-run checklist for LeadFlowX Config Service
Write-Host "`n🔍 Running pre-deployment checks...`n" -ForegroundColor Cyan

# Check if Docker is running
Write-Host "Checking Docker status..." -NoNewline
$dockerStatus = docker info 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Docker is running" -ForegroundColor Green
} else {
    Write-Host "❌ Docker is not running" -ForegroundColor Red
    exit 1
}

# Check if .env file exists
Write-Host "Checking .env file..." -NoNewline
if (Test-Path .\.env) {
    Write-Host "✅ .env file exists" -ForegroundColor Green
} else {
    Write-Host "❌ .env file is missing" -ForegroundColor Red
    exit 1
}

# Clean up existing resources
Write-Host "`nCleaning up existing resources..." -ForegroundColor Yellow
docker-compose down --remove-orphans
docker network rm leadflowx-network 2>$null

# Create network with correct labels
Write-Host "Creating network with correct labels..." -NoNewline
docker network create --label com.docker.compose.network=leadflowx --label com.docker.compose.project=leadflowx leadflowx-network
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Network created successfully" -ForegroundColor Green
} else {
    Write-Host "❌ Failed to create network" -ForegroundColor Red
    exit 1
}

# Verify volumes
Write-Host "Checking Docker volumes..." -NoNewline
$requiredVolumes = @(
    "leadflowx_config_postgres_data",
    "leadflowx_zookeeper_data",
    "leadflowx_zookeeper_log",
    "leadflowx_kafka_data"
)

$missingVolumes = @()
foreach ($volume in $requiredVolumes) {
    $volumeExists = docker volume ls | Select-String $volume
    if (-not $volumeExists) {
        $missingVolumes += $volume
    }
}

if ($missingVolumes.Count -eq 0) {
    Write-Host "✅ All required volumes exist" -ForegroundColor Green
} else {
    Write-Host "❌ Some volumes are missing" -ForegroundColor Red
    Write-Host "Creating missing volumes..."
    foreach ($volume in $missingVolumes) {
        docker volume create $volume
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Created volume: $volume" -ForegroundColor Green
        } else {
            Write-Host "❌ Failed to create volume: $volume" -ForegroundColor Red
            exit 1
        }
    }
}

# Check ports availability
$portsToCheck = @(5434, 8081, 2181, 9092, 9093)
Write-Host "Checking port availability..." -NoNewline
$busyPorts = @()
foreach ($port in $portsToCheck) {
    $portInUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($portInUse) {
        $busyPorts += $port
    }
}

if ($busyPorts.Count -eq 0) {
    Write-Host "✅ All required ports are available" -ForegroundColor Green
} else {
    Write-Host "❌ Some ports are in use: $($busyPorts -join ', ')" -ForegroundColor Red
    Write-Host "Please stop any services using these ports before proceeding."
    exit 1
}

Write-Host "`n✅ All checks passed! You can now start the services.`n" -ForegroundColor Green
Write-Host "To start services, run:" -NoNewline
Write-Host " docker-compose up -d" -ForegroundColor Yellow
