import { Controller, Post, Body, HttpCode, HttpStatus, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Public } from './decorators/public.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.CREATED) // e2e tests expect 201 Created
  @ApiOperation({ summary: 'Login with userId and a valid nonce' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 201, description: 'Successfully authenticated, returns JWT token' })
  @ApiResponse({ status: 400, description: 'Invalid or used nonce' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async login(@Body() loginDto: LoginDto) {
    try {
      return await this.authService.validateUserAndLogin(loginDto);
    } catch (error) {
      if (error instanceof BadRequestException || error.status === HttpStatus.BAD_REQUEST || error.name === 'BadRequestException') {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }
  }
}
