import { runTool, studyName, type ToolContext } from './tools';
import type { ToolUse } from './assistant.service';

/**
 * The assistant without Claude: recognises the common questions from their wording, runs the same
 * read-only tools, and writes the answer from a template. Used when no Anthropic credential is set,
 * and as the fallback if a Claude call fails.
 */
export async function builtInAnswer(ctx: ToolContext, message: string): Promise<{ reply: string; tools: ToolUse[] }> {
  const q = message.toLowerCase();
  const tools: ToolUse[] = [];
  const use = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await runTool(ctx, name, input);
    tools.push({ name, input, ok: r.ok });
    return r;
  };
  const accession = message.match(/\b[A-Z]{2,}[A-Z0-9-]*\d{2,}\b/)?.[0];

  // "what is scheduled under my name", "my shifts next week", "am I on call tomorrow"
  if (/\b(schedul|shift|rota|on[ -]call|leave|working|my name|availab|break)/.test(q) && /\b(my|me|i|i'm|am i)\b/.test(q)) {
    const r = await use('my_schedule', scheduleWindow(q));
    return { reply: r.ok ? describeSchedule(r.result as ScheduleResult) : denied(r.result), tools };
  }
  if (/\bwho('s| is)? (is )?(on|working|available|on call)\b|who is on/.test(q)) {
    const r = await use('who_is_on_shift', { at: null });
    return { reply: r.ok ? describeWhoIsOn(r.result as WhoResult) : denied(r.result), tools };
  }
  if (/\b(assigned to me|my (studies|work|worklist|cases|reviews|queue)|peer review|to review|what do i have)\b/.test(q)) {
    const r = await use('my_work');
    return { reply: r.ok ? describeWork(r.result as WorkResult) : denied(r.result), tools };
  }
  if (accession) {
    const r = await use('explain_study', { accession });
    return { reply: r.ok ? describeStudy(r.result as StudyResult) : denied(r.result), tools };
  }
  if (/\b(escalat|overdue|at risk|breach|late)\b/.test(q)) {
    const r = await use('open_escalations');
    return { reply: r.ok ? describeEscalations(r.result as EscalationResult) : denied(r.result), tools };
  }
  if (/\b(turnaround|tat)\b/.test(q)) {
    const r = await use('turnaround_report', { hours: 24 });
    return { reply: r.ok ? describeTurnaround(r.result as TurnaroundResult) : denied(r.result), tools };
  }
  if (/\b(summary|dashboard|how are we|backlog|status|briefing|today|overview)\b/.test(q)) {
    const r = await use('operations_summary');
    return { reply: r.ok ? describeOperations(r.result as Record<string, number>) : denied(r.result), tools };
  }
  return {
    reply: [
      'I can help with:',
      '- your rota: "What is scheduled under my name?", "Am I working tomorrow?"',
      '- your work: "What is assigned to me?", "Do I have peer reviews?"',
      '- the team: "Who is on shift now?"',
      '- a study: "Explain ACC1234"',
      '- operations: "Any overdue studies?", "Give me today\'s summary", "How is turnaround?"',
    ].join('\n'),
    tools,
  };
}

function scheduleWindow(q: string): { fromDate: string | null; days: number | null } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (/\btomorrow\b/.test(q)) return { fromDate: iso(new Date(today.getTime() + 86400_000)), days: 1 };
  if (/\btoday\b|\btonight\b/.test(q)) return { fromDate: null, days: 1 };
  if (/\bmonth\b/.test(q)) return { fromDate: null, days: 31 };
  if (/\bnext week\b/.test(q)) {
    const monday = new Date(today.getTime() + ((8 - today.getUTCDay()) % 7 || 7) * 86400_000);
    return { fromDate: iso(monday), days: 7 };
  }
  const n = q.match(/\b(\d{1,2}) days?\b/);
  if (n) return { fromDate: null, days: Math.min(31, Math.max(1, Number(n[1]))) };
  return { fromDate: null, days: 7 };
}

const denied = (r: unknown) => (r as { error?: string })?.error ?? 'I could not look that up.';

interface ScheduleResult {
  linked: boolean;
  message?: string;
  radiologist?: string;
  period?: { from: string; to: string };
  shifts?: { starts: string; ends: string; type: string; note: string | null }[];
  absences?: { type: string; starts: string; ends: string }[];
  now?: { status: string; onShift: boolean; absence: string | null; loadWorkUnits: string } | null;
}
function describeSchedule(r: ScheduleResult): string {
  if (!r.linked) return r.message!;
  const lines = [`Here is what is scheduled for ${r.radiologist} from ${r.period!.from} to ${r.period!.to} (UK time):`];
  if (!r.shifts!.length && !r.absences!.length) lines.push('- Nothing is scheduled in that period.');
  for (const s of r.shifts!) lines.push(`- ${s.type === 'on call' ? 'On call' : 'Reporting shift'}: ${s.starts} to ${s.ends}${s.note ? ` (${s.note})` : ''}`);
  for (const a of r.absences!) lines.push(`- ${a.type[0].toUpperCase()}${a.type.slice(1)}: ${a.starts} to ${a.ends}`);
  if (r.now) {
    const can = r.now.onShift && !r.now.absence && r.now.status === 'ready';
    lines.push(
      `Right now you are ${r.now.onShift ? 'on shift' : 'off shift'}${r.now.absence ? `, on ${r.now.absence}` : ''}, status ${r.now.status.replace(/_/g, ' ')}, load ${r.now.loadWorkUnits} work units${can ? '.' : ', so you are not receiving new work.'}`,
    );
  }
  return lines.join('\n');
}

interface WhoResult {
  at: string;
  onShift: { radiologist: string; shift: string; until: string; teams: string[]; status: string; loadWorkUnits: string }[];
}
function describeWhoIsOn(r: WhoResult): string {
  if (!r.onShift.length) return `Nobody is on shift at ${r.at}.`;
  return [`On shift at ${r.at}:`, ...r.onShift.map((p) => `- ${p.radiologist}, ${p.shift} until ${p.until} (${p.teams.join(', ') || 'no team'}; ${p.status.replace(/_/g, ' ')}; load ${p.loadWorkUnits})`)].join('\n');
}

interface WorkResult {
  linked: boolean;
  message?: string;
  radiologist?: string;
  assignedStudies?: { accession: string; study: string; priority: string; state: string; turnaround: { state: string; due: string | null } | null }[];
  openPeerReviews?: { accession: string; since: string }[];
  vettingWaiting: number | null;
}
function describeWork(r: WorkResult): string {
  const vet = r.vettingWaiting ? `\n${r.vettingWaiting} request${r.vettingWaiting === 1 ? ' is' : 's are'} waiting for vetting.` : '';
  if (!r.linked) return r.message! + vet;
  const lines: string[] = [];
  lines.push(r.assignedStudies!.length ? `${r.assignedStudies!.length} stud${r.assignedStudies!.length === 1 ? 'y is' : 'ies are'} assigned to you:` : 'No studies are assigned to you at the moment.');
  for (const s of r.assignedStudies!) {
    lines.push(`- ${s.accession}: ${s.study}, ${s.priority.toLowerCase()}, ${s.state.replace(/_/g, ' ')}${s.turnaround ? `, ${s.turnaround.state}${s.turnaround.due ? ` (due ${s.turnaround.due})` : ''}` : ''}`);
  }
  if (r.openPeerReviews!.length) lines.push(`You have ${r.openPeerReviews!.length} peer review${r.openPeerReviews!.length === 1 ? '' : 's'} open: ${r.openPeerReviews!.map((t) => t.accession).join(', ')}.`);
  return lines.join('\n') + vet;
}

interface StudyResult {
  found: boolean;
  accession?: string;
  study?: { accession: string; hospital: string; modality: string; service: string; priority: string; state: string; reason: string | null };
  decision?: { outcome: string; reason_code: string; rule_set_version: number | null; routing: { routing?: { teamCode?: string | null; ruleId?: string | null } | null }; candidates: { name: string; eligible: boolean; reasons: string[] }[] } | null;
  assignments?: { version: number; radiologist: string; team: string; status: string; end_reason: string | null }[];
  turnaround?: { interval: string; targetMinutes: number; state: string; due: string; finished: string | null }[];
  peerReview?: { status: string; reviewer: string | null; outcome: string | null } | null;
}
export function describeStudy(raw: unknown): string {
  const r = raw as StudyResult;
  if (!r.found) return `I could not find a study with accession ${r.accession}.`;
  const s = r.study!;
  const what = `${s.priority.toLowerCase()} ${studyName(s.modality, s.service)}`;
  const lines = [`${s.accession} is ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} from ${s.hospital}. It is now: ${s.state.replace(/_/g, ' ')}${s.reason ? ` (${s.reason})` : ''}.`];
  const d = r.decision;
  if (d) {
    const team = d.routing?.routing?.teamCode;
    if (d.outcome === 'assigned') lines.push(`It was routed to team ${team} by rule ${d.routing?.routing?.ruleId} (rules version ${d.rule_set_version}).`);
    else lines.push(`It could not be assigned automatically: ${d.reason_code}.`);
    const excluded = d.candidates.filter((c) => !c.eligible);
    if (excluded.length) lines.push(`Not chosen: ${excluded.map((c) => `${c.name} (${c.reasons.join(', ')})`).join('; ')}.`);
  }
  for (const a of r.assignments ?? []) lines.push(`Assignment ${a.version}: ${a.radiologist}, team ${a.team}, ${a.status}${a.end_reason ? ` (${a.end_reason})` : ''}.`);
  for (const c of r.turnaround ?? []) lines.push(`Turnaround, ${c.interval}: ${c.state.replace(/_/g, ' ')} against ${c.targetMinutes} minutes${c.finished ? `, done ${c.finished}` : `, due ${c.due}`}.`);
  if (r.peerReview) lines.push(`Peer review: ${r.peerReview.status}${r.peerReview.reviewer ? ` with ${r.peerReview.reviewer}` : ''}${r.peerReview.outcome ? `, ${r.peerReview.outcome.replace(/_/g, ' ')}` : ''}.`);
  return lines.join('\n');
}

interface EscalationResult {
  count: number;
  escalations: { accession: string; priority: string; what: string; reason: string; raised: string; acknowledgedBy: string | null }[];
}
function describeEscalations(r: EscalationResult): string {
  if (!r.count) return 'There are no open escalations.';
  return [
    `${r.count} open escalation${r.count === 1 ? '' : 's'}:`,
    ...r.escalations.map((e) => `- ${e.accession} (${e.priority.toLowerCase()}): ${e.what}, ${e.reason}, raised ${e.raised}${e.acknowledgedBy ? `, acknowledged by ${e.acknowledgedBy}` : ', not yet acknowledged'}`),
  ].join('\n');
}

interface TurnaroundResult {
  hours: number;
  intervals: { interval: string; priority: string; met: number; late: number; median_minutes: number | null }[];
}
function describeTurnaround(r: TurnaroundResult): string {
  if (!r.intervals.length) return `No turnaround steps finished in the last ${r.hours} hours.`;
  return [
    `Turnaround over the last ${r.hours} hours:`,
    ...r.intervals.map((i) => `- ${i.priority.toLowerCase()}, ${i.interval}: ${i.met} on time, ${i.late} late, median ${i.median_minutes ?? '–'} minutes`),
  ].join('\n');
}

export function describeOperations(f: Record<string, number>): string {
  const lines: string[] = [];
  const act: string[] = [];
  if (f.turnaround_overdue) act.push(`${f.turnaround_overdue} turnaround step${f.turnaround_overdue === 1 ? ' is' : 's are'} overdue`);
  if (f.needing_coordinator) act.push(`${f.needing_coordinator} stud${f.needing_coordinator === 1 ? 'y needs' : 'ies need'} a coordinator`);
  if (f.unacknowledged_escalations) act.push(`${f.unacknowledged_escalations} escalation${f.unacknowledged_escalations === 1 ? ' is' : 's are'} not yet acknowledged`);
  if (f.delivery_problems) act.push(`${f.delivery_problems} deliver${f.delivery_problems === 1 ? 'y needs' : 'ies need'} checking`);
  if (f.quarantined) act.push(`${f.quarantined} message${f.quarantined === 1 ? ' is' : 's are'} quarantined`);
  lines.push(act.length ? `Needs action: ${act.join('; ')}.` : 'Nothing needs action right now.');
  lines.push(`- ${f.studies_last_24h} studies in the last 24 hours; ${f.finalised_last_24h} final reports.`);
  lines.push(`- ${f.being_reported} being reported, ${f.waiting_for_acceptance} waiting for a radiologist to accept, ${f.awaiting_vetting} waiting for vetting.`);
  lines.push(`- ${f.radiologists_available} radiologists available; ${f.turnaround_at_risk} turnaround steps at risk; ${f.peer_reviews_open} peer reviews open.`);
  if (f.intake_waiting) lines.push(`- ${f.intake_waiting} messages waiting to be processed.`);
  return lines.join('\n');
}
