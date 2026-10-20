import { Link } from 'react-router-dom';
import { ErrorBox, Reason } from '../components/ui';
import { useResource } from '../hooks';

interface DashboardData {
  intake_last_hour: number;
  intake_backlog: number;
  oldest_backlog_seconds: number;
  quarantined: number;
  collisions: number;
  manual_review: number;
  reserved: number;
  awaiting_acceptance: number;
  studies_24h: number;
  outbound_pending: number;
  outbound_uncertain: number;
  outbound_failed: number;
  radiologists_ready: number;
  continuity: { preserved: number; broken: number };
  manualReviewReasons: { reason_code: string; n: number }[];
}

function Card({ label, value, alert, to }: { label: string; value: number | string; alert?: boolean; to?: string }) {
  const body = (
    <div className={`card${alert ? ' alert' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
  return to ? (
    <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

export function Dashboard() {
  const { data, error } = useResource<DashboardData>('/dashboard', 10_000);
  return (
    <>
      <h1>Operations dashboard</h1>
      <ErrorBox error={error} />
      {data && (
        <>
          <h2>Intake</h2>
          <div className="cards">
            <Card label="Messages in the last hour" value={data.intake_last_hour} />
            <Card label="Waiting to process" value={data.intake_backlog} alert={data.oldest_backlog_seconds > 60} />
            <Card label="Oldest waiting (seconds)" value={data.oldest_backlog_seconds} alert={data.oldest_backlog_seconds > 60} />
            <Card label="Quarantined" value={data.quarantined} alert={data.quarantined > 0} to="/errors" />
            <Card label="Control ID collisions" value={data.collisions} alert={data.collisions > 0} to="/errors" />
          </div>
          <h2>Studies</h2>
          <div className="cards">
            <Card label="Studies in the last 24 hours" value={data.studies_24h} to="/studies" />
            <Card label="Need a coordinator" value={data.manual_review} alert={data.manual_review > 0} to="/studies?state=manual_review" />
            <Card label="Reserved, not yet sent" value={data.reserved} to="/studies?state=reserved" />
            <Card label="Sent, awaiting acceptance" value={data.awaiting_acceptance} to="/studies?state=awaiting_acceptance" />
            <Card label="Radiologists ready and present" value={data.radiologists_ready} to="/availability" />
          </div>
          <h2>Delivery to the third party</h2>
          <div className="cards">
            <Card label="Waiting to send" value={data.outbound_pending} />
            <Card label="Delivery uncertain" value={data.outbound_uncertain} alert={data.outbound_uncertain > 0} to="/errors" />
            <Card label="Failed or rejected" value={data.outbound_failed} alert={data.outbound_failed > 0} to="/errors" />
          </div>
          <h2>Same-patient continuity (24 hours)</h2>
          <div className="cards">
            <Card label="Kept the same radiologist" value={data.continuity.preserved} />
            <Card label="Had to choose someone else" value={data.continuity.broken} />
          </div>
          {data.manualReviewReasons.length > 0 && (
            <>
              <h2>Why studies need a coordinator</h2>
              <table>
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>Studies</th>
                  </tr>
                </thead>
                <tbody>
                  {data.manualReviewReasons.map((r) => (
                    <tr key={r.reason_code}>
                      <td>
                        <Reason code={r.reason_code} />
                      </td>
                      <td>{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </>
  );
}
