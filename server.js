import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { accountApi } from './account-api.js';

const port = Number(process.env.PORT || 8080);
const desktops = new Map();
const pairingCodes = new Map();
const pendingMobile = new Map();
const rate = new Map();
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const eventPaths = new Set(['/v1/device-status', '/v1/events/device-status']);
const sendDesktopEvent = (desktop, event) => new Promise((resolve, reject) => {
  if (!desktop || desktop.readyState !== WebSocket.OPEN) return reject(new Error('Desktop desconectado'));
  desktop.send(JSON.stringify(event), error => error ? reject(error) : resolve());
});
const body = req => new Promise((resolve, reject) => { let value = ''; req.on('data', c => { value += c; if (value.length > 2_000_000) reject(new Error('grande demais')); }); req.on('end', () => resolve(JSON.parse(value || '{}'))); req.on('error', reject); });
function limited(ip) { const now = Date.now(), values = (rate.get(ip) || []).filter(time => now - time < 60_000); values.push(now); rate.set(ip, values); return values.length > 30; }
async function db(table, method, value, query = '') {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}${query}`, { method, headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: value ? JSON.stringify(value) : undefined });
    if (!response.ok) console.error(`Supabase ${table}: ${response.status}`);
  } catch (error) { console.error(`Supabase ${table}: ${error.message}`); }
}

const server = http.createServer(async (req, res) => {
  if (await accountApi(req, res)) return;
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && req.url?.startsWith('/v1/status')) {
    const desktopId = new URL(req.url, 'http://relay.local').searchParams.get('desktopId');
    const desktop = desktops.get(desktopId);
    return json(res, 200, { online: Boolean(desktop && desktop.readyState === WebSocket.OPEN), llm: desktop?.llm || null });
  }
  if (req.method !== 'POST' || !['/v1/pair', '/v1/chat', '/v1/unpair', ...eventPaths].includes(req.url)) return json(res, 404, { error: 'não encontrado' });
  if (limited(req.socket.remoteAddress)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
  try {
    const data = await body(req);
    const desktopId = req.url === '/v1/pair' ? pairingCodes.get(String(data.code)) : data.desktopId;
    const desktop = desktops.get(desktopId);
    if (!desktop || desktop.readyState !== WebSocket.OPEN) return json(res, 503, { error: 'DavGlassesDesktop não está conectado.' });
    if (eventPaths.has(req.url)) {
      await sendDesktopEvent(desktop, { type: 'device.status', deviceId: data.deviceId, deviceName: data.deviceName, token: data.token, battery: data.battery || null });
      return json(res, 202, { ok: true });
    }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { pendingMobile.delete(requestId); if (!res.writableEnded) json(res, 504, { error: 'O Desktop não respondeu.' }); }, 10 * 60_000);
    pendingMobile.set(requestId, { res, events: [], timeout, stream: req.url === '/v1/chat' });
    desktop.send(JSON.stringify(req.url === '/v1/pair' ? { type: 'pair.request', requestId, code: data.code, deviceName: data.deviceName } : req.url === '/v1/unpair' ? { type: 'unpair.request', requestId, deviceId: data.deviceId, token: data.token } : { type: 'chat.ask', requestId, deviceId: data.deviceId, deviceName: data.deviceName, token: data.token, conversationId: data.conversationId, text: data.text }));
    if (req.url === '/v1/chat') res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  } catch { json(res, 400, { error: 'Requisição inválida.' }); }
});
const wss = new WebSocketServer({ server, path: '/v1/desktop' });
wss.on('connection', (socket, request) => {
  const desktopId = request.headers['x-desktop-id']; if (!desktopId) return socket.close(1008, 'desktopId ausente');
  desktops.get(desktopId)?.close(); desktops.set(desktopId, socket);
  db('desktop_instances', 'POST', { desktop_id: desktopId, last_seen_at: new Date().toISOString() });
  socket.on('error', error => console.error(`WebSocket Desktop ${desktopId}: ${error.message}`));
  socket.on('message', raw => {
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.type === 'desktop.online' || event.type === 'pairing.code') {
      if (event.type === 'desktop.online') socket.llm = event.llm || null;
      for (const [code, owner] of pairingCodes) if (owner === desktopId) pairingCodes.delete(code);
      if (event.pairing?.code && event.pairing.expiresAt > Date.now()) {
        pairingCodes.set(String(event.pairing.code), desktopId);
        setTimeout(() => { if (pairingCodes.get(String(event.pairing.code)) === desktopId) pairingCodes.delete(String(event.pairing.code)); }, Math.max(0, event.pairing.expiresAt - Date.now())).unref?.();
      }
      return;
    }
    const pending = pendingMobile.get(event.requestId); if (!pending) return;
    if (event.type === 'pair.result' && event.ok && event.credentials) {
      const tokenHash = crypto.createHash('sha256').update(String(event.credentials.token || '')).digest('hex');
      db('paired_devices', 'POST', { device_id: event.credentials.deviceId, desktop_id: desktopId, token_hash: tokenHash, device_name: event.credentials.deviceName || null, last_seen_at: new Date().toISOString() });
      db('relay_events', 'POST', { desktop_id: desktopId, device_id: event.credentials.deviceId, event_type: 'paired' });
    }
    if (pending.stream) {
      pending.res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!['chat.done', 'error'].includes(event.type)) return;
      pending.res.end();
    } else { json(pending.res, event.ok ? 200 : 401, event); }
    clearTimeout(pending.timeout); pendingMobile.delete(event.requestId);
  });
  socket.on('close', () => { if (desktops.get(desktopId) === socket) desktops.delete(desktopId); for (const [code, owner] of pairingCodes) if (owner === desktopId) pairingCodes.delete(code); });
});
server.listen(port, '0.0.0.0', () => console.log(`DavGlasses Relay na porta ${port}`));
