import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, When } from '../components/ui';
import { useResource } from '../hooks';

interface Msg {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  tools?: { name: string; ok: boolean }[];
  engine?: string | null;
  note?: string;
  created_at?: string;
}

const TOOL_LABEL: Record<string, string> = {
  my_schedule: 'your rota',
  my_work: 'your work',
  who_is_on_shift: 'who is on shift',
  find_studies: 'studies',
  explain_study: 'a study',
  operations_summary: 'the operations summary',
  turnaround_report: 'turnaround figures',
  open_escalations: 'escalations',
};

const SUGGESTIONS = [
  'What is scheduled under my name?',
  'What is assigned to me?',
  'Who is on shift now?',
  'Any overdue studies?',
  "Give me today's summary",
  'How is turnaround over the last 24 hours?',
];

/** Renders "- item" lines as a list and keeps everything else as paragraphs. Text only, never HTML. */
function Formatted({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const isItem = /^\s*[-*•]\s+/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === isItem) last.lines.push(line.replace(/^\s*[-*•]\s+/, ''));
    else blocks.push({ list: isItem, lines: [line.replace(/^\s*[-*•]\s+/, '')] });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} style={{ margin: '0.3rem 0', paddingLeft: '1.2rem' }}>
            {b.lines.map((l, j) => (
              <li key={j}>{l.replace(/\*\*/g, '')}</li>
            ))}
          </ul>
        ) : (
          b.lines
            .filter((l) => l.trim())
            .map((l, j) => (
              <p key={`${i}-${j}`} style={{ margin: '0.3rem 0' }}>
                {l.replace(/\*\*/g, '')}
              </p>
            ))
        ),
      )}
    </>
  );
}

export function Assistant() {
  const { data: info } = useResource<{ engine: 'claude' | 'built-in' }>('/assistant');
  const { data: list, reload: reloadList } = useResource<{ id: string; title: string; updated_at: string }[]>('/assistant/conversations');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  const open = async (id: string) => {
    setError(null);
    try {
      const c = await api<{ messages: Msg[] }>(`/assistant/conversations/${id}`);
      setConversationId(id);
      setMessages(c.messages);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const r = await api<{ conversationId: string; reply: string; tools: { name: string; ok: boolean }[]; engine: string; note?: string }>('/assistant/ask', {
        method: 'POST',
        body: { conversationId, message },
      });
      setConversationId(r.conversationId);
      setMessages((m) => [...m, { role: 'assistant', content: r.reply, tools: r.tools, engine: r.engine, note: r.note }]);
      reloadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <>
      <h1>
        Assistant{' '}
        {info && <span className={`badge ${info.engine === 'claude' ? 'good' : 'grey'}`}>{info.engine === 'claude' ? 'Claude' : 'Built-in answers'}</span>}
      </h1>
      <p className="muted small">
        Ask about your rota, your work, who is on shift, a study by accession, turnaround or escalations. The assistant only reads VerdFlow data you
        are allowed to see, and cannot change anything. Patient names and identifiers are never sent to it.
        {info?.engine === 'built-in' && ' Claude is not configured, so it answers common questions from built-in templates.'}
      </p>
      <div className="grid2" style={{ gridTemplateColumns: '240px 1fr' }}>
        <div>
          <button
            className="secondary"
            style={{ width: '100%', marginBottom: '0.5rem' }}
            onClick={() => {
              setConversationId(null);
              setMessages([]);
            }}
          >
            New conversation
          </button>
          {list?.map((c) => (
            <div
              key={c.id}
              className="panel small"
              style={{ cursor: 'pointer', margin: '0 0 0.4rem', padding: '0.5rem', background: c.id === conversationId ? 'var(--teal-50)' : undefined }}
              onClick={() => open(c.id)}
            >
              {c.title}
              <div className="muted">
                <When value={c.updated_at} />
              </div>
            </div>
          ))}
        </div>
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 480, background: '#fff' }}>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: '60vh' }}>
            {messages.length === 0 && (
              <div>
                <p className="muted">Try one of these:</p>
                <div className="row">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="secondary" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={m.id ?? i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '0.5rem 0' }}>
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '0.55rem 0.8rem',
                    borderRadius: 10,
                    background: m.role === 'user' ? 'var(--teal-700)' : 'var(--teal-50)',
                    color: m.role === 'user' ? '#fff' : 'var(--ink)',
                    border: m.role === 'user' ? 'none' : '1px solid var(--teal-100)',
                  }}
                >
                  {m.role === 'user' ? m.content : <Formatted text={m.content} />}
                  {m.role === 'assistant' && m.tools && m.tools.length > 0 && (
                    <div className="small muted" style={{ marginTop: '0.3rem' }}>
                      Looked up {[...new Set(m.tools.filter((t) => t.ok).map((t) => TOOL_LABEL[t.name] ?? t.name))].join(', ')}
                      {m.engine === 'claude' ? ' · Claude' : ' · built-in'}
                    </div>
                  )}
                  {m.note && <div className="small" style={{ marginTop: '0.3rem', color: 'var(--warn)' }}>{m.note}</div>}
                </div>
              </div>
            ))}
            {busy && <p className="muted small">Looking that up…</p>}
            <div ref={endRef} />
          </div>
          <ErrorBox error={error} />
          <form onSubmit={submit} className="row" style={{ marginTop: '0.6rem' }}>
            <input
              style={{ flex: 1 }}
              value={input}
              maxLength={2000}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question, for example: what is scheduled under my name?"
              aria-label="Question"
            />
            <button disabled={busy || !input.trim()}>Ask</button>
          </form>
        </div>
      </div>
    </>
  );
}
