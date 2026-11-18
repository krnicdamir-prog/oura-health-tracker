// Oura Health Tracker — private access to DEMO dashboard only.
// No health API, Oura credentials, or real health data in this release.
const enc = new TextEncoder();
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_WINDOW = 15 * 60;
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
  'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
function responseHtml(content, status=200, extra={}) { return new Response(content,{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8',...extra}}); }
function responseJson(content, status=200, extra={}) { return new Response(JSON.stringify(content),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...extra}}); }
function redirect(path, cookie) { return new Response(null,{status:303,headers:{...headers,'Location':path,...(cookie?{'Set-Cookie':cookie}:{})}}); }
const setCookie = token => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
const eraseCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
const sameOrigin = request => { try { return new URL(request.headers.get('Origin')).origin === new URL(request.url).origin; } catch { return false; } };
function outer(title, content) {
  return `<!doctype html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f5f7fa"><title>${escapeHtml(title)} · Oura Health Tracker</title><style>*{box-sizing:border-box}html{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#18273b;padding:20px}.box{background:white;border:1px solid #dee6ef;border-radius:18px;width:min(100%,440px);padding:32px}h1{font-size:25px;letter-spacing:-.5px;margin-top:0}label{display:block;margin:17px 0 6px;font-weight:600;font-size:14px}input{width:100%;font:inherit;padding:12px;border:1px solid #ccd7e2;border-radius:9px}button{background:#225dd5;color:#fff;padding:13px 18px;font:inherit;border:0;border-radius:10px;cursor:pointer;width:100%;margin-top:21px}button:disabled{opacity:.55;cursor:wait}.note{font-size:14px;color:#647386;line-height:1.5}.error{color:#a12020;background:#fff1f1;padding:10px;border-radius:9px}.status{color:#526779;font-size:14px}.row{display:flex;justify-content:space-between;gap:15px}a{color:#2354bb}</style></head><body><main class="box">${content}</main></body></html>`;
}
function authPage(mode, message='') {
  const setup = mode === 'setup';
  return outer(setup?'Prvi račun':'Prijava',
    `<h1>◉ Oura Health Tracker</h1><p class="note">${setup?'Jednokratno otvaranje privatnog administratorskog računa.':'Privatni zdravstveni dashboard. Prijava korisničkim imenom i lozinkom.'}</p>` +
    (message?`<p class="error">${escapeHtml(message)}</p>`:'') +
    `<form id="auth" data-mode="${mode}" autocomplete="on">${setup?'<label for="setupKey">Tajni ključ za prvi pristup</label><input id="setupKey" type="password" autocomplete="off" required>':''}<label for="username">Korisničko ime</label><input id="username" name="username" type="text" value="${setup?'damir':''}" autocomplete="username" minlength="3" maxlength="40" required pattern="[a-zA-Z0-9_.-]+"><label for="password">Lozinka</label><input id="password" name="password" type="password" ${setup?'autocomplete="new-password" minlength="14"':'autocomplete="current-password"'} required>${setup?'<p class="note">Lozinka neka ima najmanje 14 znakova. iPhone je može spremiti u Apple Passwords.</p>':''}<button type="submit">${setup?'Kreiraj račun':'Prijavi se'}</button><p id="result" role="status" aria-live="polite" class="status"></p></form>` +
    `<p class="note">${setup?'Ako nisi vlasnik, zatvori ovu stranicu.':'Podaci za sada ostaju demonstracijski, bez povezivanja s Ourom.'}</p><script src="/auth.js" defer></script>`);
}
function accountPage(username) {
 return outer('Moj račun',`<h1>Prijavljen si</h1><p>Korisnik: <strong>${escapeHtml(username)}</strong></p><p class="note">Prijava može ostati aktivna do 30 dana. Ovdje su zasad samo demonstracijski Oura podaci.</p><p><a href="/">Otvori dashboard</a></p><form method="post" action="/logout"><button type="submit">Odjavi se</button></form>`);
}
async function postBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('application/json')) return null;
  const raw = await request.text();
  if (raw.length > 4096) return null;
  try { const body = JSON.parse(raw); return body && typeof body === 'object' ? body : null; }
  catch { return null; }
}
async function authenticated(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)__Host-oura_session=([a-f0-9]{64})(?:;|$)/);
  if (!m) return null;
  const hash = await digest(m[1]);
  return await env.DB.prepare(`SELECT users.id, users.username, users.role FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.revoked_at IS NULL LIMIT 1`).bind(hash, now()).first();
}
async function countUsers(env) { return Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n); }
async function attemptsKey(request, env, username) {
  const ip = request.headers.get('CF-Connecting-IP') || 'no-ip';
  return {ip:await hmac(env.AUTH_MASTER_KEY, `ip:${ip}`), name:await hmac(env.AUTH_MASTER_KEY,`user:${username}`)};
}
async function canTry(request,env,username) {
  const k = await attemptsKey(request,env,username);
  const cutoff = now()-15*60;
  const row = await env.DB.prepare('SELECT SUM(CASE WHEN ip_hash=? THEN 1 ELSE 0 END) AS ipn, SUM(CASE WHEN username_hash=? THEN 1 ELSE 0 END) AS un FROM auth_attempts WHERE occurred_at > ?').bind(k.ip,k.name,cutoff).first();
  return {...k, allowed: Number(row.ipn||0)<10 && Number(row.un||0)<6};
}
async function failure(env, k) {
  await env.DB.prepare('INSERT INTO auth_attempts(id,ip_hash,username_hash,occurred_at) VALUES(?,?,?,?)').bind(randomHex(12),k.ip,k.name,now()).run();
}
function parseVerifier(record) {
  if (!record || typeof record !== 'string') return null;
  const chunks = record.split('$');
  if (chunks.length !== 3 || chunks[0] !== 'v2' || !validHex(chunks[1],32) || !validHex(chunks[2],64)) return null;
  return {salt:chunks[1], verifier:chunks[2]};
}
async function setup(request,env) {
  if (await countUsers(env)>0) return responseJson({error:'Postavljanje je zatvoreno.'},403);
  if (!sameOrigin(request)) return responseJson({error:'Zahtjev nije prihvaćen.'},403);
  const b = await postBody(request);
  if (!b || typeof b.username !== 'string' || typeof b.setupKey !== 'string' || !validHex(b.salt,32) || !validHex(b.derived,64)) return responseJson({error:'Neispravni podaci.'},400);
  const u = b.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(u)) return responseJson({error:'Neispravno korisničko ime.'},400);
  const a = await canTry(request,env, 'setup');
  if (!a.allowed) return responseJson({error:'Previše pokušaja. Pokušaj kasnije.'},429);
  if (!safeEqual(await digest(b.setupKey),await digest(env.AUTH_MASTER_KEY))) {
    await failure(env,a);return responseJson({error:'Pogrešan tajni ključ.'},403);
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
  const a = await canTry(request,env,u);
  if (!a.allowed) return responseJson({error:'Previše pokušaja. Pokušaj za 15 minuta.'},429);
  const user = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(u).first();
  const p = parseVerifier(user?.password_hash);
  const actual = p ? await hmac(env.AUTH_MASTER_KEY,`v2:${u}:${p.salt}:${b.derived}`) : '';
  if (!p || !safeEqual(actual,p.verifier)) {
    await failure(env,a);
    return responseJson({error:'Pogrešno korisničko ime ili lozinka.'},401);
  }
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
  const a = await canTry(request,env,u);
  if (!a.allowed) return responseJson({error:'Previše pokušaja.'},429);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(u).first();
  const p = parseVerifier(row?.password_hash);
  const salt = p?.salt || (await hmac(env.AUTH_MASTER_KEY,`fake-salt:${u}`)).slice(0,32);
  return responseJson({salt});
}
async function logout(request,env) {
  if (!sameOrigin(request)) return responseJson({error:'Neispravan zahtjev.'},403);
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)__Host-oura_session=([a-f0-9]{64})(?:;|$)/);
  if (m) await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').bind(now(),await digest(m[1])).run();
  return redirect('/login',eraseCookie());
}
export default {
  async fetch(request, env) {
    const u = new URL(request.url),path = u.pathname;
    try {
      if (!env.DB || !env.AUTH_MASTER_KEY || String(env.AUTH_MASTER_KEY).length<32)
        return responseHtml(outer('Postavke','<h1>Nedostaje konfiguracija</h1><p class="note">Potrebni su D1 binding DB i Secret AUTH_MASTER_KEY.</p>'),503);
      // Public login assets only. All remaining static assets pass through auth.
      if (path === '/auth.js' && request.method === 'GET') {
        const asset = await env.ASSETS.fetch(request);
        const h=new Headers(asset.headers); for (const [k,v] of Object.entries(headers)) if(k!=='Content-Security-Policy') h.set(k,v);
        return new Response(asset.body,{status:asset.status,headers:h});
      }
      if (path === '/setup') {
        const hasUsers=await countUsers(env);
        if (hasUsers) return redirect('/login');
        if (request.method==='GET') return responseHtml(authPage('setup'));
        if (request.method==='POST') return await setup(request,env);
        return responseJson({error:'Method not allowed'},405);
      }
      if (path === '/login') {
        if(request.method==='GET') return responseHtml(authPage('login'));
        if(request.method==='POST') return await login(request,env);
        return responseJson({error:'Method not allowed'},405);
      }
      if (path === '/auth/salt') {
        if(request.method!=='POST') return responseJson({error:'Method not allowed'},405);
        return await loginSalt(request,env);
      }
      if(path==='/logout') {
        if(request.method!=='POST') return responseJson({error:'Method not allowed'},405);
        return await logout(request,env);
      }
      const user=await authenticated(request,env);
      if (path === '/api/me') return user?responseJson({username:user.username,role:user.role}):responseJson({error:'Nisi prijavljen.'},401);
      if (path.startsWith('/api/')) return responseJson({error:'Nepoznata API funkcija.'},404);
      if (!user) return redirect((await countUsers(env))===0?'/setup':'/login');
      if (path === '/account') return responseHtml(accountPage(user.username));
      if(request.method!=='GET' && request.method!=='HEAD') return responseJson({error:'Method not allowed'},405);
      const asset = await env.ASSETS.fetch(request);
      const h=new Headers(asset.headers);
      for (const [k,v] of Object.entries(headers)) h.set(k,v);
      // Current demo HTML contains inline CSS/JS. No external scripts or health data.
      h.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      return new Response(asset.body,{status:asset.status,headers:h});
    } catch (e) {
      console.error('Oura auth server error (no credential data logged):',String(e?.message||'unknown'));
      return responseHtml(outer('Greška','<h1>Trenutačno nije dostupno</h1><p class="note">Provjeri tablice auth_attempts/sessions u D1 i Secret AUTH_MASTER_KEY. Nisu spremljeni zdravstveni podaci.</p>'),503);
    }
  }
};
