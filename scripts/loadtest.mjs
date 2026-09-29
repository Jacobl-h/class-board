#!/usr/bin/env node
// Load test for a deployed class-board Worker. No dependencies: uses Node 24's global WebSocket.
// Usage: node scripts/loadtest.mjs <server-url> [board=loadtest] [clients=75] [seconds=60] [hz=5]
// Set ORIGIN to change the Origin header (default https://jacobl-h.github.io, which the Worker allows).
import { pathToFileURL } from 'node:url';

export const DAILY_BUDGET = 2_000_000;
export const CLASS_MINUTES = 75;
const BOARD_W = 5232;
const BOARD_H = 2992;
const COLOR = '#D85A30';

export const USAGE =
  'Usage: node scripts/loadtest.mjs <server-url> [board=loadtest] [clients=75] [seconds=60] [hz=5]';

export function parseArgs(argv) {
  const [server, board = 'loadtest', clients = '75', seconds = '60', hz = '5'] = argv;
  if (!server) throw new Error(USAGE);
  const num = (name, value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}. ${USAGE}`);
    return n;
  };
  if (!/^[a-z0-9-]{1,40}$/.test(board)) throw new Error(`board must match [a-z0-9-]{1,40}. ${USAGE}`);
  return {
    server,
    board,
    clients: num('clients', clients, 1, 150),
    seconds: num('seconds', seconds, 1, 3600),
    hz: num('hz', hz, 0.1, 6),
  };
}

export function wsUrl(server, board) {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = `/parties/board/${board}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Projects the measured incoming rate onto a class-length session and onto the daily budget. */
export function budgetShare(incomingPerSecond, classMinutes = CLASS_MINUTES, budget = DAILY_BUDGET) {
  const perClass = incomingPerSecond * 60 * classMinutes;
  return {
    perClass,
    share: perClass / budget,
    minutesToPause: incomingPerSecond > 0 ? (budget * 0.9) / incomingPerSecond / 60 : Infinity,
  };
}

export function formatReport(r) {
  const b = budgetShare(r.sent / r.seconds);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const n = (x) => Math.round(x).toLocaleString('en-US');
  return [
    `clients: ${r.connected} connected of ${r.clients} requested, ${r.closedEarly} closed early`,
    `duration: ${r.seconds.toFixed(1)} s`,
    `sent: ${n(r.sent)} messages (${n(r.sent / r.seconds)}/s)`,
    `received: ${n(r.received)} messages (${n(r.received / r.seconds)}/s), of which ${n(r.cursorBatches)} cursor batches, ${n(r.errors)} errors`,
    `server rate changes seen: ${r.rateChanges}`,
    `A ${CLASS_MINUTES}-minute class at this rate sends ${n(b.perClass)} messages, ${pct(b.share)} of the ${n(DAILY_BUDGET)} daily budget.`,
    `Cursors would pause (90%) after ${Number.isFinite(b.minutesToPause) ? b.minutesToPause.toFixed(0) : 'never'} minutes.`,
    'This test moves every cursor nonstop, so real classes use less.',
  ].join('\n');
}

export function runLoadTest(opts, { origin = 'https://jacobl-h.github.io', log = console.log } = {}) {
  const url = wsUrl(opts.server, opts.board);
  const stats = { clients: opts.clients, connected: 0, closedEarly: 0, sent: 0, received: 0, cursorBatches: 0, errors: 0, rateChanges: 0, seconds: opts.seconds };
  const sockets = [];
  const timers = [];
  let finishing = false;

  return new Promise((resolve) => {
    const started = Date.now();
    const finish = () => {
      finishing = true;
      const seconds = (Date.now() - started) / 1000;
      timers.forEach(clearInterval);
      for (const s of sockets) if (s.readyState <= 1) s.close();
      setTimeout(() => resolve({ ...stats, seconds }), 500);
    };

    for (let i = 0; i < opts.clients; i++) {
      timers.push(setTimeout(() => connect(i), i * 20));
    }
    timers.push(setTimeout(finish, opts.seconds * 1000 + opts.clients * 20));

    function connect(i) {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      sockets.push(ws);
      let x = Math.floor(Math.random() * BOARD_W);
      let y = Math.floor(Math.random() * BOARD_H);
      let ticker = null;
      const send = (msg) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(msg));
        stats.sent++;
      };
      const startTicker = (hz) => {
        if (ticker) clearInterval(ticker);
        ticker = null;
        if (hz <= 0) return;
        ticker = setInterval(() => {
          x = Math.min(BOARD_W, Math.max(0, x + Math.round((Math.random() - 0.5) * 200)));
          y = Math.min(BOARD_H, Math.max(0, y + Math.round((Math.random() - 0.5) * 200)));
          send({ type: 'cursor', x, y });
        }, 1000 / hz);
        timers.push(ticker);
      };
      ws.onopen = () => {
        stats.connected++;
        send({ type: 'hello', clientId: crypto.randomUUID(), profile: { name: `Bot ${i + 1}`, color: COLOR, cursor: { kind: 'shape', shape: 'arrow' } } });
        startTicker(opts.hz);
      };
      ws.onmessage = (e) => {
        stats.received++;
        let m = null;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.type === 'cursors') stats.cursorBatches++;
        else if (m.type === 'error') { stats.errors++; if (stats.errors <= 3) log(`server error: ${m.code} ${m.message}`); }
        else if (m.type === 'rate') { stats.rateChanges++; startTicker(Math.min(opts.hz, m.hz)); }
      };
      ws.onerror = () => { if (!finishing) log(`client ${i + 1}: connection error`); };
      ws.onclose = () => {
        if (ticker) clearInterval(ticker);
        if (!finishing) stats.closedEarly++;
      };
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  console.log(`Connecting ${opts.clients} clients to board "${opts.board}" on ${opts.server} for ${opts.seconds} s at ${opts.hz} Hz`);
  runLoadTest(opts, { origin: process.env.ORIGIN ?? 'https://jacobl-h.github.io' }).then((r) => {
    console.log(formatReport(r));
    process.exit(0);
  });
}
