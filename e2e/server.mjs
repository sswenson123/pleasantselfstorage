// Test harness: serves the static page and a stubbed move-out API.
// Behaviour is switched by query flags so tests can force failures.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Serves the real site files from the repo root — the tests exercise the
// same move-out.html and js/move-out.js that ship.
const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const PORT = Number(process.argv[3] || 8911);
const state = { photos: new Map(), submissions: new Map(), byKey: new Map(), mode: 'ok', calls: [] };

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/__mode') { state.mode = url.searchParams.get('m') || 'ok'; return send(res, 200, { mode: state.mode }); }
  if (url.pathname === '/__state') {
    return send(res, 200, { submissions: [...state.submissions.values()], calls: state.calls, photos: state.photos.size });
  }
  if (url.pathname === '/__reset') { state.photos.clear(); state.submissions.clear(); state.byKey.clear(); state.calls = []; state.mode = 'ok'; return send(res, 200, { ok: true }); }

  if (url.pathname === '/api/photos' && req.method === 'POST') {
    state.calls.push('photo');
    if (state.mode === 'photofail') return send(res, 502, { ok: false, errors: [{ field: 'photo', message: "That photo didn't finish uploading. Please try it again." }] });
    const chunks = []; for await (const c of req) chunks.push(c);
    const id = 'ph_' + Math.random().toString(36).slice(2, 18) + Math.random().toString(36).slice(2, 10);
    state.photos.set(id, { bytes: Buffer.concat(chunks).length });
    return send(res, 201, { ok: true, photoId: id });
  }

  if (url.pathname.startsWith('/api/move-outs/') && req.method === 'POST') {
    const kind = url.pathname.endsWith('scheduled') ? 'scheduled' : 'completed';
    state.calls.push(kind);
    if (state.mode === 'submitfail') return send(res, 500, { ok: false, errors: [{ field: 'form', message: 'Something went wrong on our end. Please try again, or call us at (651) 327-0146.' }] });
    if (state.mode === 'offline') { res.destroy(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (state.byKey.has(payload.idempotencyKey)) {
      const existing = state.submissions.get(state.byKey.get(payload.idempotencyKey));
      return send(res, 200, { ...existing, duplicate: true });
    }
    const id = 'req_' + state.submissions.size;
    const now = new Date();
    const record = kind === 'scheduled'
      ? { ok: true, id, type: 'SCHEDULED_MOVE_OUT', plannedMoveOutDate: payload.plannedMoveOutDate, payload }
      : { ok: true, id, type: 'COMPLETED_MOVE_OUT', unitNumber: String(payload.unitNumber || '').toUpperCase(),
          completedAt: now.toISOString(),
          completedAtLabel: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          photoCount: (payload.photoIds || []).length, payload };
    state.submissions.set(id, record);
    state.byKey.set(payload.idempotencyKey, id);
    return send(res, 201, record);
  }

  const file = url.pathname === '/' ? '/move-out.html' : url.pathname;
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
  // The page reads data-moveout-api="" as same-origin, which is exactly how the
  // preview Worker serves it — so the harness serves the file unmodified.
  send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
});
server.listen(PORT, () => console.log('harness on ' + PORT));
