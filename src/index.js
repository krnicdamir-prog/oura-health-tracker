import {finishOura, healthSnapshot, ouraEnabled, scheduledSync, startOura, syncOura} from './oura.js';
import migration from '../migrations/0001_oura.sql';

const enc = new TextEncoder();
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_WINDOW = 15 * 60;
const COOKIE_PATTERN = /(?:^|;\s*)__Host-oura_session=([a-f0-9]{64})(?:;|$)/;
const sessionToken = request => (request.headers.get('Cookie') || '').match(COOKIE_PATTERN)?.[1];
const SESSION_COOKIE = "__Host-oura_session";
const now = () => Math.floor(Date.now() / 1000);
const bytesToHex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = size => bytesToHex(crypto.getRandomValues(new Uint8Array(size)));
const validHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const safeEqual = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let v = 0; for (let i = 0; i < a.length; i++) v |= a.charCodeAt(i) ^ b.charCodeAt(i); return v === 0; };
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function digest(s) { return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}
const headers = {
  'Cache-Control':'no-store, private', 'Vary':'Cookie', 'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY', 'X-Robots-Tag':'noindex, nofollow', 'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
function responseHtml(content, status=200, extra={}) { return new Response(content,{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8',...extra}}); }
function responseJson(content, status=200, extra={}) { return new Response(JSON.stringify(content),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...extra}}); }
function redirect(path, cookie) { return new Response(null,{status:303,headers:{...headers,'Location':path,...(cookie?{'Set-Cookie':cookie}:{})}}); }
const setCookie = (token, age = SESSION_SECONDS) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const eraseCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const sameOrigin = request => { try { return new URL(request.headers.get('Origin')).origin === new URL(request.url).origin; } catch { return false; } };
function outer(title, content) {
  return `<!doctype html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f5f7fa"><title>${escapeHtml(title)} · Oura Health Tracker</title><style>*{box-sizing:border-box}html{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#18273b;padding:20px}.box{background:white;border:1px solid #dee6ef;border-radius:18px;width:min(100%,440px);padding:32px}h1{font-size:25px;letter-spacing:-.5px;margin-top:0}label{display:block;margin:17px 0 6px;font-weight:600;font-size:14px}input{width:100%;font:inherit;padding:12px;border:1px solid #ccd7e2;border-radius:9px}button{background:#225dd5;color:#fff;padding:13px 18px;font:inherit;border:0;border-radius:10px;cursor:pointer;width:100%;margin-top:21px}button:disabled{opacity:.55;cursor:wait}.note{font-size:14px;color:#647386;line-height:1.5}.error{color:#a12020;background:#fff1f1;padding:10px;border-radius:9px}.status{color:#526779;font-size:14px}.row{display:flex;justify-content:space-between;gap:15px}a{color:#2354bb}</style></head><body><main class="box">${content}</main></body></html>`;
}
function authPage(mode, message='') {
  const setup = mode === 'setup';
  return outer(setup?'Prvi račun':'Prijava',
    `<h1>◉ Oura Health Tracker</h1><p class="note">${setup?'Jednokratno otvaranje privatnog administratorskog računa.':'Privatni zdravstveni dashboard. Prijava korisničkim imenom i lozinkom.'}</p>` +
    (message?`<p class="error">${escapeHtml(message)}</p>`:'') +
    `<form id="auth" data-mode="${mode}" method="post" autocomplete="on">${setup?'<label for="setupKey">Tajni ključ za prvi pristup</label><input id="setupKey" type="password" autocomplete="off" required>':''}<label for="username">Korisničko ime</label><input id="username" name="username" type="text" value="${setup?'damir':''}" autocomplete="username" minlength="3" maxlength="40" required pattern="[a-zA-Z0-9_.-]+"><label for="password">Lozinka</label><input id="password" name="password" type="password" ${setup?'autocomplete="new-password" minlength="14"':'autocomplete="current-password"'} required>${setup?'<p class="note">Lozinka neka ima najmanje 14 znakova. iPhone je može spremiti u Apple Passwords.</p>':''}<button type="submit">${setup?'Kreiraj račun':'Prijavi se'}</button><p id="result" role="status" aria-live="polite" class="status"></p></form>` +
    `<p class="note">${setup?'Ako nisi vlasnik, zatvori ovu stranicu.':'Za pristup koristi svoj račun ili jednokratnu pozivnicu administratora.'}</p><script src="/auth.js" defer></script>`);
}
function accountPage(user) {
  const invite = user.role === 'admin' ? `<form id="invite-form"><label for="invite-user">Korisničko ime novog korisnika</label><input id="invite-user" pattern="[a-zA-Z0-9_.-]+" minlength="3" maxlength="40" required><button type="submit">Izradi jednokratnu pozivnicu</button><p class="note" id="invite-result" aria-live="polite"></p><input id="invite-url" aria-label="Poveznica za pozivnicu" readonly hidden></form><script src="/account.js" defer></script>` : '';
  return outer('Moj račun', `<h1>Moj račun</h1><p>Korisnik <strong>${escapeHtml(user.username)}</strong></p><p><a href="/">Otvori dashboard</a></p>${invite}<form method="post" action="/logout"><button type="submit">Odjavi se</button></form>`);
}

function invitePage() {
  return outer('Otvori račun', `<h1>Otvori svoj račun</h1><p class="note">Za račun iz pozivnice postavi lozinku s najmanje 14 znakova.</p><form id="auth" data-mode="invite" method="post"><label for="password">Nova lozinka</label><input id="password" type="password" autocomplete="new-password" minlength="14" required><button type="submit">Otvori račun</button><p id="result" role="status"></p></form><script src="/auth.js" defer></script>`);
}
async function postBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('application/json')) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let raw = '', size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(value, {stream:true});
  }
  raw += decoder.decode();
  try { const body = JSON.parse(raw); return body && typeof body === 'object' ? body : null; }
  catch { return null; }
}
async function authenticated(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  const hash = await digest(token);
  return await env.DB.prepare(`SELECT users.id, users.username, users.role, sessions.id AS session_id,
    sessions.expires_at AS session_expires FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.revoked_at IS NULL LIMIT 1`).bind(hash, now()).first();
}
async function countUsers(env) { return Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n); }
async function attemptsKey(request, env, username) {
  const ip = request.headers.get('CF-Connecting-IP') || 'no-ip';
  return {ip:await hmac(env.AUTH_MASTER_KEY, `ip:${ip}`), name:await hmac(env.AUTH_MASTER_KEY,`user:${username}`)};
}
async function reserveAttempt(request, env, username) {
  const {ip, name} = await attemptsKey(request, env, username);
  const id = randomHex(12);
  const cutoff = now() - ATTEMPT_WINDOW;
  const result = await env.DB.prepare(`INSERT INTO auth_attempts(id,ip_hash,username_hash,occurred_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM auth_attempts WHERE ip_hash=? AND occurred_at>?) < 10
    AND (SELECT COUNT(*) FROM auth_attempts WHERE username_hash=? AND occurred_at>?) < 6`)
    .bind(id, ip, name, now(), ip, cutoff, name, cutoff).run();
  return result.meta?.changes === 1 ? id : null;
}
async function clearAttempt(env, id) {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE id=?').bind(id).run();
}
function parseVerifier(record) {
  if (!record || typeof record !== 'string') return null;
  const chunks = record.split('$');
  if (chunks.length !== 3 || chunks[0] !== 'v2' || !validHex(chunks[1],32) || !validHex(chunks[2],64)) return null;
  return {salt:chunks[1], verifier:chunks[2]};
}
async function setup(request,env) {
  if (!sameOrigin(request)) return responseJson({error:'Zahtjev nije prihvaćen.'},403);
  const b = await postBody(request);
  if (!b || typeof b.username !== 'string' || typeof b.setupKey !== 'string' || !validHex(b.salt,32) || !validHex(b.derived,64)) return responseJson({error:'Neispravni podaci.'},400);
  const u = b.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(u)) return responseJson({error:'Neispravno korisničko ime.'},400);
  const a = await reserveAttempt(request,env, 'setup');
  if (!a) return responseJson({error:'Previše pokušaja. Pokušaj kasnije.'},429);
  if (!safeEqual(await digest(b.setupKey),await digest(env.AUTH_MASTER_KEY))) {
    return responseJson({error:'Pogrešan tajni ključ.'},403);
  }
  // Server-secret HMAC means a database leak alone cannot authenticate users.
  const verifier = await hmac(env.AUTH_MASTER_KEY,`v2:${u}:${b.salt}:${b.derived}`);
  const uid = randomHex(16);
  const email = `${uid}@users.invalid`; // Existing schema requires email, not used for login.
  const result = await env.DB.prepare(`INSERT INTO users (id,email,username,password_hash,role)
    SELECT ?,?,?,?,'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`)
    .bind(uid,email,u,`v2$${b.salt}$${verifier}`).run();
  if (result.meta?.changes !== 1) return responseJson({error:'Račun već postoji.'},409);
  return responseJson({ok:true},201);
}
async function login(request,env) {
  if (!sameOrigin(request)) return responseJson({error:'Neispravan zahtjev.'},403);
  const b = await postBody(request);
  if (!b || typeof b.username !== 'string' || !validHex(b.derived,64)) return responseJson({error:'Neispravan zahtjev.'},400);
  const u = b.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(u)) return responseJson({error:'Pogrešno korisničko ime ili lozinka.'},401);
  const a = await reserveAttempt(request,env,u);
  if (!a) return responseJson({error:'Previše pokušaja. Pokušaj za 15 minuta.'},429);
  const user = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(u).first();
  const p = parseVerifier(user?.password_hash);
  const actual = p ? await hmac(env.AUTH_MASTER_KEY,`v2:${u}:${p.salt}:${b.derived}`) : '';
  if (!p || !safeEqual(actual,p.verifier)) {
    return responseJson({error:'Pogrešno korisničko ime ili lozinka.'},401);
  }
  await clearAttempt(env, a);
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
    .bind(randomHex(16),user.id,await digest(token),now()+SESSION_SECONDS,now()).run();
  return responseJson({ok:true},200,{'Set-Cookie':setCookie(token)});
}
async function loginSalt(request,env) {
  if (!sameOrigin(request)) return responseJson({error:'Neispravan zahtjev.'},403);
  const b = await postBody(request);
  const u = typeof b?.username === 'string' ? b.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9_.-]{3,40}$/.test(u)) return responseJson({error:'Neispravno korisničko ime.'},400);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(u).first();
  const p = parseVerifier(row?.password_hash);
  const salt = p?.salt || (await hmac(env.AUTH_MASTER_KEY,`fake-salt:${u}`)).slice(0,32);
  return responseJson({salt});
}
async function logout(request,env) {
  if (!sameOrigin(request)) return responseJson({error:'Neispravan zahtjev.'},403);
  const token = sessionToken(request);
  if (token) await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').bind(now(),await digest(token)).run();
  return redirect('/login',eraseCookie());
}
async function ensureOuraSchema(env) {
  const applied = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='auth_attempts_time'").first();
  if (applied) return;
  await env.DB.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
}

async function createInvite(request, env, user) {
  if (user.role !== 'admin') return responseJson({error:'Samo administrator može pozvati korisnika.'},403);
  const body = await postBody(request);
  const name = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9_.-]{3,40}$/.test(name)) return responseJson({error:'Neispravno korisničko ime.'},400);
  await ensureOuraSchema(env);
  const token = randomHex(32);
  const result = await env.DB.prepare(`INSERT INTO account_invites (token_hash,username,created_by,expires_at)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users WHERE username=? COLLATE NOCASE)`)
    .bind(await digest(token), name, user.id, now() + 86400, name).run();
  if (result.meta.changes !== 1) return responseJson({error:'Korisničko ime već postoji.'},409);
  return responseJson({invite:'/invite#' + token},201);
}

async function redeemInvite(request, env) {
  const body = await postBody(request);
  if (!validHex(body?.token,64) || !validHex(body.salt,32) || !validHex(body.derived,64))
    return responseJson({error:'Pozivnica nije valjana.'},400);
  const hash = await digest(body.token);
  const invite = await env.DB.prepare('SELECT username FROM account_invites WHERE token_hash=? AND expires_at>?')
    .bind(hash,now()).first();
  if (!invite) return responseJson({error:'Pozivnica je iskorištena ili je istekla.'},400);
  const id = randomHex(16);
  const verifier = await hmac(env.AUTH_MASTER_KEY,`v2:${invite.username}:${body.salt}:${body.derived}`);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id,email,username,password_hash,role)
      SELECT ?,?,username,?,'user' FROM account_invites
      WHERE token_hash=? AND expires_at>? AND NOT EXISTS (
        SELECT 1 FROM users WHERE users.username=account_invites.username COLLATE NOCASE)`)
      .bind(id,`${id}@users.invalid`,`v2$${body.salt}$${verifier}`,hash,now()),
    env.DB.prepare('DELETE FROM account_invites WHERE token_hash=?').bind(hash)
  ]);
  return results[0].meta.changes === 1 ? responseJson({ok:true},201)
    : responseJson({error:'Pozivnica više nije valjana.'},409);
}

const wrongMethod = () => responseJson({error:'Metoda nije podržana.'},405);
const forbidden = () => responseJson({error:'Zahtjev nije prihvaćen.'},403);
const unavailable = () => responseJson({error:'Trenutačno nije dostupno.'},503);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (!env.DB || !env.AUTH_MASTER_KEY || env.AUTH_MASTER_KEY.length < 32)
        return responseHtml(outer('Postavke','<h1>Trenutačno nije dostupno</h1>'),503);
      if (method === 'POST' && !sameOrigin(request)) return forbidden();

      if (path === '/auth.js' && method === 'GET') return await serveAsset(request, env);
      if (path === '/setup') {
        if (await countUsers(env)) return redirect('/login');
        if (method === 'GET') return responseHtml(authPage('setup'));
        return method === 'POST' ? await setup(request,env) : wrongMethod();
      }
      if (path === '/login') {
        if (method === 'GET') return responseHtml(authPage('login'));
        return method === 'POST' ? await login(request,env) : wrongMethod();
      }
      if (path === '/auth/salt') return method === 'POST' ? await loginSalt(request,env) : wrongMethod();
      if (path === '/logout') return method === 'POST' ? await logout(request,env) : wrongMethod();
      if (path === '/invite') {
        if (method === 'GET') return responseHtml(invitePage());
        return method === 'POST' ? await redeemInvite(request,env) : wrongMethod();
      }

      const user = await authenticated(request,env);
      if (path.startsWith('/api/')) {
        if (!user) return responseJson({error:'Nisi prijavljen.'},401);
        if (path === '/api/me') return method === 'GET' ? responseJson({username:user.username,role:user.role}) : wrongMethod();
        if (path === '/api/health') return method === 'GET' ? responseJson(await healthSnapshot(env,user)) : wrongMethod();
        if (path === '/api/health/sync') {
          if (method !== 'POST') return wrongMethod();
          if (!ouraEnabled(env)) return unavailable();
          ctx.waitUntil(syncOura(env,user.id,true).catch(() => console.error('Oura sync unavailable')));
          return responseJson({ok:true},202);
        }
        if (path === '/api/invites') return method === 'POST' ? await createInvite(request,env,user) : wrongMethod();
        return responseJson({error:'Nepoznata API funkcija.'},404);
      }

      if (!user) return redirect(await countUsers(env) ? '/login' : '/setup');
      if (path === '/oura/connect') {
        if (method !== 'POST') return wrongMethod();
        if (!ouraEnabled(env) || url.origin !== env.APP_ORIGIN) return unavailable();
        const destination = await startOura(env, user);
        return responseJson({destination},200,{'Set-Cookie':setCookie(sessionToken(request),user.session_expires - now())});
      }
      if (path === '/oura/callback') {
        if (method !== 'GET') return wrongMethod();
        if (!ouraEnabled(env) || url.origin !== env.APP_ORIGIN) return unavailable();
        const status = await finishOura(env,user,url.searchParams);
        if (status === 'connected') ctx.waitUntil(syncOura(env,user.id).catch(() => console.error('Oura sync unavailable')));
        return redirect('/?oura=' + status);
      }
      if (method !== 'GET' && method !== 'HEAD') return wrongMethod();
      if (path === '/account') return responseHtml(accountPage(user));
      return await serveAsset(request, env);
    } catch {
      console.error('Oura Tracker request failed');
      return path.startsWith('/api/') || method === 'POST' ? unavailable()
        : responseHtml(outer('Greška','<h1>Trenutačno nije dostupno</h1>'),503);
    }
  },

  async scheduled(_controller, env) {
    await ensureOuraSchema(env);
    const time = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_attempts WHERE occurred_at<=?').bind(time - ATTEMPT_WINDOW),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=? OR revoked_at<=?').bind(time, time - 3600),
      env.DB.prepare('DELETE FROM oura_oauth_states WHERE expires_at<=?').bind(time),
      env.DB.prepare('DELETE FROM account_invites WHERE expires_at<=?').bind(time)
    ]);
    await scheduledSync(env);
  }
};

async function serveAsset(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const assetHeaders = new Headers(asset.headers);
  for (const [name,value] of Object.entries(headers)) assetHeaders.set(name,value);
  return new Response(asset.body,{status:asset.status,headers:assetHeaders});
}
