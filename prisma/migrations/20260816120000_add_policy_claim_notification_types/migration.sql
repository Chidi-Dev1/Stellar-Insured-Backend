-- Add policy-purchase and claim-lifecycle notification types (see
-- src/notification/enums/notification-type.enum.ts). These are emitted by
-- InsuranceService.purchasePolicy and ClaimService (create/assess/pay) after
-- their database transaction commits, so users are never notified about
-- entities that do not exist.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POLICY_PURCHASED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CLAIM_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CLAIM_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CLAIM_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CLAIM_PAID';
