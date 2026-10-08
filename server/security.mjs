import { randomBytes } from 'node:crypto';
import { db, nowIso, sha256, uuid } from './db.mjs';

const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-smilecare_session' : 'smilecare_session';
const sessionHours = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12));

export function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}
export function fail(status, code, message) {
  const error = new Error(message); error.status = status; error.code = code; return error;
}
export async function readJson(req, limit = 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw fail(413, 'BODY_TOO_LARGE', 'The submitted form is too large.');
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'INVALID_JSON', 'The request body must be valid JSON.'); }
}
export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2))
    .filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
}
function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export function clearSessionCookie(res) { res.setHeader('set-cookie', cookieOptions(0)); }
export function createSession(userId, res) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + sessionHours * 3600000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(sha256(token), userId, csrfToken, expires, nowIso());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionHours * 3600}${secure}`);
  return { csrfToken, expiresAt: expires };
}
export function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.email,u.role,u.active,
    COALESCE(p.full_name,d.full_name,'') AS full_name, p.phone
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN patients p ON p.user_id=u.id LEFT JOIN doctors d ON d.user_id=u.id
    WHERE s.token_hash=?`).get(sha256(token));
  if (!row || row.active !== 1 || row.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); return null;
  }
  return row;
}
export function requireUser(session) {
  if (!session) throw fail(401, 'AUTH_REQUIRED', 'Please sign in to continue.');
  return session;
}
export function requireRole(session, allowed) {
  requireUser(session);
  if (!allowed.includes(session.role)) throw fail(403, 'FORBIDDEN', 'Your account does not have permission to perform this action.');
  return session;
}
export function verifyMutationOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let expected = process.env.APP_ORIGIN;
  if (!expected) {
    const host = req.headers.host;
    if (!host) throw fail(403, 'ORIGIN_REJECTED', 'This request origin is not allowed.');
    expected = `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${host}`;
  }
  if (origin !== expected) throw fail(403, 'ORIGIN_REJECTED', 'This request origin is not allowed.');
}
export function requireCsrf(req, session) {
  if (!session) return;
  if (!req.headers['x-csrf-token'] || req.headers['x-csrf-token'] !== session.csrf_token) {
    throw fail(403, 'CSRF_REJECTED', 'Your session has expired. Refresh the page and try again.');
  }
}
export function audit(actorId, action, resourceType, resourceId) {
  db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), actorId || null, action, resourceType, String(resourceId), nowIso());
}
