export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Calls the API. State-changing requests carry the header the API requires against cross-site requests. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-requested-with': 'verdflow' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = typeof data?.message === 'string' ? data.message : data?.message?.message ?? `Request failed (${res.status})`;
    const issues = data?.issues ?? data?.message?.issues ?? [];
    throw new ApiError(msg, res.status, issues);
  }
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}
