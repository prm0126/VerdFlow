import { ErrorBox, When } from '../components/ui';
import { useResource } from '../hooks';

interface Row {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown>;
}

export function AuditLog() {
  const { data, error } = useResource<Row[]>('/audit');
  return (
    <>
      <h1>Audit log</h1>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Record</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td>
                <When value={a.occurred_at} />
              </td>
              <td>{a.actor_name ?? a.actor_type}</td>
              <td>{a.action}</td>
              <td className="small">
                {a.entity_type} {a.entity_id}
              </td>
              <td className="small muted condition">{JSON.stringify(a.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
