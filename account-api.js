import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const read = req => new Promise((resolve, reject) => { let value = ''; req.on('data', c => { value += c; if (value.length > 1_000_000) reject(new Error('grande demais')); }); req.on('end', () => { try { resolve(JSON.parse(value || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = async (password, salt) => (await scrypt(password, salt, 64)).toString('hex');
const request = async (table, options = {}, query = '') => {
  const response = await fetch(`${base}/rest/v1/${table}${query}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Banco recusou ${table}: ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : null;
};
const session = async req => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!token) return null;
  const rows = await request('account_sessions', {}, `?token_hash=eq.${hash(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=account_id`);
  return rows?.[0] ? { id: rows[0].account_id, token } : null;
};
const accountData = async id => {
  const rows = await request('account_data', {}, `?account_id=eq.${id}&select=services,projects`);
  return rows?.[0] || { services: [], projects: [] };
};
const saveData = (id, patch) => request('account_data', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ account_id: id, ...patch, updated_at: new Date().toISOString() }) });

export async function accountApi(req, res) {
  const url = new URL(req.url, 'http://relay.local');
  if (!url.pathname.startsWith('/v1/account/') && !url.pathname.startsWith('/services')) return false;
  try {
    if (url.pathname === '/v1/account/register' || url.pathname === '/v1/account/login') {
      const input = await read(req); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return reply(res, 400, { error: 'Use um e-mail válido e senha com pelo menos 8 caracteres.' }), true;
      let rows = await request('accounts', {}, `?email=eq.${encodeURIComponent(email)}&select=id,email,password_salt,password_hash`);
      if (url.pathname.endsWith('/register')) {
        if (rows.length) return reply(res, 409, { error: 'Este e-mail já possui uma conta.' }), true;
        const salt = crypto.randomBytes(16).toString('hex');
        rows = await request('accounts', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ email, password_salt: salt, password_hash: await passwordHash(password, salt) }) });
        await saveData(rows[0].id, { services: [], projects: [] });
      } else if (!rows.length || !crypto.timingSafeEqual(Buffer.from(rows[0].password_hash), Buffer.from(await passwordHash(password, rows[0].password_salt)))) return reply(res, 401, { error: 'E-mail ou senha incorretos.' }), true;
      const token = crypto.randomBytes(32).toString('base64url'); const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
      await request('account_sessions', { method: 'POST', body: JSON.stringify({ token_hash: hash(token), account_id: rows[0].id, expires_at: expires }) });
      return reply(res, 200, { token, account: { id: rows[0].id, email }, expiresAt: expires }), true;
    }
    const auth = await session(req); if (!auth) return reply(res, 401, { error: 'Faça login para continuar.' }), true;
    if (url.pathname.startsWith('/services')) {
      const data = await accountData(auth.id); const services = data.services || [];
      const serviceId = req.headers['x-service-id']; const apiId = req.headers['x-api-id']; const service = services.find(item => item.id === serviceId);
      if (req.method === 'GET' && url.pathname === '/services') return reply(res, 200, { services: services.map(item => ({ ...item, apis: (item.apis || []).map(({ token, ...api }) => api) })) }), true;
      if (req.method === 'GET' && url.pathname === '/services/reveal') { const api = service?.apis?.find(item => item.id === apiId); return reply(res, api ? 200 : 404, { api }), true; }
      if (req.method === 'POST') {
        const input = await read(req); const now = Date.now();
        if (url.pathname === '/services' && !serviceId) services.push({ id: crypto.randomBytes(4).toString('hex'), name: String(input.name || '').trim(), createdAt: now, apis: [] });
        else if (url.pathname === '/services' && service) service.name = String(input.name || service.name).trim();
        else if (url.pathname === '/services/apis' && service && !apiId) service.apis.push({ id: crypto.randomBytes(4).toString('hex'), name: String(input.name || '').trim(), envName: `${service.name}_${input.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), token: String(input.token || ''), createdAt: now });
        else if (url.pathname === '/services/apis' && service) { const api = service.apis.find(item => item.id === apiId); if (api) { if (input.name) api.name = input.name; if (input.token) api.token = input.token; } }
        await saveData(auth.id, { services }); const current = services.find(item => item.id === serviceId) || services.at(-1); const api = current?.apis?.find(item => item.id === apiId) || current?.apis?.at(-1);
        return reply(res, 200, url.pathname.endsWith('/apis') ? { api } : { service: current }), true;
      }
      if (req.method === 'DELETE') { if (url.pathname === '/services/apis' && service) service.apis = service.apis.filter(item => item.id !== apiId); else data.services = services.filter(item => item.id !== serviceId); await saveData(auth.id, { services: data.services }); return reply(res, 200, { ok: true }), true; }
    }
    if (url.pathname === '/v1/account/data' && req.method === 'GET') return reply(res, 200, await accountData(auth.id)), true;
    if (url.pathname === '/v1/account/data' && req.method === 'PUT') {
      const input = await read(req); const allowed = {};
      if (Array.isArray(input.services)) allowed.services = input.services;
      if (Array.isArray(input.projects)) allowed.projects = input.projects;
      await saveData(auth.id, allowed); return reply(res, 200, await accountData(auth.id)), true;
    }
    if (url.pathname === '/v1/account/logout' && req.method === 'POST') {
      await request('account_sessions', { method: 'DELETE' }, `?token_hash=eq.${hash(auth.token)}`); return reply(res, 200, { ok: true }), true;
    }
    return reply(res, 404, { error: 'não encontrado' }), true;
  } catch (error) { reply(res, 500, { error: error.message }); return true; }
}
