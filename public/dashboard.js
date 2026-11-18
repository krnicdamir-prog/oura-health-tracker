const metrics = [
  ['sleep_score', 'Sleep Score', 'score'],
  ['readiness_score', 'Readiness', 'score'],
  ['activity_score', 'Activity', 'score'],
  ['sleep_minutes', 'Spavanje (h)', 'duration'],
  ['deep_minutes', 'Duboki san (h)', 'duration'],
  ['rem_minutes', 'REM (h)', 'duration'],
  ['hrv', 'HRV (ms)', 'number'],
  ['lowest_pulse', 'Najniži puls (bpm)', 'number'],
  ['temperature_delta', 'Temp. odstupanje (°C)', 'temperature'],
  ['steps', 'Koraci', 'number']
];

const element = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat('hr-HR', {day:'2-digit', month:'2-digit', timeZone:'UTC'});
const monthFormat = new Intl.DateTimeFormat('hr-HR', {month:'short', year:'2-digit', timeZone:'UTC'});
const numberFormat = new Intl.NumberFormat('hr-HR', {maximumFractionDigits:0});
const lastSyncFormat = new Intl.DateTimeFormat('hr-HR', {dateStyle:'short', timeStyle:'short', timeZone:'Europe/Zagreb'});
const tabs = document.querySelectorAll('[data-view]');
const svgNamespace = 'http://www.w3.org/2000/svg';
const oauthResult = new URLSearchParams(location.search).get('oura');
if (oauthResult) history.replaceState(null, '', '/');

let model;
let view = 'daily';
let selected = 6;
let loading = false;

function mean(values) {
  const measured = values.filter(Number.isFinite);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}

function format(value, type) {
  if (!Number.isFinite(value)) return '—';
  if (type === 'duration') {
    const minutes = Math.round(value);
    return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0');
  }
  if (type === 'temperature') return (value > 0 ? '+' : '') + value.toFixed(1).replace('.', ',');
  return numberFormat.format(value);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function groups(snapshot) {
  const today = new Date(snapshot.today + 'T00:00:00Z');
  const byDay = new Map(snapshot.days.map(row => [row.day, row]));
  return Array.from({length:view === 'monthly' ? 14 : 21}, (_, index) => {
    const date = new Date(today);
    if (view === 'monthly') {
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - index);
      const prefix = dayKey(date).slice(0, 7);
      return {label:monthFormat.format(date), rows:snapshot.days.filter(row => row.day.startsWith(prefix))};
    }
    date.setUTCDate(date.getUTCDate() - index);
    const row = byDay.get(dayKey(date));
    return {label:index === 0 ? 'Danas' : dateFormat.format(date), rows:row ? [row] : []};
  });
}

function appendCell(row, tag, value, className) {
  const cell = document.createElement(tag);
  if (className) cell.className = className;
  if (value instanceof Node) cell.append(value);
  else cell.textContent = value;
  row.append(cell);
  return cell;
}

function recent(snapshot, days, key) {
  const start = new Date(snapshot.today + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - days + 1);
  const cutoff = dayKey(start);
  return mean(snapshot.days.filter(row => row.day >= cutoff).map(row => row[key]));
}

function renderTable(periods) {
  const table = element('dataTable');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const [text, className] of [['Pokazatelj','metric-name'],['Ø 7 d','avg'],['Ø 14 d','avg'],...periods.map(period => [period.label])]) {
    appendCell(head, 'th', text, className).scope = 'col';
  }
  const body = table.createTBody();
  metrics.forEach(([key,label,type], index) => {
    const row = body.insertRow();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metricbutton';
    button.textContent = label;
    button.onclick = () => {
      selected = index;
      renderChart(periods);
      element('charts').scrollIntoView({behavior:'smooth', block:'nearest'});
    };
    appendCell(row, 'th', button, 'metric-name').scope = 'row';
    for (const days of [7,14]) appendCell(row, 'td', format(recent(model,days,key),type), 'avg');
    for (const period of periods) {
      const value = mean(period.rows.map(item => item[key]));
      appendCell(row, 'td', format(value,type), value === null ? 'muted' : '');
    }
  });
}

function renderSummary() {
  const cards = [6,7,3,1].map(index => {
    const [key,label,type] = metrics[index];
    const latest = model.days.find(row => Number.isFinite(row[key]));
    const card = document.createElement('article');
    card.className = 'metric';
    for (const [className, text] of [
      ['label',label],
      ['value',format(latest?.[key],type)],
      ['foot',latest ? dateFormat.format(new Date(latest.day + 'T00:00:00Z')) : 'Čeka mjerenje']
    ]) {
      const div = document.createElement('div');
      div.className = className;
      div.textContent = text;
      card.append(div);
    }
    return card;
  });
  element('summary').replaceChildren(...cards);
}

function graphic(parent, tag, attributes, label) {
  const node = document.createElementNS(svgNamespace,tag);
  for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,value);
  if (label) node.textContent = label;
  parent.append(node);
  return node;
}

function renderChart(periods) {
  const [key,label,type] = metrics[selected];
  const svg = element('chart');
  svg.replaceChildren();
  svg.setAttribute('aria-label', 'Trend · ' + label);
  element('chartTitle').textContent = label + ' · ' + (view === 'monthly' ? '14 mjeseci' : '21 dan');
  const ordered = [...periods].reverse();
  const values = ordered.map(period => mean(period.rows.map(item => item[key])));
  const measured = values.filter(Number.isFinite);
  if (!measured.length) {
    graphic(svg,'text',{x:350,y:95,'text-anchor':'middle',fill:'#587087'},'Nema mjerenja u ovom razdoblju.');
    return;
  }
  const min = Math.min(...measured), max = Math.max(...measured);
  const margin = (max - min || 1) * 0.13;
  const lower = min - margin, upper = max + margin;
  const x = index => 66 + index / (values.length - 1) * 609;
  const y = value => 153 - (value - lower) / (upper - lower) * 118;
  for (const tick of new Set([min, (min + max) / 2, max])) {
    graphic(svg,'line',{x1:66,x2:675,y1:y(tick),y2:y(tick),stroke:'#e0e6ee'});
    graphic(svg,'text',{x:55,y:y(tick) + 4,fill:'#526479','text-anchor':'end','font-size':12},format(tick,type));
  }
  for (const index of [0,Math.floor(ordered.length / 2),ordered.length - 1]) {
    graphic(svg,'text',{x:x(index),y:185,fill:'#526479','text-anchor':'middle','font-size':12},ordered[index].label);
  }
  values.forEach((value,index) => {
    if (!Number.isFinite(value)) return;
    if (Number.isFinite(values[index - 1])) {
      graphic(svg,'line',{x1:x(index-1),x2:x(index),y1:y(values[index-1]),y2:y(value),stroke:'#315ed1','stroke-width':3});
    }
    const dot = graphic(svg,'circle',{cx:x(index),cy:y(value),r:3,fill:'#315ed1'});
    graphic(dot,'title',{},ordered[index].label + ' · ' + format(value,type));
  });
}

function renderRecovery() {
  const table = element('recovery');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const label of ['Razdoblje','HRV (ms)','Puls (bpm)']) appendCell(head,'th',label).scope = 'col';
  const body = table.createTBody();
  for (const days of [7,30,90]) {
    const row = body.insertRow();
    appendCell(row,'th',days + ' d').scope = 'row';
    appendCell(row,'td',format(recent(model,days,'hrv'),'number'));
    appendCell(row,'td',format(recent(model,days,'lowest_pulse'),'number'));
  }
}

function render() {
  if (!model) return;
  const {enabled,connection,days,setupIssues} = model;
  const linked = !!connection && connection.state !== 'reconnect';
  element('connect').hidden = !enabled || linked;
  element('refresh').hidden = !linked;
  element('connection').classList.toggle('live',linked);
  element('connection').textContent = linked ? 'Oura povezana' : 'Oura nije povezana';
  const setupMessage = setupIssues?.length
    ? 'U Cloudflareu provjeri postavke ' + setupIssues.join(', ') + '.'
    : 'Oura povezivanje čeka aktivaciju.';
  const message = !enabled ? setupMessage
    : !connection ? 'Poveži svoj Oura račun za uvoz podataka.'
    : !linked ? 'Ponovno poveži Oura račun kako bi se sinkronizacija nastavila.'
    : connection.state === 'retry' ? 'Sinkronizacija će se automatski ponovno pokušati.'
    : connection.importing ? 'Povijest se uvozi od najnovijih prema starijim mjerenjima.'
    : connection.lastSynced ? 'Zadnja sinkronizacija · ' + lastSyncFormat.format(connection.lastSynced * 1000)
    : 'Prvi uvoz je u tijeku.';
  const result = {denied:'Odobrenje Oura pristupa je otkazano. ',invalid:'Povezivanje je isteklo. ',failed:'Oura povezivanje nije uspjelo. '}[oauthResult];
  element('notice').textContent = (result || '') + message;
  element('tableScroll').hidden = !days.length;
  element('empty').hidden = !!days.length;
  element('charts').hidden = !days.length;
  for (const tab of tabs) {
    if (tab.dataset.view === 'trends') continue;
    const active = tab.dataset.view === view;
    tab.classList.toggle('on',active);
    tab.setAttribute('aria-pressed',String(active));
  }
  element('periodLabel').textContent = view === 'monthly' ? 'Mjesečni prosjeci · najnoviji mjesec prvi' : 'Dnevni pregled · najnoviji dan prvi';
  renderSummary();
  if (days.length) {
    const periods = groups(model);
    renderTable(periods);
    renderChart(periods);
    renderRecovery();
  }
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/health', {cache:'no-store'});
    if (response.status === 401) {
      document.querySelector('main').hidden = true;
      location.replace('/login');
      return;
    }
    if (!response.ok) throw new Error('Health data unavailable');
    model = await response.json();
    render();
    document.querySelector('main').hidden = false;
  } catch {
    element('notice').textContent = 'Podaci trenutačno nisu dostupni. Pokušat ću ponovno.';
  } finally {
    loading = false;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    if (tab.dataset.view === 'trends') {
      (element('charts').hidden ? element('empty') : element('charts')).scrollIntoView({behavior:'smooth'});
      return;
    }
    view = tab.dataset.view;
    render();
  });
}

element('connect').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/oura/connect', {method:'POST', redirect:'error'});
    if (!response.ok) throw new Error('Oura unavailable');
    const {destination} = await response.json();
    location.assign(destination);
  } catch {
    element('notice').textContent = 'Povezivanje trenutačno nije dostupno. Učitaj stranicu ponovno.';
    button.disabled = false;
  }
});

element('refresh').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/health/sync', {method:'POST'});
    if (response.status !== 202) throw new Error('Sync unavailable');
    await load();
    setTimeout(load,2000);
  } catch {
    element('notice').textContent = 'Osvježavanje trenutačno nije dostupno.';
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('pageshow', event => {
  if (event.persisted) document.querySelector('main').hidden = true;
  load();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
setInterval(() => {
  if (!document.hidden) load();
},30000);
