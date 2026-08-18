import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { NonceService } from '../nonce/nonce.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly nonceService: NonceService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUserAndLogin(loginDto: LoginDto) {
    const { userId, nonce } = loginDto;

    // Validate the nonce (throws BadRequestException if invalid/used)
    await this.nonceService.consumeNonce(nonce);

    // Ensure the user exists
    let user;
    try {
      user = await this.userService.findById(userId);
    } catch (error) {
      this.logger.warn(`Login attempt for non-existent user: ${userId}`);
      throw new UnauthorizedException('Invalid user');
    }

    // Generate JWT token
    const payload = { sub: user.id };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
