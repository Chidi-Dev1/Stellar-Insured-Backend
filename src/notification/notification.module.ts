import { Module, forwardRef } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './services/notification.service';
import { InsuranceModule } from '../insurance/insurance.module';
import { EmailService } from './services/email.service';
import { WebPushService } from './services/web-push.service';
import { DeadlineAlertTask } from './tasks/deadline-alert.task';
import { EmailRetryTask } from './tasks/email-retry.task';
import { DatabaseModule } from '../database.module';
import { UserModule } from '../user/user.module';
import { QueueModule } from '../queue.module';
import {
  NotificationRepository,
  NotificationSettingRepository,
  EmailOutboxRepository,
} from '../common/repositories/notification.repository';
import {
  ProjectRepository,
  ContributionRepository,
} from '../common/repositories/project.repository';

import { EncryptionModule } from '../encryption/encryption.module';

@Module({
  imports: [
    DatabaseModule,
    EncryptionModule,
    forwardRef(() => UserModule),
    forwardRef(() => InsuranceModule),
    QueueModule,
  ],
  controllers: [NotificationController],
  providers: [
    // Repositories
    NotificationRepository,
    NotificationSettingRepository,
    EmailOutboxRepository,
    ProjectRepository,
    ContributionRepository,
    // Services
    NotificationService,
    EmailService,
    WebPushService,
    DeadlineAlertTask,
    EmailRetryTask,
  ],
  exports: [
    NotificationService,
    NotificationRepository,
    NotificationSettingRepository,
    EmailOutboxRepository,
  ],
})
export class NotificationModule {}
