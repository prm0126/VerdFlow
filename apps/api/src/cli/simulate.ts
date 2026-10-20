import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildAck, hl7Timestamp, parseHl7, readMsh } from '@vf/shared';

/**
 * Local stand-ins for the systems around VerdFlow, for development only:
 *  - a third-party Mirth that receives assignments on :4100 and returns AA acknowledgments,
 *  - a reporting-workstation presence feed that heartbeats every radiologist every 15 seconds,
 *  - a source Mirth that sends sample ORM^O01 orders (including two studies for one patient).
 *
 * Usage: pnpm simulate [--orders N] [--reject-every N]
 */
const api = process.env.VERDFLOW_API ?? 'http://localhost:4000/api';
const keys = JSON.parse(readFileSync(resolve(__dirname, '../../../../.dev-keys.json'), 'utf8')) as Record<string, string>;
const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const orders = flag('--orders', 6);
const rejectEvery = flag('--reject-every', 0);

const seen = new Set<string>();
let received = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const msh = readMsh(parseHl7(body));
      const repeat = seen.has(msh.controlId ?? '');
      seen.add(msh.controlId ?? '');
      received++;
      const reject = !repeat && rejectEvery > 0 && received % rejectEvery === 0;
      console.log(`[third-party mirth] ${repeat ? 'repeat of' : 'received'} ${msh.controlId} → ${reject ? 'AE' : 'AA'}`);
      res.writeHead(200, { 'content-type': 'x-application/hl7-v2+er7' });
      res.end(buildAck(msh, reject ? 'AE' : 'AA', `TP${Date.now()}`, reject ? 'Radiologist not known here' : undefined));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(4100, 'localhost', () => console.log('[third-party mirth] listening on http://localhost:4100/hl7'));

const radiologists = ['R001', 'R002', 'R003', 'R004', 'R005', 'R006'];
async function heartbeat() {
  try {
    const r = await fetch(`${api}/integration/presence`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys['key:PACS_PRESENCE']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ radiologistCodes: radiologists }),
    });
    if (!r.ok) console.log(`[presence] HTTP ${r.status}`);
  } catch (err) {
    console.log(`[presence] API not reachable: ${(err as Error).message}`);
  }
}

const SAMPLES = [
  { svc: 'CTHEAD^CT head', mod: 'CT', pri: 'S' },
  { svc: 'MRBRAIN^MR brain', mod: 'MR', pri: 'R' },
  { svc: 'CTCAP^CT chest abdomen pelvis', mod: 'CT', pri: 'R' },
  { svc: 'XRCHEST^X-ray chest', mod: 'XR', pri: 'R' },
  { svc: 'USABDO^Ultrasound abdomen', mod: 'US', pri: 'A' },
];

function order(n: number, run: string) {
  const s = SAMPLES[n % SAMPLES.length];
  // Every pair of orders shares a patient and encounter, to show same-patient continuity.
  const patient = `MRN${run}${Math.floor(n / 2)}`;
  const ts = hl7Timestamp(new Date());
  return [
    `MSH|^~\\&|RIS|CITYH|VERDFLOW|VERDFLOW|${ts}||ORM^O01|${run}-${n}|P|2.5.1|||AL|NE`,
    `PID|1||${patient}^^^CITYH^MR||Sample^Patient${Math.floor(n / 2)}`,
    `PV1|1|O|RAD^ROOM${(n % 3) + 1}||||||||||||||||ENC${run}${Math.floor(n / 2)}`,
    `ORC|NW|PL${run}${n}|ACC${run}${n}`,
    `OBR|1|PL${run}${n}|ACC${run}${n}|${s.svc}|${s.pri}|||||||||||||ACC${run}${n}||||||${s.mod}`,
  ].join('\r');
}

async function sendOrders() {
  const run = String(Date.now()).slice(-6);
  for (let n = 0; n < orders; n++) {
    try {
      const r = await fetch(`${api}/integration/hl7`, {
        method: 'POST',
        headers: { authorization: `Bearer ${keys['key:RIS_SOURCE']}`, 'content-type': 'x-application/hl7-v2+er7' },
        body: order(n, run),
      });
      const ack = await r.text();
      console.log(`[source mirth] sent ACC${run}${n} → HTTP ${r.status} ${ack.split('\r')[1] ?? ''}`);
    } catch (err) {
      console.log(`[source mirth] API not reachable: ${(err as Error).message}`);
    }
  }
}

(async () => {
  await heartbeat();
  setInterval(heartbeat, 15_000);
  if (orders > 0) await sendOrders();
  console.log('Simulator running. Press Ctrl+C to stop.');
})();
