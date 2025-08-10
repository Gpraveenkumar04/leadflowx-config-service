param(
    [string]$BaseUrl = "http://localhost:8080",
    [string]$ApiKey = "leadflowx-api-key-2025"
)

Write-Host "LeadFlowX Config/Leads API smoke tests -> $BaseUrl" -ForegroundColor Cyan

$Headers = @{
    Authorization = "Bearer $ApiKey"
    'Content-Type' = 'application/json'
}

function Invoke-Json {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        [object]$Body = $null,
        [switch]$NoAuth
    )
    $url = "$BaseUrl$Path"
    $h = if ($NoAuth) { @{} } else { $Headers }
    if ($Body) { $json = $Body | ConvertTo-Json -Depth 6 } else { $json = $null }
    $resp = Invoke-WebRequest -UseBasicParsing -Method $Method -Headers $h -Body $json -Uri $url -ErrorAction Stop
    return $resp.Content | ConvertFrom-Json
}

function Invoke-WithRetry {
    param(
        [scriptblock]$Action,
        [int]$MaxAttempts = 8,
        [int]$InitialDelayMs = 250,
        [string]$Description = 'operation'
    )
    $attempt = 0
    $delay = $InitialDelayMs
    while ($true) {
        try { return & $Action } catch {
            $attempt++
            if ($attempt -ge $MaxAttempts) { throw "${Description} failed after $attempt attempts: $_" }
            Write-Host "Retry $attempt for $Description after error: $($_.Exception.Message)" -ForegroundColor Yellow
            Start-Sleep -Milliseconds $delay
            $delay = [math]::Min($delay * 2, 5000)
        }
    }
}

# 1. Health (wait until ready)
$health = Invoke-WithRetry -Description 'health check' -Action { Invoke-Json -Path '/health' -NoAuth }
Write-Host "Health:" ($health | ConvertTo-Json -Compress) -ForegroundColor Green

# 2. Insert lead
$lead = @{
    name = 'Smoke Lead'
    company = 'Smoke Co'
    website = 'https://smoke.example.org'
    email = 'smoke+' + [guid]::NewGuid().ToString('N').Substring(0,6) + '@example.org'
    phone = '+1-555-0199'
}
$ingest = Invoke-WithRetry -Description 'lead ingest' -Action { Invoke-Json -Method POST -Path '/v1/lead' -Body $lead }
Write-Host "Ingest:" ($ingest | ConvertTo-Json -Compress) -ForegroundColor Green

Start-Sleep -Seconds 1

# 3. Counts
$count = Invoke-WithRetry -Description 'raw count' -Action { Invoke-Json -Path '/api/leads/raw/count' }
Write-Host "Raw Count:" ($count | ConvertTo-Json -Compress) -ForegroundColor Green

# 4. By source
$bySource = Invoke-WithRetry -Description 'by-source' -Action { Invoke-Json -Path '/api/leads/by-source' }
Write-Host "By Source:" ($bySource | ConvertTo-Json -Compress) -ForegroundColor Green

# 5. Funnel
$funnel = Invoke-WithRetry -Description 'status-funnel' -Action { Invoke-Json -Path '/api/leads/status-funnel' }
Write-Host "Funnel:" ($funnel | ConvertTo-Json -Compress) -ForegroundColor Green

# 6. List
$list = Invoke-WithRetry -Description 'leads list' -Action { Invoke-Json -Path '/api/leads?page=1&pageSize=5' }
Write-Host "List page 1 size 5 =>" ($list.data | Measure-Object | Select-Object -Expand Count) "items" -ForegroundColor Green

Write-Host "Smoke tests complete." -ForegroundColor Cyan
