/**
 * The categories of activity that contribute to a reputation score.
 * Keeping these as an enum means new activity types are added in one place
 * and the compiler catches any missing case in switch statements.
 */
export enum ActivityType {
  /** A transaction or job completed successfully by both parties. */
  SUCCESSFUL_TRANSACTION = 'SUCCESSFUL_TRANSACTION',
  /** A transaction that was abandoned, disputed, or failed. */
  FAILED_TRANSACTION = 'FAILED_TRANSACTION',
  /** A peer-to-peer rating submitted after a completed transaction. */
  PEER_RATING = 'PEER_RATING',
  /** A review or comment left on a listing / profile. */
  COMMUNITY_REVIEW = 'COMMUNITY_REVIEW',
  /** A dispute resolution decided in the subject's favour. */
  DISPUTE_WON = 'DISPUTE_WON',
  /** A dispute resolution decided against the subject. */
  DISPUTE_LOST = 'DISPUTE_LOST',
  /** A high-value contribution flagged by admins or automated scoring. */
  HIGH_VALUE_CONTRIBUTION = 'HIGH_VALUE_CONTRIBUTION',
}

/**
 * Weights applied to each factor when computing the composite score.
 * All weights are relative — they do not need to sum to 1.
 *
 * Tune these constants without touching calculation logic.
 */
export const FACTOR_WEIGHTS = {
  SUCCESS_RATE: 0.35, // outcome quality
  PEER_RATING: 0.3, // community sentiment
  CONTRIBUTION_SIZE: 0.2, // volume and impact
  COMMUNITY_FEEDBACK: 0.15, // reviews and dispute outcomes
} as const;

/**
 * Time-decay half-life in days.
 * After this many days an activity contributes half its original weight.
 * Older activities still count but have diminishing influence.
 */
export const DECAY_HALF_LIFE_DAYS = 180;

/** Composite scores are clamped to [MIN_SCORE, MAX_SCORE]. */
export const MIN_SCORE = 0;
export const MAX_SCORE = 100;

/**
 * Minimum number of activities required before a score is considered
 * statistically meaningful. Below this threshold the score is returned
 * alongside a `lowConfidence` flag.
 */
export const MIN_ACTIVITY_THRESHOLD = 5;

/**
 * Fixed point deltas applied to User.reputationScore for discrete events.
 * Keeping these in one place makes the scoring policy easy to audit and tune.
 */
export const REPUTATION_DELTAS = {
  /** Claim approved and ready for payout. */
  CLAIM_APPROVED: 10,
  /** Claim rejected (policy violation, over-coverage, oracle failure, etc.). */
  CLAIM_REJECTED: -5,
  /** Automated fraud indicators triggered on a claim. */
  FRAUD_DETECTED: -20,
  /** A blockchain contribution was successfully recorded. */
  CONTRIBUTION_SUCCESS: 5,
  /** A project milestone was approved on-chain. */
  MILESTONE_APPROVED: 15,
  /** A project milestone was rejected on-chain. */
  MILESTONE_REJECTED: -10,
  /** Initial reputation granted when a user account is first created. */
  INITIAL_REPUTATION: 50,
} as const;
