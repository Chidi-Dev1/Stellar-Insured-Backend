import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma.service';
import { EmailService } from './email.service';
import { WebPushService } from './web-push.service';
import { NotificationType } from '../enums/notification-type.enum';
import { validateEnum } from '../../common/validators/enum.validator';
import { UserService } from '../../user/user.service';
import { QUEUE_NAMES, EmailJobData, PushJobData } from '../constants/queue.constants';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly webPushService: WebPushService,
    private readonly userService: UserService,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobData>,
    @InjectQueue(QUEUE_NAMES.PUSH)
    private readonly pushQueue: Queue<PushJobData>,
  ) {}

  /**
   * Persists a notification and dispatches it through background queues.
   *
   * No synchronous SendGrid / web-push call happens here, so a slow or failing
   * provider can never block or 500 the calling request. The actual send is
   * performed off-request by the queue processors, with the EmailOutbox row
   * providing a durable PENDING → SENT|FAILED record.
   */
  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    // Validate notification type at runtime
    validateEnum(NotificationType, type, 'NotificationType');

    let contactData;
    try {
      contactData = await this.userService.getDecryptedContact(userId);
    } catch {
      this.logger.warn(`User ${userId} not found for notification`);
      return;
    }

    // Persist default settings if none exist yet (legacy users)
    let settings = contactData.notificationSettings;
    if (!settings) {
      settings = await this.prisma.notificationSetting.create({
        data: { userId },
      });
    }

    // Check specific preferences
    if (type === 'CONTRIBUTION' && !settings.notifyContributions) return;
    if (type === 'MILESTONE' && !settings.notifyMilestones) return;
    if (type === 'DEADLINE' && !settings.notifyDeadlines) return;

    // Save notification to history
    await this.prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        data,
      },
    });

    // Dispatch via Email: write a durable outbox row and enqueue the send.
    if (settings.emailEnabled && contactData.email) {
      await this.enqueueEmail(contactData.email, title, `<p>${message}</p>`);
    }

    // Dispatch via Web Push: enqueue the send (best-effort, no outbox row).
    const pushSubscription = this.getPushSubscription(
      contactData.pushSubscription,
    );
    if (settings.pushEnabled && pushSubscription) {
      await this.pushQueue.add(
        { subscription: pushSubscription, payload: { title, body: message, data } },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
      );
    }
  }

  /**
   * Writes an EmailOutbox row (PENDING) and enqueues the email job. The job
   * payload carries the outbox id so the processor can mark it SENT|FAILED.
   */
  async enqueueEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const outbox = await this.prisma.emailOutbox.create({
      data: { to, subject, html, status: 'PENDING' },
    });

    await this.emailQueue.add(
      {
        outboxId: outbox.id,
        to: outbox.to,
        subject: outbox.subject,
        html: outbox.html,
      },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  private getPushSubscription(
    value: Prisma.JsonValue | null,
  ): webpush.PushSubscription | null {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        return this.isPushSubscription(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    return this.isPushSubscription(value) ? value : null;
  }

  private isPushSubscription(
    value: unknown,
  ): value is webpush.PushSubscription {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<webpush.PushSubscription>;
    return typeof candidate.endpoint === 'string' && Boolean(candidate.keys);
  }
}
