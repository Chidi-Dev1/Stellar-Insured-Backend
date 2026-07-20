import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';
import {
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { Public } from './auth/decorators/public.decorator';

@ApiTags('Application')
@SkipThrottle({ auth: true })
@Controller({ version: VERSION_NEUTRAL })
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
    private readonly db: TypeOrmHealthIndicator,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Retrieve application health and metadata' })
  @ApiOkResponse({ description: 'Returns a basic welcome response' })
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @SkipThrottle({ default: true, auth: true })
  @Get('health')
  @HealthCheck()
  @ApiOperation({ summary: 'Run application health checks' })
  @ApiOkResponse({ description: 'Returns health check status for database and Stellar RPC' })
  getHealth() {
    const stellarRpcUrl = this.configService.get<string>(
      'stellar.horizonUrl',
      'https://horizon-testnet.stellar.org',
    );

    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.http.pingCheck('stellar-rpc', stellarRpcUrl),
    ]);
  }
}
