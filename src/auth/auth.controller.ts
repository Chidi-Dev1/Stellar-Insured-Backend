import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Version,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService, TokenPairResponse } from './auth.service';
import { WalletLoginDto } from './dto/wallet-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/wallet-login
   *
   * Authenticate a user via a nonce-signed wallet challenge.
   * Returns a short-lived access token and a rotatable refresh token.
   *
   * The nonce must have been obtained via POST /nonce and must be
   * bound to the specified userId.  Replaying a used or expired nonce
   * is rejected atomically.
   */
  @Public()
  @Version('1')
  @Post('wallet-login')
  @SkipThrottle({ default: true })
  @Throttle({ auth: {} })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Authenticate via wallet-signed nonce' })
  @ApiOkResponse({
    description: 'Access and refresh tokens issued successfully',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or reused nonce' })
  async walletLogin(
    @Body() dto: WalletLoginDto,
    @Req() req: Request,
  ): Promise<TokenPairResponse> {
    return this.authService.walletLogin(
      dto.userId,
      dto.nonce,
      dto.fingerprint,
      req.ip,
    );
  }

  /**
   * POST /auth/refresh
   *
   * Rotate a refresh token: the old token is revoked and a new pair
   * is issued.  Reuse of an already-rotated token triggers family-wide
   * revocation (abuse detection).
   */
  @Public()
  @Version('1')
  @Post('refresh')
  @SkipThrottle({ default: true })
  @Throttle({ auth: {} })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  @ApiOkResponse({
    description: 'New access and refresh tokens issued',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid, expired, or reused token' })
  async refreshTokens(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<TokenPairResponse> {
    return this.authService.refreshTokens(
      dto.refresh_token,
      dto.fingerprint,
      req.ip,
    );
  }

  /**
   * POST /auth/logout
   *
   * Revoke refresh tokens.  If a specific token is provided, only that
   * token is revoked; otherwise all tokens for the authenticated user
   * are revoked (full logout).
   */
  @Version('1')
  @Post('logout')
  @SkipThrottle({ default: true })
  @Throttle({ auth: {} })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke refresh tokens (logout)' })
  @ApiOkResponse({ description: 'Tokens revoked successfully' })
  async logout(
    @Body() dto: LogoutDto,
    @Req() req: Request,
  ): Promise<{ revoked: number }> {
    const userId = (req as any).user?.id;
    return this.authService.logout(userId, dto.refresh_token, req.ip);
  }
}
