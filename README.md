📘 BACKEND README

(NestJS – Stellar Insured Backend API)

Stellar Insured ⚙️ — Backend API

The Stellar Insured backend is a secure and scalable API layer that supports decentralized insurance operations such as policy management, claims processing, DAO governance, oracle verification, and analytics.

Built with NestJS, this backend serves frontend clients, DAO participants, and third-party integrations, while coordinating off-chain logic such as fraud detection and data aggregation—without compromising the trustless nature of Stellar-based smart contracts.

✨ Core Responsibilities

Insurance policy lifecycle management

Claim submission and verification

DAO proposals, voting, and result tracking

Oracle data ingestion

Fraud detection and monitoring

Analytics and reporting APIs

🗂️ Data Model Notes

Insurance is the primary product domain for this service.

The Prisma schema includes insurance models for pools, policies, claims, reinsurance contracts, and audit logs. Legacy project/contribution models remain in place because the Stellar event indexer, reputation scoring, and notification flows still depend on them while the broader data layer is being consolidated.

## 🗑️ Soft-Delete Policy

All 20 tracked models use **soft-delete by default**: deleting a record stamps
`deletedAt` with the current timestamp rather than issuing a SQL `DELETE`. The
Prisma middleware (`createSoftDeleteMiddleware`) enforces this transparently —
every standard `findMany`, `findUnique`, `update`, and `delete` call is already
covered. Hard deletes (permanent removal) are restricted to `SoftDeleteService`
and explicitly approved GDPR/admin paths, and always write an `AuditLog` entry.

For the full lifecycle model, query conventions, repository patterns, restore
vs. purge rules, and instructions for adding a new model, see
**[SOFT_DELETE_GUIDE.md](SOFT_DELETE_GUIDE.md)**.

## 🏗️ Database Architecture

**Prisma is the single source of truth** for all database access across this application:
- All models (User, InsurancePolicy, Claim, InsurancePool, Project, Notification, etc.) are defined in `prisma/schema.prisma`
- All services inject `PrismaService` from `DatabaseModule` for data access
- All schema migrations use `prisma/migrations/` with Prisma CLI tools
- Zero TypeORM or other ORM dependencies

This decision ensures:
- ✅ Consistent data access patterns across all domains
- ✅ Unified schema management and migration strategy
- ✅ Simplified onboarding and maintenance
- ✅ Reduced risk of data consistency bugs

For migration details, see [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md).

🧑‍💻 Tech Stack

Framework: NestJS

Language: TypeScript

Runtime: Node.js 18+

Database: PostgreSQL or MongoDB

Cache: Redis

Testing: Jest, Supertest

Deployment: Docker, Cloud providers

📦 Installation & Setup
Prerequisites

Node.js 18+

npm

PostgreSQL or MongoDB

Redis

Environment Setup
cp .env.example .env


Example environment variables:

PORT=4000
DATABASE_URL=postgres://user:password@localhost:5432/stellar_insured
REDIS_URL=redis://localhost:6379

STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

Running the Server
# Install dependencies
npm install

# Development mode
npm run start:dev

# Production mode
npm run start:prod

🧪 Testing
# Unit tests
npm run test

# End-to-end tests
npm run test:e2e

# Test coverage
npm run test:cov

🌐 API Documentation

Swagger UI: http://localhost:4000/api/docs

## 🏥 Health Checks

Robust health checks for all external dependencies enable reliable deployment orchestration, traffic routing, and incident triage.

### Endpoints

| Endpoint | Purpose | When 200 | When 207 | When 503 |
|----------|---------|----------|----------|----------|
| `GET /health/live` | Liveness | Process alive | Never | Process dead/hung |
| `GET /health/ready` | Readiness | All required deps up | N/A | Any required dep down |
| `GET /health` | Full status | All deps up | Required up, optional down | Any required dep down |

### Dependency Classification

| Dependency | Classification | Why | Health Check |
|-----------|---------------|-----|--------------|
| **PostgreSQL** | **REQUIRED** | All data access and persistence | `SELECT 1` within 3s |
| **Redis** | **REQUIRED** | Session management, caching, Bull queue backend | `PING` within 2s |
| **Bull Queue** | **REQUIRED** | Job processing (email, push, IPFS pinning) | `getJobCounts()` within 3s |
| S3 Storage | Optional | File uploads fail, but app continues | `HeadBucket` within 5s |
| SendGrid | Optional | Notification delivery may succeed later | API key validation within 5s |
| Memory | System | Process health | Heap < 512 MB |

### Health States

- **200 (Healthy)**: All required dependencies up; optional dependencies irrelevant
- **207 (Degraded)**: All required dependencies up; one or more optional dependencies down
- **503 (Unhealthy)**: One or more required dependencies down; app cannot process requests

### Usage Examples

#### Kubernetes Liveness & Readiness Probes

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 60
  periodSeconds: 30
  timeoutSeconds: 10
  failureThreshold: 3
```

#### Load Balancer Health Check

```bash
# Remove instance from rotation if readiness fails
curl -f http://localhost:3000/health/ready
```

#### Incident Triage

```bash
# Step 1: Check readiness (quick diagnosis)
curl http://localhost:3000/health/ready
# If 503: a required dependency is down

# Step 2: Get detailed status (identify which one)
curl http://localhost:3000/health
# Response includes per-dependency error details:
# {
#   "status": "error",
#   "info": { "database": {...}, "redis": {...}, "queue": {...} },
#   "error": { "database": { "error": "Connection refused" } }
# }
```

#### Operational Dashboard

```bash
# Full system status with all dependency details
curl http://localhost:3000/health | jq .

# Response structure:
# {
#   "status": "ok" | "degraded" | "error",
#   "info": {
#     "database": { "status": "up", "type": "postgresql", "message": "Database query successful" },
#     "redis": { "status": "up", "type": "redis", "message": "Redis PING successful" },
#     "queue": { "status": "up", "type": "bull", "jobCounts": { "active": 0, "waiting": 2, ... } },
#     "storage": { "status": "up", "type": "s3", "bucket": "my-bucket" },
#     "notifications": { "status": "up", "type": "sendgrid", "message": "SendGrid API key is valid" },
#     "memory_heap": { "status": "up" }
#   },
#   "error": {
#     "storage": { "status": "down", "error": "Connection timeout" }  # Only if degraded
#   }
# }
```

### Docker Compose

Health checks are pre-configured in `docker-compose.yml`:

```yaml
services:
  postgres:
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d stellar_insured"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  redis:
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

  app:
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
```

Start the stack with health checks:

```bash
docker-compose up
# App will not start until postgres and redis are healthy
# App will not mark as healthy until /health/ready returns 200
```

### Monitoring & Alerting

**Recommended alerts:**

- **Critical**: `/health/ready` returns 503 for > 2 minutes → page on-call
- **Warning**: `/health` returns 207 (degraded) for > 15 minutes → investigate optional dependency
- **Info**: Document `/health` response every minute for trend analysis

**Example Prometheus metrics scrape:**

```yaml
- job_name: 'stellar-insured-health'
  static_configs:
    - targets: ['localhost:3000']
  metrics_path: '/health'
  scrape_interval: 30s
```

### Troubleshooting

**503 Database down:**
```bash
curl http://localhost:3000/health
# Error: "Database health check timeout after 3000ms"
# → Check PostgreSQL is running: docker-compose ps postgres
# → Check connection string: echo $DATABASE_URL
```

**503 Redis down:**
```bash
curl http://localhost:3000/health
# Error: "Redis health check failed: Connection refused"
# → Check Redis is running: docker-compose ps redis
# → Check connection string: echo $REDIS_URL
```

**503 Bull Queue down:**
```bash
curl http://localhost:3000/health
# Error: "Bull queue health check failed: Redis connection refused"
# → Bull depends on Redis; fix Redis first
```

**207 S3 degraded:**
```bash
curl http://localhost:3000/health
# Status: degraded, storage error: "Invalid AWS credentials"
# → S3 is optional; app continues to function
# → Uploads will fail; fix AWS config when ready
# → Use: echo $AWS_S3_BUCKET to verify config
```

**207 SendGrid degraded:**
```bash
curl http://localhost:3000/health
# Status: degraded, notifications error: "SendGrid API key not configured"
# → SendGrid is optional; app continues
# → Queued notifications remain in queue; delivery will retry later
# → Fix: set notification.sendgrid.apiKey in config
```

⚠️ **Error Handling**

All endpoints return standardized error responses. Clients should inspect the
`errorCode` field (see `ERROR_CODES.md`) and present the accompanying
`message` to users. Transient failures are automatically retried by internal
clients and downstream circuits prevent cascading outages.

🤝 Contributing

Fork the repository

Create a feature branch

Add tests for new features

Open a Pull Request

📚 Resources

NestJS Docs: https://docs.nestjs.com

Stellar Docs: https://developers.stellar.org

Soroban Docs: https://soroban.stellar.org/docs
