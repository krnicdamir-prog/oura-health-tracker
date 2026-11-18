(() => {
  'use strict';
  const form = document.querySelector('#auth');
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  const result = document.querySelector('#result');
  const mode = form.dataset.mode;
  const encoder = new TextEncoder();
  function hex(buffer) { return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2,'0')).join(''); }
  function fromHex(x) { return Uint8Array.from(x.match(/.{2}/g), a => parseInt(a,16)); }
  async function derive(password,salt) {
    const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
    const proof = await crypto.subtle.deriveBits({name:'PBKDF2',salt:fromHex(salt),iterations:310000,hash:'SHA-256'},key,256);
    return hex(proof);
  }
  async function post(path, data) {
    const res = await fetch(path, {method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Greška pri prijavi.');
    return body;
  }
  form.addEventListener('submit',async event => {
    event.preventDefault();button.disabled=true;
    result.textContent='Provjeravam podatke...';
    const username=document.querySelector('#username').value.trim().toLowerCase();
    const password=document.querySelector('#password').value;
    try {
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new Error('Korisničko ime: 3–40 znakova, slova, brojevi, točka, crtica ili _.');
      if (mode==='setup') {
        if(password.length<14) throw new Error('Lozinka mora imati najmanje 14 znakova.');
        const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
        const derived=await derive(password,salt);
        const setupKey=document.querySelector('#setupKey').value;
        await post('/setup',{setupKey,username,salt,derived});
        result.textContent='Račun je stvoren. Sada se prijavi.';
        location.assign('/login');
      } else {
        const {salt}=await post('/auth/salt',{username});
        if(!/^[a-f0-9]{32}$/.test(salt)) throw new Error('Neispravni podaci poslužitelja.');
        const derived=await derive(password,salt);
        await post('/login',{username,derived});
        location.assign('/');
      }
    } catch(e) { result.textContent=e.message || 'Pokušaj ponovno.'; button.disabled=false; }
    finally { document.querySelector('#password').value=''; }
  });
})();
