import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { EncryptionService } from '../encryption/encryption.service';
import {
  sanitizeString,
  sanitizeObject,
  isValidCuid,
  isValidWalletAddress,
} from '../common/utils/sanitization.util';
import { Prisma, User } from '@prisma/client';

export interface PaginatedUsers {
  data: User[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async findById(id: string): Promise<User> {
    // Validate ID format before querying database
    if (!isValidCuid(id)) {
      throw new BadRequestException('Invalid user ID format');
    }

    // The soft-delete middleware already filters deleted rows; the explicit
    // deletedAt filter is defense-in-depth so this query stays correct even
    // if the middleware is bypassed or misconfigured.
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    // Decrypt sensitive fields
    return this.decryptUser(user);
  }

  async findByWallet(walletAddress: string): Promise<User> {
    // Validate wallet address format before querying database
    if (!isValidWalletAddress(walletAddress)) {
      throw new BadRequestException('Invalid wallet address format');
    }

    const sanitizedAddress = sanitizeString(walletAddress);

    const user = await this.prisma.user.findFirst({
      where: {
        walletAddress: sanitizedAddress,
        deletedAt: null,
      },
    });
    if (!user) {
      throw new NotFoundException(
        `User with wallet address ${sanitizedAddress} not found`,
      );
    }
    // Decrypt sensitive fields
    return this.decryptUser(user);
  }

  async findPaginated(page = 1, limit = 20): Promise<PaginatedUsers> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const offset = Math.max(page - 1, 0) * safeLimit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { deletedAt: null },
        skip: offset,
        take: safeLimit,
      }),
      this.prisma.user.count({
        where: { deletedAt: null },
      }),
    ]);

    return {
      data: users.map(user => this.decryptUser(user)),
      meta: {
        page,
        limit: safeLimit,
        total,
        totalPages: Math.max(Math.ceil(total / safeLimit), 1),
      },
    };
  }

  async create(walletAddress: string, email?: string): Promise<User> {
    // Validate wallet address format
    if (!isValidWalletAddress(walletAddress)) {
      throw new BadRequestException('Invalid wallet address format');
    }

    const sanitizedAddress = sanitizeString(walletAddress);

    // Check if user exists (wallet address is public identifier, not encrypted)
    const existingUser = await this.prisma.user.findUnique({
      where: { walletAddress: sanitizedAddress },
    });

    if (existingUser) {
      throw new ConflictException(
        'User with this wallet address already exists',
      );
    }

    // Encrypt email for privacy
    const sanitizedEmail = email ? sanitizeString(email) : null;
    const encryptedEmail = sanitizedEmail
      ? this.encryption.encrypt(sanitizedEmail)
      : null;

    const user = await this.prisma.$transaction(async tx => {
      return tx.user.create({
        data: {
          walletAddress: sanitizedAddress,
          email: encryptedEmail,
          notificationSettings: {
            create: {},
          },
        },
        include: { notificationSettings: true },
      });
    });
    return user;
  }

  async update(id: string, updateData: UpdateUserDto): Promise<User> {
    // Validate ID format
    if (!isValidCuid(id)) {
      throw new BadRequestException('Invalid user ID format');
    }

    await this.findById(id); // Ensure user exists

    // Build sanitized update payload with explicit property selection
    // This prevents mass assignment by only allowing known safe fields
    const data: Prisma.UserUpdateInput = {};

    if (updateData.email !== undefined) {
      data.email = this.encryption.encrypt(sanitizeString(updateData.email));
    }

    if (updateData.profileData !== undefined) {
      // profileData is already validated by DTO (ProfileDataDto)
      // Apply an additional sanitization pass for defense-in-depth
      data.profileData = this.toJsonInput(
        sanitizeObject(updateData.profileData),
      );
    }

    if (updateData.pushSubscription !== undefined) {
      data.pushSubscription = this.encryption.encrypt(
        sanitizeString(updateData.pushSubscription),
      );
    }

    const updatedUser = await this.prisma.$transaction(async tx => {
      return tx.user.update({
        where: { id },
        data,
      });
    });
    return updatedUser;
  }

  /**
   * Soft-deletes a user and cascades the soft delete to their related
   * records (notifications, notification settings, insurance policies and
   * the claims on those policies) so nothing is orphaned or hard-deleted.
   *
   * The user remains recoverable: restoring is a matter of clearing the
   * shared deletedAt timestamp (see SoftDeleteService.restore).
   */
  async delete(id: string): Promise<{ id: string; deletedAt: Date | null }> {
    await this.findById(id);

    const deletedAt = new Date();

    // Single transaction so the user and their related records are either
    // all soft-deleted or none are. The soft-delete middleware limits each
    // update to rows that are still active, preserving earlier deletions.
    const [deletedUser] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt },
      }),
      this.prisma.notification.updateMany({
        where: { userId: id },
        data: { deletedAt },
      }),
      this.prisma.notificationSetting.updateMany({
        where: { userId: id },
        data: { deletedAt },
      }),
      this.prisma.insurancePolicy.updateMany({
        where: { userId: id },
        data: { deletedAt },
      }),
      this.prisma.claim.updateMany({
        where: { policy: { userId: id } },
        data: { deletedAt },
      }),
    ]);

    return {
      id: deletedUser.id,
      deletedAt: deletedUser.deletedAt,
    };
  }

  async getDecryptedContact(userId: string): Promise<{
    email: string | null;
    pushSubscription: Prisma.JsonValue | null;
    notificationSettings: {
      emailEnabled: boolean;
      pushEnabled: boolean;
      notifyContributions: boolean;
      notifyMilestones: boolean;
      notifyDeadlines: boolean;
    } | null;
  }> {
    if (!isValidCuid(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
      },
      include: { notificationSettings: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const decrypted = this.decryptUser(user);
    return {
      email: decrypted.email,
      pushSubscription: decrypted.pushSubscription,
      notificationSettings: user.notificationSettings,
    };
  }

  /**
   * Decrypt sensitive fields in user object
   */
  private decryptUser(user: User): User {
    const decrypted = { ...user };

    if (decrypted.email) {
      try {
        decrypted.email = this.encryption.decrypt(decrypted.email);
      } catch {
        // If decryption fails, keep encrypted value
      }
    }

    if (decrypted.pushSubscription) {
      try {
        const decryptedJson = this.encryption.decrypt(
          decrypted.pushSubscription as string,
        );
        decrypted.pushSubscription = JSON.parse(
          decryptedJson,
        ) as Prisma.JsonValue;
      } catch {
        // If decryption fails, keep encrypted value
      }
    }

    return decrypted;
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
