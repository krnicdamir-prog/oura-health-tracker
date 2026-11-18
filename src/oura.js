const authorizeUrl = 'https://developer.ouraring.com/authorize';
const tokenUrl = 'https://api.ouraring.com/oauth/token';
const apiUrl = 'https://api.ouraring.com/v2/usercollection/';
const callbackPath = '/oura/callback';
const userAgent = 'Oura-Health-Tracker/1.0';
const timezone = 'Europe/Zagreb';
const collections = {
  daily_sleep: 'day,score',
  daily_readiness: 'day,score,temperature_deviation',
  daily_activity: 'day,score,steps',
  sleep: 'day,type,total_sleep_duration,deep_sleep_duration,rem_sleep_duration,average_hrv,lowest_heart_rate'
};
const clock = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64url = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async value => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const dayFormat = /^\d{4}-\d{2}-\d{2}$/;

export function ouraSetupIssues(env) {
  const issues = [];
  if (env.OURA_LIVE !== 'true') issues.push('OURA_LIVE');
  for (const name of ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'AUTH_MASTER_KEY', 'APP_ORIGIN']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) issues.push(name);
  }
  return issues;
}

export function ouraEnabled(env) {
  return ouraSetupIssues(env).length === 0;
}

async function tokenCipher(env) {
  const root = await crypto.subtle.importKey('raw', encoder.encode(env.AUTH_MASTER_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(env.APP_ORIGIN),
    info: encoder.encode('oura-health-tracker/token-encryption/v1')
  }, root, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
}

async function seal(key, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(context)}, key, encoder.encode(value));
  return base64url(iv) + '.' + base64url(new Uint8Array(bytes));
}

async function unseal(key, value, context) {
  const [iv, bytes] = value.split('.');
  return decoder.decode(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64url(iv), additionalData: encoder.encode(context)
  }, key, fromBase64url(bytes)));
}

export async function startOura(env, user) {
  const state = randomToken();
  const verifier = randomToken();
  await env.DB.prepare(`INSERT INTO oura_oauth_states (state_hash,session_id,user_id,verifier,expires_at)
    VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    state_hash=excluded.state_hash, verifier=excluded.verifier, expires_at=excluded.expires_at`)
    .bind(await sha256(state), user.session_id, user.id, verifier, clock() + 600).run();
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: env.OURA_CLIENT_ID, redirect_uri: env.APP_ORIGIN + callbackPath,
    scope: 'daily', state, code_challenge: await sha256(verifier), code_challenge_method: 'S256'
  });
  return url.href;
}

class OuraError extends Error {
  constructor(status, retryAfter = 0, reconnect = false) {
    super('Oura request failed');
    this.status = status;
    this.retryAfter = retryAfter;
    this.reconnect = reconnect;
  }
}

async function exchange(env, params) {
  const response = await fetch(tokenUrl, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent},
    body: new URLSearchParams({...params, client_id: env.OURA_CLIENT_ID, client_secret: env.OURA_CLIENT_SECRET})
  });
  if (!response.ok) {
    const error = response.status === 400 ? await response.json().catch(() => null) : null;
    throw new OuraError(response.status, retryDelay(response), error?.error === 'invalid_grant');
  }
  const token = await response.json();
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0)
    throw new Error('Invalid Oura token response');
  return token;
}

function localDay() {
  const date = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const parts = Object.fromEntries(date.map(({type, value}) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(day, count) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function firstHistoryDay(today) {
  const date = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() - 13);
  return date.toISOString().slice(0, 10);
}

function retryDelay(response) {
  const header = response.headers.get('Retry-After');
  if (!header) return 0;
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil(Date.parse(header) / 1000 - clock());
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

async function encryptedCredentials(env, id, generation, token) {
  const key = await tokenCipher(env);
  const [access, refresh] = await Promise.all([
    seal(key, token.access_token, `${id}:${generation}:access`),
    seal(key, token.refresh_token, `${id}:${generation}:refresh`)
  ]);
  return [access, refresh, clock() + Math.floor(token.expires_in)];
}

export async function finishOura(env, user, params) {
  const state = params.get('state') || '';
  if (!tokenFormat.test(state)) return 'invalid';
  const record = await env.DB.prepare(`DELETE FROM oura_oauth_states
    WHERE state_hash=? AND session_id=? AND user_id=? AND expires_at>? RETURNING verifier`)
    .bind(await sha256(state), user.session_id, user.id, clock()).first();
  if (!record) return 'invalid';
  if (params.get('error') === 'access_denied') return 'denied';
  const code = params.get('code');
  if (!code || code.length > 2048) return 'invalid';

  try {
    const token = await exchange(env, {
      grant_type: 'authorization_code', code, code_verifier: record.verifier,
      redirect_uri: env.APP_ORIGIN + callbackPath
    });
    const generation = randomToken();
    const credentials = await encryptedCredentials(env, user.id, generation, token);
    const activeSession = 'EXISTS (SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?)';
    const session = [user.session_id, user.id, clock()];
    // Reauthorization can link a different Oura account. Replace the data and credentials atomically.
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM oura_daily WHERE user_id=? AND ${activeSession}`).bind(user.id, ...session),
      env.DB.prepare(`INSERT INTO oura_connections
        (user_id,generation,access_token,refresh_token,expires_at,history_cursor,next_sync_at)
        SELECT ?,?,?,?,?,?,? WHERE ${activeSession}
        ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation, access_token=excluded.access_token,
        refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, history_cursor=excluded.history_cursor,
        next_sync_at=excluded.next_sync_at, last_synced_at=NULL, lease=NULL, lease_until=0, sync_state='pending'`)
        .bind(user.id, generation, ...credentials, localDay(), clock(), ...session)
    ]);
    return results[1].meta.changes === 1 ? 'connected' : 'invalid';
  } catch {
    return 'failed';
  }
}

async function readCollection(name, access, start, end) {
  const url = new URL(name, apiUrl);
  url.search = new URLSearchParams({start_date: start, end_date: end, fields: collections[name]});
  const rows = [];
  for (let page = 0; page < 5; page++) {
    const response = await fetch(url, {
      redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: {Authorization: `Bearer ${access}`, 'User-Agent': userAgent}
    });
    if (!response.ok) throw new OuraError(response.status, retryDelay(response));
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('Invalid Oura collection response');
    rows.push(...body.data);
    if (!body.next_token) return rows;
    url.searchParams.set('next_token', body.next_token);
  }
  throw new Error('Unexpected Oura pagination');
}

const columns = ['sleep_score', 'readiness_score', 'activity_score', 'sleep_minutes', 'deep_minutes',
  'rem_minutes', 'hrv', 'lowest_pulse', 'temperature_delta', 'steps'];
const number = value => Number.isFinite(value) ? value : null;
const minutes = value => Number.isFinite(value) ? value / 60 : null;

function normalize([sleep, readiness, activity, sessions], start, end) {
  const days = new Map();
  function row(day) {
    if (typeof day !== 'string' || !dayFormat.test(day) || day < start || day > end) return null;
    if (!days.has(day)) days.set(day, {});
    return days.get(day);
  }
  for (const item of sleep) {
    const day = row(item.day);
    if (day) day.sleep_score = number(item.score);
  }
  for (const item of readiness) {
    const day = row(item.day);
    if (day) {
      day.readiness_score = number(item.score);
      day.temperature_delta = number(item.temperature_deviation);
    }
  }
  for (const item of activity) {
    const day = row(item.day);
    if (day) {
      day.activity_score = number(item.score);
      day.steps = number(item.steps);
    }
  }
  const nights = new Map();
  for (const item of sessions) {
    if (item.type !== 'long_sleep' || !row(item.day)) continue;
    const previous = nights.get(item.day);
    if (!previous || (item.total_sleep_duration ?? 0) > (previous.total_sleep_duration ?? 0))
      nights.set(item.day, item);
  }
  for (const [date, night] of nights) {
    Object.assign(days.get(date), {
      sleep_minutes: minutes(night.total_sleep_duration), deep_minutes: minutes(night.deep_sleep_duration),
      rem_minutes: minutes(night.rem_sleep_duration), hrv: number(night.average_hrv),
      lowest_pulse: number(night.lowest_heart_rate)
    });
  }
  return days;
}

const currentLease = 'user_id=? AND generation=? AND lease=?';

async function refreshAccess(env, connection) {
  const {user_id: id, generation, lease, refresh_token: encrypted} = connection;
  const key = await tokenCipher(env);
  const refresh = await unseal(key, encrypted, `${id}:${generation}:refresh`);
  const next = await exchange(env, {grant_type: 'refresh_token', refresh_token: refresh});
  const credentials = await encryptedCredentials(env, id, generation, next);
  const result = await env.DB.prepare(`UPDATE oura_connections
    SET access_token=?, refresh_token=?, expires_at=? WHERE ${currentLease}`)
    .bind(...credentials, id, generation, lease).run();
  return result.meta.changes === 1 ? next.access_token : null;
}

async function pullWindow(env, access, start, end) {
  // Query one extra day to accommodate collections whose upper bound is exclusive.
  const results = await Promise.all(Object.keys(collections).map(name => readCollection(name, access, start, addDays(end, 1))));
  return normalize(results, start, end);
}

async function saveWindow(env, connection, days, nextCursor, start, end) {
  const keys = [connection.user_id, connection.generation, connection.lease];
  const statements = [env.DB.prepare(`DELETE FROM oura_daily WHERE user_id=? AND day BETWEEN ? AND ?
    AND EXISTS (SELECT 1 FROM oura_connections WHERE ${currentLease})`)
    .bind(connection.user_id, start, end, ...keys)];
  for (const [day, row] of days) {
    statements.push(env.DB.prepare(`INSERT INTO oura_daily (user_id,day,${columns.join(',')})
      SELECT ?,?,${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM oura_connections WHERE ${currentLease})`)
      .bind(connection.user_id, day, ...columns.map(col => row[col] ?? null), ...keys));
  }
  statements.push(env.DB.prepare(`UPDATE oura_connections
    SET history_cursor=?, last_synced_at=?, next_sync_at=?, lease=NULL, lease_until=0, sync_state='ready'
    WHERE ${currentLease}`).bind(nextCursor, clock(), clock() + (nextCursor ? 0 : 3600), ...keys));
  await env.DB.batch(statements);
}

export async function syncOura(env, userId, manual = false) {
  if (!ouraEnabled(env)) return false;
  const lease = randomToken();
  const time = clock();
  const connection = await env.DB.prepare(`UPDATE oura_connections SET lease=?, lease_until=?
    WHERE user_id=? AND lease_until<=? AND sync_state<>'reconnect'
    AND (next_sync_at<=? OR (? AND sync_state='ready' AND history_cursor IS NULL AND last_synced_at<=?))
    RETURNING *`).bind(lease, time + 300, userId, time, time, manual ? 1 : 0, time - 300).first();
  if (!connection) return false;

  try {
    const today = localDay();
    const earliest = firstHistoryDay(today);
    const cursor = connection.history_cursor >= earliest ? connection.history_cursor : null;
    const end = cursor || today;
    const start = cursor ? [addDays(end, -29), earliest].sort()[1] : addDays(today, -7);
    const nextCursor = cursor && start > earliest ? addDays(start, -1) : null;
    const key = await tokenCipher(env);
    let access = connection.expires_at > time + 120
      ? await unseal(key, connection.access_token, `${userId}:${connection.generation}:access`)
      : await refreshAccess(env, connection);
    if (!access) return false;
    let days;
    try {
      days = await pullWindow(env, access, start, end);
    } catch (error) {
      if (error.status !== 401 || connection.expires_at <= time + 120) throw error;
      access = await refreshAccess(env, connection);
      if (!access) return false;
      days = await pullWindow(env, access, start, end);
    }
    await saveWindow(env, connection, days, nextCursor, start, end);
    return true;
  } catch (error) {
    const reconnect = error.reconnect || error.status === 401 || error.status === 403;
    await env.DB.prepare(`UPDATE oura_connections SET lease=NULL, lease_until=0, sync_state=?, next_sync_at=?
      WHERE ${currentLease}`).bind(reconnect ? 'reconnect' : 'retry',
      clock() + Math.max(900, error.retryAfter || 0), userId, connection.generation, lease).run();
    return false;
  }
}

export async function scheduledSync(env) {
  if (!ouraEnabled(env)) return;
  const time = clock();
  const {results} = await env.DB.prepare(`SELECT user_id FROM oura_connections
    WHERE lease_until<=? AND next_sync_at<=? AND sync_state<>'reconnect' ORDER BY next_sync_at LIMIT 2`)
    .bind(time, time).all();
  for (const {user_id} of results) await syncOura(env, user_id);
}

export async function healthSnapshot(env, user) {
  const today = localDay();
  const snapshot = {today, enabled: ouraEnabled(env), connection: null, days: []};
  if (!snapshot.enabled) {
    if (user.role === 'admin') snapshot.setupIssues = ouraSetupIssues(env);
    return snapshot;
  }
  const start = firstHistoryDay(today);
  const [status, data] = await env.DB.batch([
    env.DB.prepare('SELECT sync_state AS state, last_synced_at AS lastSynced, history_cursor IS NOT NULL AS importing FROM oura_connections WHERE user_id=?').bind(user.id),
    env.DB.prepare(`SELECT day,${columns.join(',')} FROM oura_daily WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day DESC`)
      .bind(user.id, start, today)
  ]);
  snapshot.connection = status.results[0] || null;
  snapshot.days = data.results;
  return snapshot;
}
