const DB_NAME = 'mylife', DB_VER = 1;
let dbPromise;
const getDB = () => dbPromise ||= new Promise((res, rej) => {
  const req = indexedDB.open(DB_NAME, DB_VER);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    const bs = db.createObjectStore('buttons', { keyPath: 'id', autoIncrement: true });
    ['Going to bed', 'Woke up', 'Going to gym', 'Going to college', 'Returned from college']
      .forEach((label, i) => bs.add({ label, order: i + 1, archived: false }));
    const es = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
    es.createIndex('buttonId', 'buttonId');
    es.createIndex('ts', 'ts');
  };
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

async function tx(store, mode, fn) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

if (navigator.storage?.persist) navigator.storage.persist();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

const p2 = n => String(n).padStart(2, '0');
const fmtTime = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

function localISO(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-', oh = p2(Math.floor(Math.abs(off) / 60)), om = p2(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${s}${oh}:${om}`;
}

function fmtLast(iso) {
  if (!iso) return 'last: never';
  const d = new Date(iso), now = new Date(), t = fmtTime(d);
  if (d.toDateString() === now.toDateString()) return `last: today ${t}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `last: yesterday ${t}`;
  return `last: ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${t}`;
}

const lastTap = {};
let lastEventId = null, toastTimeout = null, cachedButtons = [], activeChart = null;

function showToast(msg, canUndo) {
  clearTimeout(toastTimeout);
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${msg}</span>${canUndo ? '<button id="toast-undo">Undo</button>' : ''}`;
  el.classList.add('visible');
  if (canUndo) document.getElementById('toast-undo').onclick = undoLast;
  toastTimeout = setTimeout(() => el.classList.remove('visible'), 10000);
}

async function undoLast() {
  if (!lastEventId) {
    const evs = await tx('events', 'readonly', s => s.getAll());
    if (evs.length) lastEventId = evs[evs.length - 1].id;
  }
  if (lastEventId) {
    const id = lastEventId;
    lastEventId = null;
    await tx('events', 'readwrite', s => s.delete(id));
    showToast('Entry undone', false);
    await render();
  }
}

async function tapButton(btn) {
  const now = Date.now();
  if (lastTap[btn.id] && now - lastTap[btn.id] < 2000) return;
  lastTap[btn.id] = now;
  lastEventId = await tx('events', 'readwrite', s => s.add({ buttonId: btn.id, ts: localISO() }));
  navigator.vibrate?.(50);
  showToast(`${btn.label} saved, ${fmtTime(new Date())}`, true);
  await render();
}

async function deleteEvent(id) {
  if (id === lastEventId) lastEventId = null;
  await tx('events', 'readwrite', s => s.delete(id));
  await render();
}

async function addCustomButton() {
  const input = document.getElementById('new-btn-input'), label = input.value.trim();
  if (!label) return showToast('Label cannot be empty', false);
  if (cachedButtons.some(b => b.label.toLowerCase() === label.toLowerCase())) return showToast('Button already exists', false);
  const maxOrder = Math.max(0, ...cachedButtons.map(b => b.order || 0));
  await tx('buttons', 'readwrite', s => s.add({ label, order: maxOrder + 1, archived: false }));
  input.value = '';
  showToast(`Added "${label}"`, false);
  await render();
}

async function renameButton(id) {
  const b = cachedButtons.find(x => x.id === id);
  if (!b) return;
  const newLabel = prompt('Rename button:', b.label)?.trim();
  if (!newLabel || newLabel === b.label) return;
  if (cachedButtons.some(x => x.id !== id && x.label.toLowerCase() === newLabel.toLowerCase())) return showToast('Button already exists', false);
  b.label = newLabel;
  await tx('buttons', 'readwrite', s => s.put(b));
  await render();
}

async function reorderButton(id, dir) {
  const idx = cachedButtons.findIndex(b => b.id === id), targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= cachedButtons.length) return;
  const a = cachedButtons[idx], b = cachedButtons[targetIdx];
  const tmp = a.order; a.order = b.order; b.order = tmp;
  await Promise.all([tx('buttons', 'readwrite', s => s.put(a)), tx('buttons', 'readwrite', s => s.put(b))]);
  await render();
}

async function toggleArchive(id) {
  const b = cachedButtons.find(x => x.id === id);
  if (!b) return;
  b.archived = !b.archived;
  await tx('buttons', 'readwrite', s => s.put(b));
  await render();
}

function parsePairs(events) {
  const bedBtn = cachedButtons.find(b => /bed/i.test(b.label));
  const wakeBtn = cachedButtons.find(b => /wake|woke/i.test(b.label));
  if (!bedBtn || !wakeBtn) return [];
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts)), pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].buttonId === bedBtn.id) {
      const bTime = new Date(sorted[i].ts).getTime();
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].buttonId === wakeBtn.id) {
          const dur = (new Date(sorted[j].ts).getTime() - bTime) / 3600000;
          if (dur > 0 && dur <= 16) {
            pairs.push({ date: sorted[i].ts.slice(0, 10), dur: Math.round(dur * 10) / 10 });
            i = j;
          }
          break;
        }
      }
    }
  }
  return pairs;
}

function renderChart(events) {
  if (!window.Chart) return;
  activeChart?.destroy();
  Chart.defaults.color = '#a1a1aa';
  Chart.defaults.borderColor = '#27272a';
  const type = document.getElementById('chart-type').value;
  const btnSelect = document.getElementById('chart-button');
  btnSelect.style.display = type.startsWith('sleep') ? 'none' : 'block';

  const range = document.getElementById('chart-range').value;
  const cutoff = range === 'all' ? 0 : Date.now() - (+range * 86400000);
  const evs = events.filter(e => new Date(e.ts).getTime() >= cutoff);

  let chartConfig;
  if (type === 'tod') {
    const btnId = +btnSelect.value, bEvs = evs.filter(e => e.buttonId === btnId);
    const times = bEvs.map(e => { const d = new Date(e.ts); return d.getHours() + d.getMinutes() / 60; });
    const shList = times.map(h => (h >= 18 ? h - 18 : h + 6));
    const sortedSh = [...shList].sort((a, b) => a - b);
    const useShift = sortedSh.length ? sortedSh[Math.floor(sortedSh.length / 2)] < 12 : false;
    const counts = new Array(48).fill(0);
    times.forEach((h, i) => { const idx = Math.floor((useShift ? shList[i] : h) * 2); if (counts[idx] !== undefined) counts[idx]++; });
    const labels = Array.from({ length: 48 }, (_, i) => {
      const hr = ((useShift ? 18 : 0) + Math.floor(i / 2)) % 24;
      return `${p2(hr)}:${i % 2 ? '30' : '00'}`;
    });
    chartConfig = {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Events', data: counts, backgroundColor: '#6366f1' }] },
      options: { scales: { x: { title: { display: true, text: 'Time of Day (HH:MM)' } }, y: { title: { display: true, text: 'Count' }, beginAtZero: true } } }
    };
  } else if (type === 'date') {
    const btnId = +btnSelect.value, map = {};
    evs.filter(e => e.buttonId === btnId).forEach(e => { const d = e.ts.slice(0, 10); map[d] = (map[d] || 0) + 1; });
    const labels = Object.keys(map).sort();
    chartConfig = {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Count', data: labels.map(d => map[d]), backgroundColor: '#6366f1' }] },
      options: { scales: { x: { title: { display: true, text: 'Date' } }, y: { title: { display: true, text: 'Count (events/day)' }, beginAtZero: true } } }
    };
  } else if (type === 'sleep') {
    const pairs = parsePairs(evs);
    chartConfig = {
      type: 'line',
      data: { labels: pairs.map(p => p.date), datasets: [{ label: 'Sleep (hours)', data: pairs.map(p => p.dur), borderColor: '#6366f1', backgroundColor: '#6366f1', tension: 0.1 }] },
      options: { scales: { x: { title: { display: true, text: 'Night / Date' } }, y: { title: { display: true, text: 'Duration (hours)' }, beginAtZero: true } } }
    };
  } else if (type === 'sleep-hist') {
    const pairs = parsePairs(evs), binLabels = ['<5h', '5-6h', '6-7h', '7-8h', '8-9h', '9-10h', '>10h'], counts = new Array(7).fill(0);
    pairs.forEach(p => {
      const idx = p.dur < 5 ? 0 : p.dur < 6 ? 1 : p.dur < 7 ? 2 : p.dur < 8 ? 3 : p.dur < 9 ? 4 : p.dur <= 10 ? 5 : 6;
      counts[idx]++;
    });
    chartConfig = {
      type: 'bar',
      data: { labels: binLabels, datasets: [{ label: 'Nights', data: counts, backgroundColor: '#6366f1' }] },
      options: { scales: { x: { title: { display: true, text: 'Sleep Duration (hours)' } }, y: { title: { display: true, text: 'Nights' }, beginAtZero: true } } }
    };
  }
  chartConfig.options = { ...chartConfig.options, responsive: true, maintainAspectRatio: false };
  activeChart = new Chart(document.getElementById('chart-canvas'), chartConfig);
}

async function render() {
  const [buttons, events] = await Promise.all([
    tx('buttons', 'readonly', s => s.getAll()),
    tx('events', 'readonly', s => s.getAll())
  ]);
  cachedButtons = buttons.sort((a, b) => a.order - b.order);
  const lastMap = {};
  events.forEach(e => { lastMap[e.buttonId] = e.ts; });

  document.getElementById('button-list').innerHTML = cachedButtons.filter(b => !b.archived).map(b => `
    <button class="btn-action" data-id="${b.id}">
      <span class="btn-label">${b.label}</span>
      <span class="btn-last">${fmtLast(lastMap[b.id])}</span>
    </button>`).join('');

  const btnMap = new Map(cachedButtons.map(b => [b.id, b.label])), recent = events.slice(-100).reverse();
  document.getElementById('history-list').innerHTML = recent.length ? recent.map(e => `
    <li class="history-item">
      <div><div class="hist-label">${btnMap.get(e.buttonId) || 'Deleted'}</div><div class="hist-ts">${e.ts.replace('T', ' ')}</div></div>
      <button class="btn-del" data-id="${e.id}" aria-label="Delete">✕</button>
    </li>`).join('') : '<li class="empty-state">No events recorded yet</li>';

  document.getElementById('manage-list').innerHTML = cachedButtons.map(b => `
    <li class="manage-item ${b.archived ? 'manage-archived' : ''}">
      <span class="manage-label">${b.label}${b.archived ? '<span class="badge-archived">Archived</span>' : ''}</span>
      <div class="manage-btns">
        <button class="btn-icon" data-reorder="${b.id}" data-dir="-1">↑</button>
        <button class="btn-icon" data-reorder="${b.id}" data-dir="1">↓</button>
        <button class="btn-icon" data-rename="${b.id}">✎</button>
        <button class="btn-text" data-archive="${b.id}">${b.archived ? 'Restore' : 'Archive'}</button>
      </div>
    </li>`).join('');

  const btnSelect = document.getElementById('chart-button'), prevVal = btnSelect.value;
  btnSelect.innerHTML = cachedButtons.map(b => `<option value="${b.id}">${b.label}</option>`).join('');
  if (prevVal && cachedButtons.some(b => String(b.id) === prevVal)) btnSelect.value = prevVal;

  if (document.getElementById('graphs-view').classList.contains('active')) renderChart(events);
}

function downloadBlob(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

async function exportLogCSV() {
  const [buttons, events] = await Promise.all([
    tx('buttons', 'readonly', s => s.getAll()),
    tx('events', 'readonly', s => s.getAll())
  ]);
  const map = new Map(buttons.map(b => [b.id, b.label]));
  const rows = events.map(e => `${e.ts},"${(map.get(e.buttonId) || '').replace(/"/g, '""')}"`);
  downloadBlob('events-log.csv', ['timestamp,button', ...rows].join('\n') + (rows.length ? '\n' : ''));
}

async function exportMatrixCSV() {
  const [buttons, events] = await Promise.all([
    tx('buttons', 'readonly', s => s.getAll()),
    tx('events', 'readonly', s => s.getAll())
  ]);
  buttons.sort((a, b) => a.order - b.order);
  const dates = [...new Set(events.map(e => e.ts.slice(0, 10)))].sort();
  const grid = {};
  events.forEach(e => {
    const d = e.ts.slice(0, 10);
    grid[d] = grid[d] || {};
    (grid[d][e.buttonId] = grid[d][e.buttonId] || []).push(e.ts);
  });
  const header = ['date', ...buttons.map(b => `"${b.label.replace(/"/g, '""')}"`)].join(',');
  const rows = dates.map(d => [d, ...buttons.map(b => `"${(grid[d]?.[b.id] || []).join('; ')}"` )].join(','));
  downloadBlob('events-matrix.csv', [header, ...rows].join('\n') + (rows.length ? '\n' : ''));
}

window.seedDemoData = async () => {
  const bs = await tx('buttons', 'readonly', s => s.getAll()), now = new Date(), evs = [];
  const bed = bs.find(b => /bed/i.test(b.label))?.id || 1, wake = bs.find(b => /wake|woke/i.test(b.label))?.id || 2, gym = bs.find(b => /gym/i.test(b.label))?.id || 3;
  for (let i = 30; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i); const postMid = (i % 3 === 0), dNext = new Date(d); dNext.setDate(d.getDate() + 1);
    const bDate = postMid ? dNext : d;
    const bIso = `${bDate.getFullYear()}-${p2(bDate.getMonth()+1)}-${p2(bDate.getDate())}T${postMid ? '00:30:00' : '23:15:00'}${localISO().slice(19)}`;
    const wIso = `${dNext.getFullYear()}-${p2(dNext.getMonth()+1)}-${p2(dNext.getDate())}T07:30:00${localISO().slice(19)}`;
    evs.push({ buttonId: bed, ts: bIso }, { buttonId: wake, ts: wIso });
    if (i % 2 === 0) evs.push({ buttonId: gym, ts: `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}T18:00:00${localISO().slice(19)}` });
  }
  for (const e of evs) await tx('events', 'readwrite', s => s.add(e));
  await render(); console.log(`Seeded ${evs.length} demo events.`);
};

let deferredPrompt = null;
window.addEventListener?.('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('btn-pwa-install');
  if (btn) btn.style.display = 'flex';
});

document.addEventListener('DOMContentLoaded', () => {
  const pwaBtn = document.getElementById('btn-pwa-install');
  if (pwaBtn) {
    pwaBtn.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') pwaBtn.style.display = 'none';
        deferredPrompt = null;
      }
    };
  }
  document.getElementById('button-list').onclick = e => {
    const b = e.target.closest('.btn-action');
    if (b) tapButton(cachedButtons.find(x => x.id === +b.dataset.id));
  };
  document.getElementById('history-list').onclick = e => {
    const d = e.target.closest('.btn-del');
    if (d) deleteEvent(+d.dataset.id);
  };
  document.getElementById('manage-list').onclick = e => {
    const up = e.target.closest('[data-reorder]');
    if (up) return reorderButton(+up.dataset.reorder, +up.dataset.dir);
    const ren = e.target.closest('[data-rename]');
    if (ren) return renameButton(+ren.dataset.rename);
    const arc = e.target.closest('[data-archive]');
    if (arc) return toggleArchive(+arc.dataset.archive);
  };
  document.getElementById('add-btn-submit').onclick = addCustomButton;
  document.getElementById('new-btn-input').onkeydown = e => { if (e.key === 'Enter') addCustomButton(); };
  document.getElementById('chart-type').onchange = () => tx('events', 'readonly', s => s.getAll()).then(renderChart);
  document.getElementById('chart-button').onchange = () => tx('events', 'readonly', s => s.getAll()).then(renderChart);
  document.getElementById('chart-range').onchange = () => tx('events', 'readonly', s => s.getAll()).then(renderChart);
  document.getElementById('btn-undo-history').onclick = undoLast;
  document.getElementById('export-log-btn').onclick = exportLogCSV;
  document.getElementById('export-matrix-btn').onclick = exportMatrixCSV;
  document.querySelectorAll('nav button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.view}-view`).classList.add('active');
      if (btn.dataset.view === 'graphs') tx('events', 'readonly', s => s.getAll()).then(renderChart);
    };
  });
  render();
});
