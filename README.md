# leadflowx-config-service

Dynamic configuration & lead ingestion API (Fastify + Prisma + Kafka + Postgres).

## Local Stack (Postgres + Kafka + Zookeeper + API)

Prereqs: Docker Desktop, existing external network `leadflowx-network` (created already by other services). If missing:

```powershell
docker network create leadflowx-network
```

Bring everything up (PowerShell):

```powershell
docker compose up -d --build
```

Watch logs:

```powershell
docker compose logs -f leadflowx-config-service
```

The API will retry Kafka until the broker is healthy; Kafka broker logs appear under the `kafka` container.

## Auth

All endpoints except `/health` and `/metrics` require header:

```
Authorization: Bearer leadflowx-api-key-2025
```

## PowerShell Smoke Tests

```powershell
$h = @{ Authorization = 'Bearer leadflowx-api-key-2025'; 'Content-Type'='application/json' }

# Health (no auth needed)
Invoke-WebRequest -UseBasicParsing http://localhost:8080/health | Select-Object -ExpandProperty Content

# Insert a lead
$body = @{ name='Sample Lead'; company='Sample Co'; website='https://example.org'; email='sample@example.org'; phone='+1-555-0101' } | ConvertTo-Json
Invoke-WebRequest -UseBasicParsing -Headers $h -Method POST -Body $body http://localhost:8080/v1/lead | Select-Object -ExpandProperty Content

# Counts
Invoke-WebRequest -UseBasicParsing -Headers $h http://localhost:8080/api/leads/raw/count | Select-Object -ExpandProperty Content

# List
Invoke-WebRequest -UseBasicParsing -Headers $h 'http://localhost:8080/api/leads?page=1&pageSize=25' | Select-Object -ExpandProperty Content
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| API_KEY | Auth bearer token | leadflowx-api-key-2025 |
| DATABASE_URL | Prisma Postgres URL | postgresql://postgres:postgres@postgres:5432/leadflowx |
| KAFKA_BROKERS | Override Kafka broker list | kafka:9092 |

## Future Enhancements

- Topic creation bootstrap & schema registry integration
- DLQ consumer & replay endpoint
- Metrics: request latency histogram & Kafka publish duration
- Structured OpenTelemetry tracer
