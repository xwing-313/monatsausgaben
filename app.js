/* Monatsausgaben – wiederkehrende Ausgaben und Einnahmen.
   Alle Daten bleiben lokal im localStorage dieses Geräts. */
'use strict';

/* ---------- Konstanten ---------- */

const APP_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;          // Bei Änderungen am Datenformat erhöhen und unten eine Migration ergänzen
const STORAGE_KEY = 'monatsausgaben';
const BACKUP_REMINDER_DAYS = 30;

const DEFAULT_CATEGORIES = {
  expense: ['Wohnen', 'Versicherungen', 'Abos & Medien', 'Telefon & Internet', 'Mobilität', 'Sport & Freizeit', 'Sparen & Vorsorge', 'Sonstiges'],
  income: ['Gehalt', 'Nebenjob', 'Unterstützung', 'Sonstiges']
};

const INTERVAL_PRESETS = [
  { key: 'w1', unit: 'week', every: 1, label: 'Wöchentlich' },
  { key: 'w2', unit: 'week', every: 2, label: 'Alle 2 Wochen' },
  { key: 'm1', unit: 'month', every: 1, label: 'Monatlich' },
  { key: 'm2', unit: 'month', every: 2, label: 'Alle 2 Monate' },
  { key: 'm3', unit: 'month', every: 3, label: 'Vierteljährlich' },
  { key: 'm6', unit: 'month', every: 6, label: 'Halbjährlich' },
  { key: 'm12', unit: 'month', every: 12, label: 'Jährlich' }
];

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/* Migrationen: MIGRATIONS[n] wandelt Daten von Schema n in Schema n+1 um.
   Beispiel für später:  1: (d) => { d.items.forEach(i => { i.prices = [{ from: i.startDate, amount: i.amount }]; }); } */
const MIGRATIONS = {};

/* ---------- Datums-Helfer (ohne Zeitzonen-Fallen) ---------- */

const pad = (n) => String(n).padStart(2, '0');
const D = {
  parse(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; },
  iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; },
  dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); },
  num(s) { const { y, m, d } = D.parse(s); return Date.UTC(y, m - 1, d) / 864e5; },
  fromNum(n) { const t = new Date(n * 864e5); return D.iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); },
  today() { const t = new Date(); return D.iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); },
  mi(y, m) { return y * 12 + (m - 1); },
  addMonths(ym, k) { const i = D.mi(ym.y, ym.m) + k; return { y: Math.floor(i / 12), m: (i % 12) + 1 }; },
  valid(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const { y, m, d } = D.parse(s);
    return m >= 1 && m <= 12 && d >= 1 && d <= D.dim(y, m);
  },
  short(s) { const { m, d } = D.parse(s); return `${pad(d)}.${pad(m)}.`; },
  long(s) { const { y, m, d } = D.parse(s); return `${pad(d)}.${pad(m)}.${y}`; }
};

const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmt = (n) => money.format(Math.round(n * 100) / 100 + 0);

/* ---------- Rechenlogik ---------- */

function intervalLabel(iv) {
  const preset = INTERVAL_PRESETS.find((p) => p.unit === iv.unit && p.every === iv.every);
  if (preset) return preset.label.toLowerCase();
  return iv.unit === 'week' ? `alle ${iv.every} Wochen` : `alle ${iv.every} Monate`;
}

function isMonthly(item) { return item.interval.unit === 'month' && item.interval.every === 1; }

/** Durchschnittlicher Betrag pro Monat (Quartal ÷ 3, Jahr ÷ 12, Woche × 52,18 ÷ 12) */
function monthlyAverage(item) {
  const every = item.interval.every;
  if (item.interval.unit === 'week') return item.amount * (365.25 / 12) / (7 * every);
  return item.amount / every;
}

/** Alle Zahlungstermine eines Eintrags im Monat y/m */
function occurrencesInMonth(item, y, m) {
  const start = D.parse(item.startDate);
  const end = item.endDate ? D.num(item.endDate) : Infinity;
  const every = item.interval.every;

  if (item.interval.unit === 'month') {
    const diff = D.mi(y, m) - D.mi(start.y, start.m);
    if (diff < 0 || diff % every !== 0) return [];
    const date = D.iso(y, m, Math.min(start.d, D.dim(y, m)));
    return D.num(date) > end ? [] : [date];
  }

  const step = 7 * every;
  const s = D.num(item.startDate);
  const first = D.num(D.iso(y, m, 1));
  const last = D.num(D.iso(y, m, D.dim(y, m)));
  if (last < s) return [];
  const out = [];
  for (let t = s + Math.max(0, Math.ceil((first - s) / step)) * step; t <= last && t <= end; t += step) {
    out.push(D.fromNum(t));
  }
  return out;
}

/** Läuft der Eintrag (zumindest teilweise) im Monat y/m? */
function isActiveInMonth(item, y, m) {
  const first = D.iso(y, m, 1);
  const last = D.iso(y, m, D.dim(y, m));
  return item.startDate <= last && (!item.endDate || item.endDate >= first);
}

function isEnded(item, today = D.today()) { return !!item.endDate && item.endDate < today; }

function nextOccurrence(item, from = D.today()) {
  if (item.endDate && item.endDate < from) return null;
  const f = D.parse(from);
  const limit = (item.interval.unit === 'month' ? item.interval.every : 1) + 2;
  for (let k = 0; k <= limit; k++) {
    const ym = D.addMonths(f, k);
    const hit = occurrencesInMonth(item, ym.y, ym.m).find((d) => d >= from);
    if (hit) return hit;
  }
  return null;
}

function monthSummary(y, m, items = state.items) {
  const res = {
    avg: { income: 0, expense: 0 },
    actual: { income: 0, expense: 0 },
    payments: [],
    categories: {}
  };
  for (const item of items) {
    if (isActiveInMonth(item, y, m)) {
      const avg = monthlyAverage(item);
      res.avg[item.type] += avg;
      if (item.type === 'expense') res.categories[item.category] = (res.categories[item.category] || 0) + avg;
    }
    for (const date of occurrencesInMonth(item, y, m)) {
      res.actual[item.type] += item.amount;
      res.payments.push({ item, date, amount: item.amount });
    }
  }
  res.payments.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  return res;
}

/* ---------- Daten laden, prüfen, speichern ---------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [],
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
    settings: { theme: 'system', lastBackupAt: null }
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = Number(raw.amount);
  const iv = raw.interval || {};
  const every = Math.round(Number(iv.every));
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (!(amount > 0) || !D.valid(raw.startDate)) return null;
  if (!['week', 'month'].includes(iv.unit) || !(every >= 1 && every <= 120)) return null;
  return {
    ...raw, // unbekannte Felder aus neueren Versionen bleiben erhalten
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    type: raw.type === 'income' ? 'income' : 'expense',
    name: raw.name.trim().slice(0, 60),
    amount: Math.round(amount * 100) / 100,
    interval: { unit: iv.unit, every },
    startDate: raw.startDate,
    endDate: D.valid(raw.endDate) && raw.endDate >= raw.startDate ? raw.endDate : null,
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'Sonstiges',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : ''
  };
}

function normalize(d) {
  const base = defaultState();
  const cats = d.categories || {};
  const list = (arr, fallback) => (Array.isArray(arr) && arr.length ? [...new Set(arr.filter((c) => typeof c === 'string' && c.trim()))] : fallback);
  return {
    ...d,
    schemaVersion: SCHEMA_VERSION,
    items: Array.isArray(d.items) ? d.items.map(normalizeItem).filter(Boolean) : [],
    categories: { expense: list(cats.expense, base.categories.expense), income: list(cats.income, base.categories.income) },
    settings: { ...base.settings, ...(d.settings || {}) }
  };
}

function migrate(input) {
  if (!input || typeof input !== 'object') throw new Error('Die Datei enthält keine gültigen Daten.');
  const d = JSON.parse(JSON.stringify(input));
  let v = Number(d.schemaVersion) || 1;
  if (v > SCHEMA_VERSION) throw new Error('Das Backup stammt aus einer neueren App-Version. Lade die App neu und versuche es nochmal.');
  while (v < SCHEMA_VERSION) {
    if (MIGRATIONS[v]) MIGRATIONS[v](d);
    v++;
  }
  d.schemaVersion = SCHEMA_VERSION;
  return normalize(d);
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.error(err);
    // Unlesbare Daten nicht überschreiben, sondern beiseitelegen
    try { if (raw) localStorage.setItem(`${STORAGE_KEY}-unlesbar-${Date.now()}`, raw); } catch (_) { /* ignorieren */ }
    setTimeout(() => toast('Gespeicherte Daten waren unlesbar. Stell ein Backup wieder her.'), 400);
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error(err);
    toast('Speichern fehlgeschlagen. Ist der Speicher voll?');
    return false;
  }
}

let state = load();
const ui = {
  tab: 'overview',
  month: (() => { const t = D.parse(D.today()); return { y: t.y, m: t.m }; })(),
  entryFilter: 'active',
  pendingReload: false
};

/* ---------- Kleine UI-Helfer ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function parseAmount(input) {
  let s = String(input || '').replace(/[\s€]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.234 = Tausenderpunkt
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100) / 100;
}

function amountToInput(n) { return n.toFixed(2).replace('.', ','); }

const ICON = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
};

/** Takt-Leiste: zeigt für die nächsten 12 Monate, in welchen Monaten gezahlt wird */
function rhythmStrip(item, from) {
  let html = '';
  let label = [];
  for (let k = 0; k < 12; k++) {
    const ym = D.addMonths(from, k);
    const hits = occurrencesInMonth(item, ym.y, ym.m).length;
    const active = isActiveInMonth(item, ym.y, ym.m);
    if (hits) label.push(MONTHS[ym.m - 1]);
    html += `<span class="beat${hits ? ' on' : ''}${active ? '' : ' off'}"><i></i><small>${MONTH_INITIALS[ym.m - 1]}</small></span>`;
  }
  const aria = label.length === 0 ? 'In den nächsten 12 Monaten keine Zahlung'
    : label.length === 12 ? 'Zahlung in jedem der nächsten 12 Monate'
    : `Zahlung in ${label.join(', ')}`;
  return `<span class="rhythm" role="img" aria-label="${esc(aria)}">${html}</span>`;
}

/* ---------- Ansichten ---------- */

function renderOverview() {
  const { y, m } = ui.month;
  const monthName = MONTHS[m - 1];
  const today = D.parse(D.today());
  const isCurrent = today.y === y && today.m === m;

  const header = `
    <header class="topbar">
      <div class="month-nav">
        <button class="icon-btn" type="button" data-action="prev-month" aria-label="Vorheriger Monat">${ICON.prev}</button>
        <button class="month-title" type="button" data-action="this-month" aria-label="Zum aktuellen Monat">
          <span>${monthName}</span><small>${y}</small>
        </button>
        <button class="icon-btn" type="button" data-action="next-month" aria-label="Nächster Monat">${ICON.next}</button>
      </div>
      ${isCurrent ? '' : '<button class="today-btn" type="button" data-action="this-month">Heute</button>'}
      <button class="add-btn" type="button" data-action="add" aria-label="Eintrag hinzufügen">${ICON.plus}</button>
    </header>`;

  if (state.items.length === 0) {
    return header + `
      <section class="empty">
        <div class="empty-rhythm" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
        <h2>Noch nichts eingetragen</h2>
        <p>Trag deine wiederkehrenden Ausgaben und Einnahmen ein, egal ob monatlich, vierteljährlich oder jährlich. Die App rechnet aus, was dich ein Monat im Schnitt kostet und was wirklich abgebucht wird.</p>
        <button class="btn primary" type="button" data-action="add">Ersten Eintrag anlegen</button>
      </section>`;
  }

  const s = monthSummary(y, m);
  const netAvg = s.avg.income - s.avg.expense;
  const netAct = s.actual.income - s.actual.expense;
  const diff = s.actual.expense - s.avg.expense;

  const rare = s.payments.filter((p) => p.item.type === 'expense' && !isMonthly(p.item));
  const rareNames = [...new Set(rare.map((p) => p.item.name))];
  let note;
  if (Math.abs(diff) < 0.5) {
    note = `Im ${monthName} wird genau so viel abgebucht wie im Schnitt.`;
  } else if (diff > 0) {
    note = `Im ${monthName} zahlst du <b>${fmt(diff)} mehr</b> als im Schnitt. Fällig ${rareNames.length === 1 ? 'wird' : 'werden'} ${esc(listJoin(rareNames))}.`;
  } else {
    note = `Im ${monthName} zahlst du <b>${fmt(-diff)} weniger</b> als im Schnitt, weil seltenere Zahlungen diesmal nicht fällig sind.`;
  }

  const backupBanner = backupReminder();

  const payments = s.payments.length
    ? s.payments.map((p) => `
        <li>
          <button class="pay" type="button" data-action="edit" data-id="${esc(p.item.id)}">
            <span class="pay-date"><b>${D.parse(p.date).d}.</b></span>
            <span class="pay-text"><span class="pay-name">${esc(p.item.name)}</span><small>${esc(intervalLabel(p.item.interval))}</small></span>
            <span class="pay-amount ${p.item.type}">${p.item.type === 'income' ? '+' : '−'}${fmt(p.amount)}</span>
          </button>
        </li>`).join('')
    : `<li class="muted-row">In diesem Monat ist keine Zahlung fällig.</li>`;

  const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  const catHtml = cats.length
    ? cats.map(([name, val]) => `
        <li class="cat">
          <div class="cat-top"><span>${esc(name)}</span><span>${fmt(val)}</span></div>
          <div class="cat-bar"><i style="width:${Math.max(2, (val / maxCat) * 100).toFixed(1)}%"></i></div>
        </li>`).join('')
    : `<li class="muted-row">Keine laufenden Ausgaben in diesem Monat.</li>`;

  return header + `
    ${backupBanner}
    <section class="ledger" aria-label="Monatsbilanz">
      <div class="ledger-row ledger-head">
        <span></span><span>Im Schnitt</span><span>Im ${monthName}</span>
      </div>
      <div class="ledger-row out">
        <span>Ausgaben</span><b>${fmt(s.avg.expense)}</b><b>${fmt(s.actual.expense)}</b>
      </div>
      <div class="ledger-row in">
        <span>Einnahmen</span><b>${fmt(s.avg.income)}</b><b>${fmt(s.actual.income)}</b>
      </div>
      <div class="ledger-row net">
        <span>Übrig</span><b class="${netAvg < 0 ? 'neg' : ''}">${fmt(netAvg)}</b><b class="${netAct < 0 ? 'neg' : ''}">${fmt(netAct)}</b>
      </div>
    </section>
    <p class="ledger-note">${note}</p>

    <section class="block">
      <h2>Zahlungen im ${monthName}</h2>
      <ul class="pay-list">${payments}</ul>
    </section>

    <section class="block">
      <h2>Ausgaben nach Kategorie <small>im Schnitt pro Monat</small></h2>
      <ul class="cat-list">${catHtml}</ul>
    </section>`;
}

function listJoin(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' und ' + arr[arr.length - 1];
}

function backupReminder() {
  if (state.items.length === 0) return '';
  const last = state.settings.lastBackupAt;
  const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 864e5) : null;
  if (days !== null && days < BACKUP_REMINDER_DAYS) return '';
  const text = days === null ? 'Du hast noch kein Backup gesichert.' : `Dein letztes Backup ist ${days} Tage alt.`;
  return `
    <div class="banner">
      <span>${text}</span>
      <button class="btn small" type="button" data-action="export">Jetzt sichern</button>
    </div>`;
}

function renderEntries() {
  const today = D.today();
  const from = D.parse(today);
  const active = state.items.filter((i) => !isEnded(i, today));
  const ended = state.items.filter((i) => isEnded(i, today));
  const list = ui.entryFilter === 'ended' ? ended : active;

  const section = (type, title) => {
    const items = list.filter((i) => i.type === type).sort((a, b) => monthlyAverage(b) - monthlyAverage(a));
    if (!items.length) return '';
    const total = items.reduce((sum, i) => sum + monthlyAverage(i), 0);
    const rows = items.map((item) => {
      const next = nextOccurrence(item, today);
      let foot;
      if (isEnded(item, today)) foot = `Beendet am ${D.long(item.endDate)}`;
      else if (item.endDate) foot = `Nächste ${next ? D.short(next) : '–'}<br>endet ${D.long(item.endDate)}`;
      else foot = next ? `Nächste ${D.short(next)}` : '';
      return `
        <li>
          <button class="entry${isEnded(item, today) ? ' ended' : ''}" type="button" data-action="edit" data-id="${esc(item.id)}">
            <span class="entry-main">
              <span class="entry-name">${esc(item.name)}</span>
              <span class="entry-amount ${item.type}">${fmt(item.amount)}</span>
            </span>
            <span class="entry-sub">
              <span>${esc(item.category)}, ${esc(intervalLabel(item.interval))}</span>
              ${isMonthly(item) ? '' : `<span>≈ ${fmt(monthlyAverage(item))} / Monat</span>`}
            </span>
            <span class="entry-foot">
              ${rhythmStrip(item, from)}
              <span class="entry-next">${foot}</span>
            </span>
          </button>
        </li>`;
    }).join('');
    const totalLabel = ui.entryFilter === 'ended' ? '' : `<small>${fmt(total)} / Monat im Schnitt</small>`;
    return `<section class="block"><h2>${title} ${totalLabel}</h2><ul class="entry-list">${rows}</ul></section>`;
  };

  const body = section('expense', 'Ausgaben') + section('income', 'Einnahmen');
  const empty = ui.entryFilter === 'ended'
    ? `<p class="empty-text">Noch nichts beendet. Wenn du etwas kündigst, öffne den Eintrag und trag den letzten Tag ein. Vergangene Monate bleiben dann richtig.</p>`
    : `<section class="empty"><div class="empty-rhythm" aria-hidden="true">${'<i></i>'.repeat(12)}</div><h2>Keine laufenden Einträge</h2><p>Lege deine erste Ausgabe oder Einnahme an.</p><button class="btn primary" type="button" data-action="add">Eintrag anlegen</button></section>`;

  return `
    <header class="topbar">
      <h1>Einträge</h1>
      <button class="add-btn" type="button" data-action="add" aria-label="Eintrag hinzufügen">${ICON.plus}</button>
    </header>
    <div class="segmented" role="radiogroup" aria-label="Filter">
      <button type="button" role="radio" aria-checked="${ui.entryFilter === 'active'}" data-action="filter" data-value="active">Laufend <span>${active.length}</span></button>
      <button type="button" role="radio" aria-checked="${ui.entryFilter === 'ended'}" data-action="filter" data-value="ended">Beendet <span>${ended.length}</span></button>
    </div>
    ${body || empty}`;
}

function renderSettings() {
  const last = state.settings.lastBackupAt;
  const lastText = last ? `Letztes Backup am ${D.long(D.iso(new Date(last).getFullYear(), new Date(last).getMonth() + 1, new Date(last).getDate()))}` : 'Noch kein Backup gesichert';
  const theme = state.settings.theme;
  const catList = (type) => state.categories[type].map((c) => `
      <li><span>${esc(c)}</span><button class="icon-btn small" type="button" data-action="delete-category" data-type="${type}" data-value="${esc(c)}" aria-label="Kategorie ${esc(c)} entfernen">${ICON.trash}</button></li>`).join('');

  return `
    <header class="topbar"><h1>Einstellungen</h1></header>

    <section class="block">
      <h2>Datensicherung</h2>
      <p class="block-text">Deine Daten liegen nur auf diesem iPhone. Sichere sie regelmäßig als Datei, zum Beispiel in iCloud Drive über „In Dateien sichern“.</p>
      <div class="action-list">
        <button type="button" data-action="export">${ICON.share}<span>Backup sichern</span></button>
        <button type="button" data-action="import">${ICON.restore}<span>Backup wiederherstellen</span></button>
      </div>
      <p class="meta">${lastText}</p>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>

    <section class="block">
      <h2>Darstellung</h2>
      <div class="segmented" role="radiogroup" aria-label="Darstellung">
        <button type="button" role="radio" aria-checked="${theme === 'system'}" data-action="theme" data-value="system">Automatisch</button>
        <button type="button" role="radio" aria-checked="${theme === 'light'}" data-action="theme" data-value="light">Hell</button>
        <button type="button" role="radio" aria-checked="${theme === 'dark'}" data-action="theme" data-value="dark">Dunkel</button>
      </div>
    </section>

    <section class="block">
      <h2>Kategorien für Ausgaben</h2>
      <ul class="cat-edit">${catList('expense')}</ul>
      <form class="inline-add" data-type="expense"><input name="cat" maxlength="30" placeholder="Neue Kategorie" aria-label="Neue Kategorie für Ausgaben"><button class="btn small" type="submit">Hinzufügen</button></form>
    </section>

    <section class="block">
      <h2>Kategorien für Einnahmen</h2>
      <ul class="cat-edit">${catList('income')}</ul>
      <form class="inline-add" data-type="income"><input name="cat" maxlength="30" placeholder="Neue Kategorie" aria-label="Neue Kategorie für Einnahmen"><button class="btn small" type="submit">Hinzufügen</button></form>
    </section>

    <section class="block">
      <h2>Über die App</h2>
      <p class="block-text">Version ${APP_VERSION} (Datenformat ${SCHEMA_VERSION}). ${state.items.length} ${state.items.length === 1 ? 'Eintrag' : 'Einträge'} gespeichert. Keine Konten, keine Server, keine Weitergabe von Daten.</p>
      <button class="btn danger" type="button" data-action="wipe">Alle Daten löschen</button>
    </section>`;
}

function render() {
  const view = $('#view');
  view.innerHTML = ui.tab === 'entries' ? renderEntries() : ui.tab === 'settings' ? renderSettings() : renderOverview();
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === ui.tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
}

/* ---------- Formular (Bottom Sheet) ---------- */

function categoryOptions(type, selected) {
  const cats = [...state.categories[type]];
  if (selected && !cats.includes(selected)) cats.push(selected);
  return cats.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('')
    + `<option value="__new">Neue Kategorie …</option>`;
}

function openEntrySheet(id) {
  const existing = id ? state.items.find((i) => i.id === id) : null;
  const item = existing || {
    type: 'expense', name: '', amount: null, interval: { unit: 'month', every: 1 },
    startDate: D.today(), endDate: null, category: state.categories.expense[0], note: ''
  };
  const preset = INTERVAL_PRESETS.find((p) => p.unit === item.interval.unit && p.every === item.interval.every);
  const intervalKey = preset ? preset.key : 'custom';

  const html = `
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <header class="sheet-head">
        <button type="button" class="link" data-action="close-sheet">Abbrechen</button>
        <h2 id="sheet-title">${existing ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</h2>
        <button type="submit" class="link strong" form="entry-form">${existing ? 'Sichern' : 'Hinzufügen'}</button>
      </header>
      <form id="entry-form" class="sheet-body" novalidate>
        <div class="segmented type-switch" role="radiogroup" aria-label="Art">
          <label><input type="radio" name="type" value="expense"${item.type === 'expense' ? ' checked' : ''}><span>Ausgabe</span></label>
          <label><input type="radio" name="type" value="income"${item.type === 'income' ? ' checked' : ''}><span>Einnahme</span></label>
        </div>

        <div class="fields">
          <label class="field"><span>Name</span>
            <input name="name" maxlength="60" autocomplete="off" placeholder="z. B. Handyvertrag" value="${esc(item.name)}">
          </label>
          <label class="field"><span>Betrag</span>
            <span class="money-input"><input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${item.amount ? amountToInput(item.amount) : ''}"><em>€</em></span>
          </label>
          <label class="field"><span>Rhythmus</span>
            <select name="interval">
              ${INTERVAL_PRESETS.map((p) => `<option value="${p.key}"${p.key === intervalKey ? ' selected' : ''}>${p.label}</option>`).join('')}
              <option value="custom"${intervalKey === 'custom' ? ' selected' : ''}>Alle … Monate</option>
            </select>
          </label>
          <label class="field" data-show="custom"${intervalKey === 'custom' ? '' : ' hidden'}><span>Alle wie viele Monate?</span>
            <input name="every" type="number" min="1" max="120" inputmode="numeric" value="${intervalKey === 'custom' ? item.interval.every : 4}">
          </label>
          <label class="field"><span>Fällig am</span>
            <input name="startDate" type="date" value="${esc(item.startDate)}">
          </label>
        </div>
        <p class="hint">Ein Tag, an dem die Zahlung fällig war oder wird. Ab da wiederholt sie sich im gewählten Rhythmus, davor rechnet die App nicht mit.</p>

        <div class="fields">
          <label class="field"><span>Kategorie</span>
            <select name="category">${categoryOptions(item.type, item.category)}</select>
          </label>
          <label class="field" data-show="newcat" hidden><span>Neue Kategorie</span>
            <input name="newCategory" maxlength="30" autocomplete="off" placeholder="Name">
          </label>
        </div>

        <div class="fields">
          <label class="field switch-field"><span>Gekündigt oder befristet</span>
            <input type="checkbox" name="hasEnd" role="switch"${item.endDate ? ' checked' : ''}>
          </label>
          <label class="field" data-show="end"${item.endDate ? '' : ' hidden'}><span>Letzter Tag</span>
            <input name="endDate" type="date" value="${esc(item.endDate || '')}">
          </label>
        </div>
        <p class="hint" data-show="end"${item.endDate ? '' : ' hidden'}>Danach fallen keine Zahlungen mehr an. Vergangene Monate bleiben unverändert.</p>

        <div class="fields">
          <label class="field stacked"><span>Notiz</span>
            <textarea name="note" rows="2" maxlength="300" placeholder="Optional, z. B. Vertragsnummer oder Kündigungsfrist">${esc(item.note || '')}</textarea>
          </label>
        </div>

        <p class="form-error" role="alert"></p>

        ${existing ? `
          <div class="sheet-actions">
            ${isEnded(existing) ? '' : `<button type="button" class="btn" data-action="end-today" data-id="${esc(existing.id)}">Heute beenden</button>`}
            <button type="button" class="btn danger" data-action="delete" data-id="${esc(existing.id)}">Eintrag löschen</button>
          </div>` : ''}
      </form>
    </div>`;

  const root = $('#sheet-root');
  root.innerHTML = html;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => root.classList.add('open'));

  const form = $('#entry-form');
  const show = (key, on) => form.closest('.sheet').querySelectorAll(`[data-show="${key}"]`).forEach((el) => { el.hidden = !on; });

  form.interval.addEventListener('change', () => show('custom', form.interval.value === 'custom'));
  form.hasEnd.addEventListener('change', () => {
    show('end', form.hasEnd.checked);
    if (form.hasEnd.checked && !form.endDate.value) form.endDate.value = D.today();
  });
  form.category.addEventListener('change', () => {
    show('newcat', form.category.value === '__new');
    if (form.category.value === '__new') form.newCategory.focus();
  });
  form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
    const type = form.type.value;
    form.category.innerHTML = categoryOptions(type, state.categories[type][0]);
    show('newcat', false);
  }));
  form.addEventListener('submit', (e) => { e.preventDefault(); submitEntry(form, existing); });

  if (!existing) setTimeout(() => form.name.focus({ preventScroll: true }), 320);
}

function submitEntry(form, existing) {
  const err = (msg, field) => {
    form.querySelector('.form-error').textContent = msg;
    if (field) form[field].focus();
  };
  const type = form.type.value;
  const name = form.name.value.trim();
  const amount = parseAmount(form.amount.value);
  const preset = INTERVAL_PRESETS.find((p) => p.key === form.interval.value);
  const every = preset ? preset.every : Math.round(Number(form.every.value));
  const unit = preset ? preset.unit : 'month';
  const startDate = form.startDate.value;
  const endDate = form.hasEnd.checked ? form.endDate.value : null;
  let category = form.category.value;

  if (!name) return err('Gib einen Namen ein.', 'name');
  if (!(amount > 0)) return err('Gib einen Betrag größer als 0 ein, z. B. 12,99.', 'amount');
  if (!(every >= 1 && every <= 120)) return err('Der Rhythmus muss zwischen 1 und 120 Monaten liegen.', 'every');
  if (!D.valid(startDate)) return err('Wähle ein Datum, an dem die Zahlung fällig ist.', 'startDate');
  if (endDate !== null) {
    if (!D.valid(endDate)) return err('Wähle den letzten Tag.', 'endDate');
    if (endDate < startDate) return err('Der letzte Tag liegt vor dem Fälligkeitsdatum.', 'endDate');
  }
  if (category === '__new') {
    category = form.newCategory.value.trim();
    if (!category) return err('Gib einen Namen für die neue Kategorie ein.', 'newCategory');
    if (!state.categories[type].includes(category)) state.categories[type].push(category);
  }

  const now = new Date().toISOString();
  const data = { type, name, amount, interval: { unit, every }, startDate, endDate, category, note: form.note.value.trim() };

  if (existing) {
    Object.assign(existing, data, { updatedAt: now });
  } else {
    state.items.push({ id: uid(), ...data, createdAt: now, updatedAt: now });
  }
  if (!save()) return;
  closeSheet();
  render();
  toast(existing ? `„${name}“ gesichert` : `„${name}“ hinzugefügt`);
}

function closeSheet() {
  const root = $('#sheet-root');
  if (!root.innerHTML) return;
  root.classList.remove('open');
  document.body.classList.remove('sheet-open');
  setTimeout(() => {
    root.innerHTML = '';
    if (ui.pendingReload) location.reload();
  }, 220);
}

/* ---------- Backup ---------- */

async function exportBackup() {
  const previousBackupAt = state.settings.lastBackupAt;
  state.settings.lastBackupAt = new Date().toISOString(); // steht so auch im Backup
  const payload = {
    app: 'monatsausgaben',
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const name = `monatsausgaben-backup-${D.today()}.json`;
  const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Monatsausgaben Backup' });
      markBackup();
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') { state.settings.lastBackupAt = previousBackupAt; return; }
    console.warn(err);
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  markBackup();
}

function markBackup() {
  save();
  render();
  toast('Backup gesichert');
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed && parsed.app && parsed.app !== 'monatsausgaben') throw new Error('Diese Datei ist kein Backup dieser App.');
    const data = migrate(parsed && parsed.data ? parsed.data : parsed);
    if (!data.settings.lastBackupAt && parsed.exportedAt) data.settings.lastBackupAt = parsed.exportedAt;
    const msg = `Backup mit ${data.items.length} ${data.items.length === 1 ? 'Eintrag' : 'Einträgen'} wiederherstellen? Die ${state.items.length} aktuellen Einträge werden dabei ersetzt.`;
    if (!confirm(msg)) return;
    state = data;
    save();
    applyTheme();
    render();
    toast('Backup wiederhergestellt');
  } catch (err) {
    console.error(err);
    alert(err instanceof SyntaxError ? 'Die Datei konnte nicht gelesen werden. Wähle eine Backup-Datei (.json) dieser App.' : err.message);
  }
}

/* ---------- Darstellung ---------- */

function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}

/* ---------- Ereignisse ---------- */

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) {
    if (ui.tab !== tab.dataset.tab) {
      ui.tab = tab.dataset.tab;
      render();
      window.scrollTo(0, 0);
    }
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, value, type } = el.dataset;

  switch (action) {
    case 'add': openEntrySheet(null); break;
    case 'edit': openEntrySheet(id); break;
    case 'close-sheet': closeSheet(); break;
    case 'prev-month': ui.month = D.addMonths(ui.month, -1); render(); break;
    case 'next-month': ui.month = D.addMonths(ui.month, 1); render(); break;
    case 'this-month': { const t = D.parse(D.today()); ui.month = { y: t.y, m: t.m }; render(); break; }
    case 'filter': ui.entryFilter = value; render(); break;
    case 'theme': state.settings.theme = value; save(); applyTheme(); render(); break;
    case 'export': exportBackup(); break;
    case 'import': $('#import-file').click(); break;

    case 'end-today': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      const today = D.today();
      item.endDate = today < item.startDate ? item.startDate : today;
      item.updatedAt = new Date().toISOString();
      save(); closeSheet(); render();
      toast(`„${item.name}“ beendet`);
      break;
    }

    case 'delete': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      if (!confirm(`„${item.name}“ endgültig löschen?\n\nDer Eintrag verschwindet auch aus vergangenen Monaten. Wenn du gekündigt hast, trag lieber einen letzten Tag ein.`)) break;
      state.items = state.items.filter((i) => i.id !== id);
      save(); closeSheet(); render();
      toast(`„${item.name}“ gelöscht`);
      break;
    }

    case 'delete-category': {
      const list = state.categories[type];
      if (list.length <= 1) { toast('Mindestens eine Kategorie muss bleiben.'); break; }
      const used = state.items.filter((i) => i.type === type && i.category === value);
      const fallback = list.find((c) => c !== value && c === 'Sonstiges') || list.find((c) => c !== value);
      if (used.length && !confirm(`${used.length} ${used.length === 1 ? 'Eintrag nutzt' : 'Einträge nutzen'} „${value}“. ${used.length === 1 ? 'Er wird' : 'Sie werden'} nach „${fallback}“ verschoben.`)) break;
      used.forEach((i) => { i.category = fallback; });
      state.categories[type] = list.filter((c) => c !== value);
      save(); render();
      break;
    }

    case 'wipe': {
      if (!confirm('Wirklich alle Einträge und Einstellungen löschen? Das lässt sich nur mit einem Backup rückgängig machen.')) break;
      state = defaultState();
      save(); applyTheme(); render();
      toast('Alle Daten gelöscht');
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'import-file' && e.target.files[0]) {
    importBackup(e.target.files[0]);
    e.target.value = '';
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('.inline-add');
  if (!form) return;
  e.preventDefault();
  const type = form.dataset.type;
  const name = form.cat.value.trim();
  if (!name) return;
  if (state.categories[type].includes(name)) { toast('Diese Kategorie gibt es schon.'); return; }
  state.categories[type].push(name);
  save(); render();
  toast(`Kategorie „${name}“ hinzugefügt`);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

/* ---------- Start ---------- */

applyTheme();
render();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (document.body.classList.contains('sheet-open')) ui.pendingReload = true;
      else location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch((err) => console.warn('Service Worker nicht registriert', err));
  });
}

// Für Tests und Fehlersuche
window.__monatsausgaben = { D, monthSummary, occurrencesInMonth, monthlyAverage, nextOccurrence, migrate, parseAmount, get state() { return state; } };
