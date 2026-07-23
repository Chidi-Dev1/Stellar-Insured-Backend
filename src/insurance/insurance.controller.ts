import { Controller, Post, Param, Body, UseInterceptors, Version } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { InsuranceService } from './insurance.service';
import { ClaimService } from './claim.service';
import { ReinsuranceService } from './reinsurance.service';
import { PurchasePolicyDto } from './dto/purchase-policy.dto';
import { CreateReinsuranceDto } from './dto/create-reinsurance.dto';
import { ClaimIdDto } from '../common/dto/claim-id.dto';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';

@SkipThrottle({ auth: true })
@Controller({ path: 'insurance', version: '1' })
export class InsuranceController {
  constructor(
    private readonly insurance: InsuranceService,
    private readonly claims: ClaimService,
    private readonly reinsurance: ReinsuranceService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 3600000 } }) // 10 purchases per hour
  @Version('1')
  @Post('purchase')
  @UseInterceptors(IdempotencyInterceptor)
  async purchase(@Body() dto: PurchasePolicyDto) {
    return this.insurance.purchasePolicy(dto.userId, dto.poolId, dto.riskType, dto.coverageAmount);
  }

  @Throttle({ default: { limit: 50, ttl: 3600000 } }) // 50 claim assessments per hour
  @Version('1')
  @Post('claims/:claimId/assess')
  @Throttle({ admin: { limit: 100, ttl: 60000 } }) // 100 assessments per minute for admins
  @UseInterceptors(IdempotencyInterceptor)
  async assessClaim(@Param() params: ClaimIdDto) {
    return this.claims.assessClaim(params.claimId);
  }

  @Throttle({ default: { limit: 30, ttl: 3600000 } }) // 30 claim payments per hour
  @Version('1')
  @Post('claims/:claimId/pay')
  @Throttle({ admin: { limit: 50, ttl: 60000 } }) // 50 payouts per minute for admins
  @UseInterceptors(IdempotencyInterceptor)
  async payClaim(@Param() params: ClaimIdDto) {
    return this.claims.payClaim(params.claimId);
  }

  @Throttle({ default: { limit: 5, ttl: 3600000 } }) // 5 reinsurance contracts per hour
  @Version('1')
  @Post('reinsurance')
  @Throttle({ admin: { limit: 20, ttl: 60000 } }) // 20 contracts per minute for admins
  @UseInterceptors(IdempotencyInterceptor)
  async createReinsurance(@Body() dto: CreateReinsuranceDto) {
    return this.reinsurance.createContract(dto.poolId, dto.coverageLimit, dto.premiumRate);
  }
}
