/** Three separate state tracks: message delivery, clinical workflow and radiologist availability. */

export const INTAKE_STATES = ['received', 'processed', 'ignored', 'quarantined'] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];

export const STUDY_STATES = [
  'ready',
  'reserved',
  'awaiting_acceptance',
  'manual_review',
  'cancelled',
] as const;
export type StudyState = (typeof STUDY_STATES)[number];

export const OUTBOUND_STATES = [
  'pending',
  'sending',
  'retry',
  'unknown',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
] as const;
export type OutboundState = (typeof OUTBOUND_STATES)[number];

export const AVAILABILITY_STATES = ['offline', 'ready', 'on_break', 'on_leave', 'off_shift'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const ASSIGNMENT_STATES = ['reserved', 'sent', 'delivered', 'released', 'cancelled'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** Plain-English labels for the web app. */
export const STATE_LABELS: Record<string, string> = {
  received: 'Received',
  processed: 'Processed',
  ignored: 'Ignored (duplicate or no action)',
  quarantined: 'Quarantined',
  ready: 'Ready to route',
  reserved: 'Reserved, not yet sent',
  awaiting_acceptance: 'Sent, awaiting radiologist acceptance',
  manual_review: 'Needs a coordinator',
  cancelled: 'Cancelled',
  pending: 'Waiting to send',
  sending: 'Sending',
  retry: 'Will retry',
  unknown: 'Delivery uncertain',
  accepted: 'Destination accepted',
  rejected: 'Destination rejected',
  failed: 'Failed after retries',
  offline: 'Offline',
  on_break: 'On break',
  on_leave: 'On leave',
  off_shift: 'Off shift',
  sent: 'Sent',
  delivered: 'Delivered',
  released: 'Released',
};
