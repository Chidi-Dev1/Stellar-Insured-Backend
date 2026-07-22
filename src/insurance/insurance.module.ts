import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { ReputationModule } from '../reputation/reputation.module';

import { InsuranceController } from './insurance.controller';

import { InsuranceService } from './insurance.service';
import { PoolService } from './pool.service';
import { ClaimService } from './claim.service';
import { ReinsuranceService } from './reinsurance.service';
import { PricingService } from './pricing.service';
import { AuditService } from './services/audit.service';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';

@Module({
  imports: [DatabaseModule, ReputationModule],
  controllers: [InsuranceController],
  providers: [
    InsuranceService,
    PoolService,
    ClaimService,
    ReinsuranceService,
    PricingService,
    AuditService,
    IdempotencyInterceptor,
  ],
  exports: [
    InsuranceService,
    PoolService,
    ClaimService,
    ReinsuranceService,
    PricingService,
    AuditService,
  ],
})
export class InsuranceModule {}
