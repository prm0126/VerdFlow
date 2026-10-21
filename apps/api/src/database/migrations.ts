import type { Migration } from './migrator';

/**
 * VerdFlow schema. Append new migrations; never edit one that has been applied.
 *
 * Local-development note: intake_messages and outbound_messages stand in for the Kafka intake stream and
 * the transactional outbox relay. The national design moves raw intake to the event backbone.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'foundation',
    sql: /* sql */ `
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable';
END $$;

-- Identity and access ------------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'partner')),
  actor_id text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Masters ------------------------------------------------------------------------------------------
CREATE TABLE integration_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- inbound: SHA-256 of the partner's API key; the key itself is never stored
  api_key_hash text UNIQUE,
  allowed_facilities text[] NOT NULL DEFAULT '{}',
  -- outbound: where assignments are delivered
  endpoint_url text,
  receiving_application text,
  receiving_facility text,
  timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (direction <> 'inbound' OR api_key_hash IS NOT NULL),
  CHECK (direction <> 'outbound' OR endpoint_url IS NOT NULL)
);

CREATE TABLE hospitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/London',
  outbound_partner_id uuid REFERENCES integration_partners(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modalities (
  code text PRIMARY KEY,
  name text NOT NULL,
  work_units numeric(6,2) NOT NULL DEFAULT 1 CHECK (work_units > 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE services (
  code text PRIMARY KEY,
  name text NOT NULL,
  modality_code text REFERENCES modalities(code),
  work_units numeric(6,2) CHECK (work_units IS NULL OR work_units > 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radiologists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  full_name text NOT NULL,
  -- identifier the destination system knows this clinician by
  external_id text NOT NULL,
  grade text,
  specialties text[] NOT NULL DEFAULT '{}',
  user_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radiologist_privileges (
  radiologist_id uuid NOT NULL REFERENCES radiologists(id) ON DELETE CASCADE,
  modality_code text NOT NULL REFERENCES modalities(code),
  valid_to date,
  PRIMARY KEY (radiologist_id, modality_code)
);

CREATE TABLE radiologist_hospitals (
  radiologist_id uuid NOT NULL REFERENCES radiologists(id) ON DELETE CASCADE,
  hospital_id uuid NOT NULL REFERENCES hospitals(id),
  PRIMARY KEY (radiologist_id, hospital_id)
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  radiologist_id uuid NOT NULL REFERENCES radiologists(id) ON DELETE CASCADE,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  PRIMARY KEY (team_id, radiologist_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- One row per radiologist. Every availability and capacity change locks this row, so the allocation
-- gate always sees a consistent status, heartbeat and load.
CREATE TABLE radiologist_state (
  radiologist_id uuid PRIMARY KEY REFERENCES radiologists(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'ready', 'on_break', 'on_leave', 'off_shift')),
  heartbeat_at timestamptz,
  capacity_units numeric(8,2) NOT NULL DEFAULT 10 CHECK (capacity_units >= 0),
  active_units numeric(8,2) NOT NULL DEFAULT 0 CHECK (active_units >= 0),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rules ----------------------------------------------------------------------------------------------
CREATE TABLE rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'published', 'retired', 'rejected')),
  definition jsonb NOT NULL,
  checksum text NOT NULL,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  published_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX rule_sets_one_published ON rule_sets ((true)) WHERE status = 'published';

-- Intake (stand-in for the durable intake stream) ----------------------------------------------------
CREATE TABLE intake_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES integration_partners(id),
  -- partner-qualified idempotency key: sending application + facility + MSH-10
  message_key text NOT NULL,
  control_id text NOT NULL,
  message_type text,
  -- issuer + accession when it can be read at intake; messages for one study are processed in order
  ordering_key text,
  payload_hash text NOT NULL,
  payload text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'quarantined')),
  reason_code text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  study_id uuid,
  UNIQUE (partner_id, message_key)
);
CREATE INDEX intake_messages_pending_idx ON intake_messages (next_attempt_at) WHERE status = 'received';
CREATE INDEX intake_messages_ordering_idx ON intake_messages (ordering_key, received_at) WHERE status = 'received';
CREATE INDEX intake_messages_status_idx ON intake_messages (status, received_at DESC);

-- Same key with different content: kept for investigation, never processed.
CREATE TABLE intake_collisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_message_id uuid NOT NULL REFERENCES intake_messages(id),
  payload_hash text NOT NULL,
  payload text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id)
);

-- Clinical workflow ------------------------------------------------------------------------------------
CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority text NOT NULL,
  identifier text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (authority, identifier)
);

CREATE TABLE studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id),
  issuer text NOT NULL,
  accession text NOT NULL,
  placer_order text,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_number text,
  modality_code text NOT NULL,
  service_code text NOT NULL,
  service_text text,
  priority text NOT NULL CHECK (priority IN ('STAT', 'URGENT', 'ROUTINE')),
  location text,
  room text,
  state text NOT NULL CHECK (state IN ('ready', 'reserved', 'awaiting_acceptance', 'manual_review', 'cancelled')),
  state_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, accession)
);
CREATE INDEX studies_state_idx ON studies (state, created_at DESC);
CREATE INDEX studies_patient_idx ON studies (patient_id, created_at DESC);

CREATE TABLE study_events (
  id bigserial PRIMARY KEY,
  study_id uuid NOT NULL REFERENCES studies(id),
  intake_message_id uuid REFERENCES intake_messages(id),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_events_study_idx ON study_events (study_id, id);

-- Guard row for same-patient continuity. Locked by every assignment for the patient, including the
-- first one, so simultaneous studies for one patient are coordinated.
CREATE TABLE patient_affinity (
  patient_id uuid NOT NULL REFERENCES patients(id),
  scope_key text NOT NULL,
  radiologist_id uuid REFERENCES radiologists(id),
  last_study_id uuid REFERENCES studies(id),
  last_assigned_at timestamptz,
  PRIMARY KEY (patient_id, scope_key)
);

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id),
  rule_set_id uuid REFERENCES rule_sets(id),
  rule_set_version integer,
  facts jsonb NOT NULL,
  routing jsonb NOT NULL,
  candidates jsonb NOT NULL,
  continuity jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('assigned', 'no_eligible', 'no_route', 'no_rules', 'no_destination')),
  reason_code text NOT NULL,
  selected_radiologist_id uuid REFERENCES radiologists(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_study_idx ON evaluations (study_id, created_at DESC);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id),
  radiologist_id uuid NOT NULL REFERENCES radiologists(id),
  team_code text NOT NULL,
  purpose text NOT NULL DEFAULT 'primary' CHECK (purpose IN ('primary')),
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'sent', 'delivered', 'released', 'cancelled')),
  work_units numeric(6,2) NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES evaluations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  UNIQUE (study_id, purpose, version)
);
-- One active primary assignment per study.
CREATE UNIQUE INDEX assignments_one_active ON assignments (study_id, purpose)
  WHERE status IN ('reserved', 'sent', 'delivered');
CREATE INDEX assignments_radiologist_idx ON assignments (radiologist_id) WHERE status IN ('reserved', 'sent', 'delivered');

-- Outbound (transactional outbox) ------------------------------------------------------------------------
CREATE SEQUENCE outbound_control_seq;

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES integration_partners(id),
  study_id uuid NOT NULL REFERENCES studies(id),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  kind text NOT NULL CHECK (kind IN ('assignment', 'cancellation')),
  -- stable across retries, so the receiver can recognise a repeat
  control_id text NOT NULL UNIQUE,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry', 'unknown', 'accepted', 'rejected', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- true once any attempt may have reached the destination
  possibly_delivered boolean NOT NULL DEFAULT false,
  ack_code text,
  ack_text text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (assignment_id, kind)
);
CREATE INDEX outbound_messages_due_idx ON outbound_messages (next_attempt_at) WHERE status IN ('pending', 'retry', 'unknown');
CREATE INDEX outbound_messages_lease_idx ON outbound_messages (lease_until) WHERE status = 'sending';

CREATE TABLE delivery_attempts (
  id bigserial PRIMARY KEY,
  outbound_message_id uuid NOT NULL REFERENCES outbound_messages(id),
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  http_status integer,
  ack_code text,
  error text
);
CREATE INDEX delivery_attempts_msg_idx ON delivery_attempts (outbound_message_id, attempt);
`,
  },
  {
    version: 2,
    name: 'rota_rooms_employees_users',
    sql: /* sql */ `
-- Employees: the organisational person. A radiologist is a clinical profile that may link to one.
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  full_name text NOT NULL,
  email text,
  job_title text,
  user_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE radiologists ADD COLUMN employee_id uuid REFERENCES employees(id);

-- Rooms, with the modalities they may perform and whether they are open.
CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id),
  code text NOT NULL,
  name text NOT NULL,
  modalities text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, code)
);

-- Rota. Times are UTC instants; the UI shows them in the viewer's time zone.
-- Overlaps are refused by the application while it holds the radiologist's state-row lock.
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radiologist_id uuid NOT NULL REFERENCES radiologists(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  kind text NOT NULL DEFAULT 'reporting' CHECK (kind IN ('reporting', 'on_call')),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '36 hours')
);
CREATE INDEX shifts_radiologist_time_idx ON shifts (radiologist_id, starts_at);

-- Leave and breaks. A break started "now" has no end until it is ended.
CREATE TABLE absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radiologist_id uuid NOT NULL REFERENCES radiologists(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('leave', 'break', 'training', 'other')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX absences_radiologist_time_idx ON absences (radiologist_id, starts_at);

-- A study can now be held because of its room.
ALTER TABLE evaluations DROP CONSTRAINT evaluations_outcome_check;
ALTER TABLE evaluations ADD CONSTRAINT evaluations_outcome_check
  CHECK (outcome IN ('assigned', 'no_eligible', 'no_route', 'no_rules', 'no_destination', 'room_hold'));

-- Users are invited with a single-use set-password link; passwords are never sent or shown.
CREATE TABLE password_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 3,
    name: 'vetting_lifecycle_tat_escalations_peer_review',
    sql: /* sql */ `
-- What a partner may send: orders (source), lifecycle events back from reporting, or presence.
ALTER TABLE integration_partners ADD COLUMN role text NOT NULL DEFAULT 'source'
  CHECK (role IN ('source', 'reporting', 'presence'));
UPDATE integration_partners SET role = 'presence' WHERE direction = 'inbound' AND allowed_facilities = '{}';

-- Vetting requirement per service.
ALTER TABLE services ADD COLUMN requires_vetting boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN vetting_protocols text[] NOT NULL DEFAULT '{}';

-- Clinical workflow states and milestone times.
ALTER TABLE studies DROP CONSTRAINT studies_state_check;
ALTER TABLE studies ADD CONSTRAINT studies_state_check CHECK (state IN (
  'awaiting_vetting', 'vetting_rejected', 'ready', 'reserved', 'awaiting_acceptance', 'assigned',
  'preliminary', 'finalized', 'manual_review', 'cancelled'));
ALTER TABLE studies ADD COLUMN ready_at timestamptz;
ALTER TABLE studies ADD COLUMN delivered_at timestamptz;
ALTER TABLE studies ADD COLUMN accepted_at timestamptz;
ALTER TABLE studies ADD COLUMN preliminary_at timestamptz;
ALTER TABLE studies ADD COLUMN finalized_at timestamptz;
ALTER TABLE studies ADD COLUMN vetted_by uuid REFERENCES users(id);
ALTER TABLE studies ADD COLUMN vetted_at timestamptz;
ALTER TABLE studies ADD COLUMN vetting_protocol text;
ALTER TABLE studies ADD COLUMN vetting_note text;
ALTER TABLE studies ADD COLUMN reported_by uuid REFERENCES radiologists(id);
UPDATE studies SET ready_at = created_at WHERE state NOT IN ('awaiting_vetting', 'vetting_rejected');

-- Assignments: accepted by the radiologist, declined, or completed when the report is final.
ALTER TABLE assignments DROP CONSTRAINT assignments_status_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_status_check CHECK (status IN (
  'reserved', 'sent', 'delivered', 'accepted', 'completed', 'declined', 'released', 'cancelled'));
DROP INDEX assignments_one_active;
CREATE UNIQUE INDEX assignments_one_active ON assignments (study_id, purpose)
  WHERE status IN ('reserved', 'sent', 'delivered', 'accepted');
DROP INDEX assignments_radiologist_idx;
CREATE INDEX assignments_radiologist_idx ON assignments (radiologist_id)
  WHERE status IN ('reserved', 'sent', 'delivered', 'accepted');

-- Turnaround clocks. Each clock copies its target when it starts, so later rule changes do not move it.
CREATE TABLE tat_clocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id),
  interval_code text NOT NULL,
  rule_set_version integer,
  target_minutes integer NOT NULL CHECK (target_minutes > 0),
  started_at timestamptz NOT NULL,
  warn_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  stopped_at timestamptz,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'warning', 'breached', 'met', 'met_late', 'cancelled')),
  warned_at timestamptz,
  breached_at timestamptz,
  UNIQUE (study_id, interval_code)
);
CREATE INDEX tat_clocks_open_idx ON tat_clocks (due_at) WHERE state IN ('running', 'warning');

CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id),
  kind text NOT NULL CHECK (kind IN ('manual_review', 'tat_warning', 'tat_breach')),
  reason_code text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution text
);
-- At most one open escalation of each kind and reason per study.
CREATE UNIQUE INDEX escalations_open_uq ON escalations (study_id, kind, reason_code) WHERE resolved_at IS NULL;
CREATE INDEX escalations_open_idx ON escalations (raised_at DESC) WHERE resolved_at IS NULL;

-- Peer review: one task per study, never the original reporter, capped per reviewer per day.
CREATE TABLE peer_review_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL UNIQUE REFERENCES studies(id),
  reporter_id uuid NOT NULL REFERENCES radiologists(id),
  reviewer_id uuid REFERENCES radiologists(id),
  rule_set_version integer,
  status text NOT NULL CHECK (status IN ('open', 'completed', 'skipped')),
  skip_reason text,
  outcome text CHECK (outcome IS NULL OR outcome IN ('agree', 'minor_discrepancy', 'major_discrepancy')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> reporter_id),
  CHECK ((status = 'skipped') = (reviewer_id IS NULL))
);
CREATE INDEX peer_review_tasks_reviewer_idx ON peer_review_tasks (reviewer_id, status);

CREATE TABLE peer_review_daily (
  reviewer_id uuid NOT NULL REFERENCES radiologists(id),
  day date NOT NULL,
  assigned integer NOT NULL DEFAULT 0 CHECK (assigned >= 0),
  PRIMARY KEY (reviewer_id, day)
);
`,
  },
];
