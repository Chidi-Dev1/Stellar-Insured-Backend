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
