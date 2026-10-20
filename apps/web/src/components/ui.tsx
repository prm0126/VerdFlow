import { STATE_LABELS } from '@vf/shared';

const TONE: Record<string, string> = {
  awaiting_acceptance: 'good',
  accepted: 'good',
  delivered: 'good',
  ready: '',
  reserved: '',
  processed: 'good',
  manual_review: 'warn',
  unknown: 'warn',
  retry: 'warn',
  pending: 'grey',
  sending: 'grey',
  cancelled: 'grey',
  ignored: 'grey',
  released: 'grey',
  quarantined: 'bad',
  rejected: 'bad',
  failed: 'bad',
  offline: 'grey',
  on_break: 'warn',
  on_leave: 'grey',
  off_shift: 'grey',
  published: 'good',
  submitted: 'warn',
  draft: 'grey',
  retired: 'grey',
};

/** State badge: always text as well as colour. */
export function State({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`badge ${TONE[value] ?? ''}`}>{STATE_LABELS[value] ?? value.replace(/_/g, ' ')}</span>;
}

export function Reason({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  return <code className="small">{code}</code>;
}

export function When({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const d = new Date(value);
  return <span title={d.toISOString()}>{d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' })}</span>;
}

export function ErrorBox({ error, issues }: { error: string | null; issues?: string[] }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error}
      {issues && issues.length > 0 && (
        <ul>
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
