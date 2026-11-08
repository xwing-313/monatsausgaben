/* Monatsausgaben – wiederkehrende und einmalige Ausgaben und Einnahmen.
   Alle Daten bleiben lokal im localStorage dieses Geräts. */
'use strict';

/* ---------- Konstanten ---------- */

const APP_VERSION = '1.1.0';
const SCHEMA_VERSION = 2;          // Bei Änderungen am Datenformat erhöhen und unten eine Migration ergänzen
const STORAGE_KEY = 'monatsausgaben';
const BACKUP_REMINDER_DAYS = 30;
const UPCOMING_DAYS = 30;
const DEADLINE_WARN_DAYS = 30;

const DEFAULT_CATEGORIES = {
  expense: ['Wohnen', 'Versicherungen', 'Abos & Medien', 'Telefon & Internet', 'Mobilität', 'Sport & Freizeit', 'Sparen & Vorsorge', 'Anschaffungen', 'Sonstiges'],
  income: ['Gehalt', 'Nebenjob', 'Unterstützung', 'Sonstiges']
};

const INTERVAL_PRESETS = [
  { key: 'w1', unit: 'week', every: 1, label: 'Wöchentlich' },
  { key: 'w2', unit: 'week', every: 2, label: 'Alle 2 Wochen' },
  { key: 'm1', unit: 'month', every: 1, label: 'Monatlich' },
  { key: 'm2', unit: 'month', every: 2, label: 'Alle 2 Monate' },
  { key: 'm3', unit: 'month', every: 3, label: 'Vierteljährlich' },
  { key: 'm6', unit: 'month', every: 6, label: 'Halbjährlich' },
  { key: 'm12', unit: 'month', every: 12, label: 'Jährlich' },
  { key: 'once', unit: 'once', every: 1, label: 'Einmalig' }
];

const RENEW_OPTIONS = [
  { value: 1, label: 'um 1 Monat' },
  { value: 3, label: 'um 3 Monate' },
  { value: 6, label: 'um 6 Monate' },
  { value: 12, label: 'um 1 Jahr' },
  { value: 24, label: 'um 2 Jahre' },
  { value: 0, label: 'gar nicht' }
];
const NOTICE_UNITS = { days: 'Tage', weeks: 'Wochen', months: 'Monate' };

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/* Migrationen: MIGRATIONS[n] wandelt Daten von Schema n in Schema n+1 um. */
const MIGRATIONS = {
  // 1 → 2: Ein fester Betrag wird zu einem Preisverlauf (für Preisänderungen mit Datum)
  1: (d) => {
    (d.items || []).forEach((i) => {
      if (i && !Array.isArray(i.prices) && i.amount != null) i.prices = [{ from: i.startDate, amount: Number(i.amount) }];
      if (i) delete i.amount;
    });
  }
};

/* ---------- Datums-Helfer (ohne Zeitzonen-Fallen) ---------- */

const pad = (n) => String(n).padStart(2, '0');
const D = {
  parse(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; },
  iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; },
  dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); },
  num(s) { const { y, m, d } = D.parse(s); return Date.UTC(y, m - 1, d) / 864e5; },
  fromNum(n) { const t = new Date(n * 864e5); return D.iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); },
  addDays(s, n) { return D.fromNum(D.num(s) + n); },
  today() { const t = new Date(); return D.iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); },
  mi(y, m) { return y * 12 + (m - 1); },
  addMonths(ym, k) { const i = D.mi(ym.y, ym.m) + k; return { y: Math.floor(i / 12), m: (i % 12) + 1 }; },
  /** Datum um k Monate verschieben. Ein Monatsletzter bleibt ein Monatsletzter. */
  shiftMonths(s, k) {
    const p = D.parse(s);
    const ym = D.addMonths(p, k);
    const lastDay = p.d === D.dim(p.y, p.m);
    return D.iso(ym.y, ym.m, lastDay ? D.dim(ym.y, ym.m) : Math.min(p.d, D.dim(ym.y, ym.m)));
  },
  monthEnd(y, m) { return D.iso(y, m, D.dim(y, m)); },
  valid(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const { y, m, d } = D.parse(s);
    return m >= 1 && m <= 12 && d >= 1 && d <= D.dim(y, m);
  },
  short(s) { const { m, d } = D.parse(s); return `${pad(d)}.${pad(m)}.`; },
  long(s) { const { y, m, d } = D.parse(s); return `${pad(d)}.${pad(m)}.${y}`; },
  weekday(s) { return WEEKDAYS[new Date(D.num(s) * 864e5).getUTCDay()]; }
};

const round2 = (n) => Math.round(n * 100) / 100;
const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const moneyRound = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = (n) => money.format(round2(n) + 0);
const fmt0 = (n) => moneyRound.format(Math.round(n) + 0);

/* ---------- Rechenlogik ---------- */

const isOnce = (item) => item.interval.unit === 'once';
const isMonthly = (item) => item.interval.unit === 'month' && item.interval.every === 1;

function intervalLabel(iv) {
  const preset = INTERVAL_PRESETS.find((p) => p.unit === iv.unit && p.every === iv.every);
  if (preset) return preset.label.toLowerCase();
  return iv.unit === 'week' ? `alle ${iv.every} Wochen` : `alle ${iv.every} Monate`;
}

/** Betrag, der an einem Datum gilt (Preisverlauf) */
function priceAt(item, date) {
  let p = item.prices[0].amount;
  for (const pr of item.prices) {
    if (pr.from <= date) p = pr.amount; else break;
  }
  return p;
}

/** Durchschnitt pro Monat (Quartal ÷ 3, Jahr ÷ 12, Woche × 52,18 ÷ 12). Einmalige Posten zählen nicht. */
function monthlyAverage(item, atDate = D.today()) {
  if (isOnce(item)) return 0;
  const price = priceAt(item, atDate);
  const every = item.interval.every;
  if (item.interval.unit === 'week') return price * (365.25 / 12) / (7 * every);
  return price / every;
}

/** Alle Zahlungstermine eines Eintrags im Monat y/m */
function occurrencesInMonth(item, y, m) {
  if (isOnce(item)) {
    const p = D.parse(item.startDate);
    return p.y === y && p.m === m ? [item.startDate] : [];
  }
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
  const last = D.num(D.monthEnd(y, m));
  if (last < s) return [];
  const out = [];
  for (let t = s + Math.max(0, Math.ceil((first - s) / step)) * step; t <= last && t <= end; t += step) {
    out.push(D.fromNum(t));
  }
  return out;
}

/** Zählt ein wiederkehrender Eintrag im Monat y/m zum Durchschnitt? */
function isActiveInMonth(item, y, m) {
  if (isOnce(item)) return false;
  const first = D.iso(y, m, 1);
  return item.startDate <= D.monthEnd(y, m) && (!item.endDate || item.endDate >= first);
}

function isEnded(item, today = D.today()) {
  if (isOnce(item)) return item.startDate < today;
  return !!item.endDate && item.endDate < today;
}

function nextOccurrence(item, from = D.today()) {
  if (isOnce(item)) return item.startDate >= from ? item.startDate : null;
  if (item.endDate && item.endDate < from) return null;
  const f = D.parse(from < item.startDate ? item.startDate : from);
  const limit = (item.interval.unit === 'month' ? item.interval.every : 1) + 2;
  for (let k = 0; k <= limit; k++) {
    const ym = D.addMonths(f, k);
    const hit = occurrencesInMonth(item, ym.y, ym.m).find((d) => d >= from);
    if (hit) return hit;
  }
  return null;
}

/** Alle Zahlungen zwischen zwei Daten (inklusive) */
function paymentsBetween(fromDate, toDate, items = state.items) {
  const out = [];
  const a = D.parse(fromDate);
  const b = D.parse(toDate);
  const months = D.mi(b.y, b.m) - D.mi(a.y, a.m);
  for (let k = 0; k <= months; k++) {
    const ym = D.addMonths(a, k);
    for (const item of items) {
      for (const date of occurrencesInMonth(item, ym.y, ym.m)) {
        if (date >= fromDate && date <= toDate) out.push({ item, date, amount: priceAt(item, date) });
      }
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
}

function monthSummary(y, m, items = state.items) {
  const res = {
    avg: { income: 0, expense: 0 },
    actual: { income: 0, expense: 0 },
    once: { income: 0, expense: 0 },
    payments: [],
    categories: {}
  };
  const ref = D.monthEnd(y, m);
  for (const item of items) {
    if (isActiveInMonth(item, y, m)) {
      const avg = monthlyAverage(item, ref);
      res.avg[item.type] += avg;
      if (item.type === 'expense') res.categories[item.category] = (res.categories[item.category] || 0) + avg;
    }
    for (const date of occurrencesInMonth(item, y, m)) {
      const amount = priceAt(item, date);
      res.actual[item.type] += amount;
      if (isOnce(item)) res.once[item.type] += amount;
      res.payments.push({ item, date, amount });
    }
  }
  res.payments.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  return res;
}

/** Kündigungsfrist: nächstes mögliches Vertragsende und der Tag, bis zu dem gekündigt sein muss */
function cancellationInfo(item, today = D.today()) {
  const c = item.cancel;
  if (!c || isOnce(item) || isEnded(item, today) || item.endDate) return null;
  const deadlineFor = (end) => {
    if (c.noticeUnit === 'months') return D.shiftMonths(end, -c.notice);
    return D.addDays(end, -(c.noticeUnit === 'weeks' ? 7 : 1) * c.notice);
  };
  for (let n = 0; n < 1200; n++) {
    if (n > 0 && !c.renewMonths) return { expired: true, termEnd: c.termEnd };
    const end = n === 0 ? c.termEnd : D.shiftMonths(c.termEnd, n * c.renewMonths);
    const deadline = deadlineFor(end);
    if (deadline >= today) return { termEnd: end, deadline, daysLeft: D.num(deadline) - D.num(today) };
  }
  return null;
}

/** Rücklagen: was du monatlich für seltene und geplante Zahlungen zurücklegen solltest */
function reserveRows(today = D.today()) {
  const t = D.parse(today);
  const rows = [];
  for (const item of state.items) {
    if (item.type !== 'expense' || isEnded(item, today)) continue;
    if (isOnce(item)) {
      if (item.startDate <= today) continue;
      const due = D.parse(item.startDate);
      const months = Math.max(1, D.mi(due.y, due.m) - D.mi(t.y, t.m));
      const amount = priceAt(item, item.startDate);
      rows.push({ item, kind: 'once', next: item.startDate, amount, perMonth: amount / months, months, target: null });
      continue;
    }
    if (item.interval.unit !== 'month' || item.interval.every === 1) continue;
    const next = nextOccurrence(item, today);
    if (!next) continue;
    const prev = D.shiftMonths(next, -item.interval.every);
    const span = D.num(next) - D.num(prev);
    const share = Math.min(1, Math.max(0, (D.num(today) - D.num(prev)) / span));
    const amount = priceAt(item, next);
    rows.push({ item, kind: 'recurring', next, amount, perMonth: amount / item.interval.every, target: item.startDate > today ? 0 : amount * share });
  }
  return rows.sort((a, b) => a.next.localeCompare(b.next));
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

function normalizeCancel(c) {
  if (!c || typeof c !== 'object' || !D.valid(c.termEnd)) return null;
  const notice = Math.round(Number(c.notice));
  const renew = Math.round(Number(c.renewMonths));
  return {
    termEnd: c.termEnd,
    renewMonths: renew >= 0 && renew <= 120 ? renew : 0,
    notice: notice >= 0 && notice <= 400 ? notice : 0,
    noticeUnit: NOTICE_UNITS[c.noticeUnit] ? c.noticeUnit : 'months'
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const iv = raw.interval || {};
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (!D.valid(raw.startDate)) return null;
  if (!['week', 'month', 'once'].includes(iv.unit)) return null;
  const every = iv.unit === 'once' ? 1 : Math.round(Number(iv.every));
  if (!(every >= 1 && every <= 120)) return null;

  let prices = Array.isArray(raw.prices)
    ? raw.prices.filter((p) => p && D.valid(p.from) && Number(p.amount) > 0).map((p) => ({ from: p.from, amount: round2(Number(p.amount)) }))
    : [];
  if (!prices.length && Number(raw.amount) > 0) prices = [{ from: raw.startDate, amount: round2(Number(raw.amount)) }];
  if (!prices.length) return null;
  prices.sort((a, b) => a.from.localeCompare(b.from));
  prices = prices.filter((p, i) => i === prices.length - 1 || prices[i + 1].from !== p.from);
  if (iv.unit === 'once') prices = [{ from: raw.startDate, amount: prices[prices.length - 1].amount }];

  const out = {
    ...raw, // unbekannte Felder aus neueren Versionen bleiben erhalten
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    type: raw.type === 'income' ? 'income' : 'expense',
    name: raw.name.trim().slice(0, 60),
    prices,
    interval: { unit: iv.unit, every },
    startDate: raw.startDate,
    endDate: iv.unit !== 'once' && D.valid(raw.endDate) && raw.endDate >= raw.startDate ? raw.endDate : null,
    cancel: iv.unit === 'once' ? null : normalizeCancel(raw.cancel),
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'Sonstiges',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : ''
  };
  delete out.amount;
  return out;
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
    const parsed = JSON.parse(raw);
    const data = migrate(parsed);
    if (Number(parsed.schemaVersion) !== SCHEMA_VERSION) {
      // Vor dem Überschreiben eine Kopie im alten Format behalten
      try { localStorage.setItem(`${STORAGE_KEY}-schema${Number(parsed.schemaVersion) || 1}`, raw); } catch (_) { /* ignorieren */ }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
    return data;
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
  whatIfOff: new Set(),
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
  return round2(parseFloat(s));
}

function amountToInput(n) { return n.toFixed(2).replace('.', ','); }

function listJoin(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' und ' + arr[arr.length - 1];
}

function daysText(n) {
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  return `in ${n} Tagen`;
}

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
  const label = [];
  for (let k = 0; k < 12; k++) {
    const ym = D.addMonths(from, k);
    const hits = occurrencesInMonth(item, ym.y, ym.m).length;
    const active = isOnce(item) || isActiveInMonth(item, ym.y, ym.m);
    if (hits) label.push(MONTHS[ym.m - 1]);
    html += `<span class="beat${hits ? ' on' : ''}${active ? '' : ' off'}"><i></i><small>${MONTH_INITIALS[ym.m - 1]}</small></span>`;
  }
  const aria = label.length === 0 ? 'In den nächsten 12 Monaten keine Zahlung'
    : label.length === 12 ? 'Zahlung in jedem der nächsten 12 Monate'
    : `Zahlung in ${label.join(', ')}`;
  return `<span class="rhythm" role="img" aria-label="${esc(aria)}">${html}</span>`;
}

function topbar(title, withAdd = true) {
  return `
    <header class="topbar">
      <h1>${title}</h1>
      ${withAdd ? `<button class="add-btn" type="button" data-action="add" aria-label="Eintrag hinzufügen">${ICON.plus}</button>` : ''}
    </header>`;
}

function emptyState(text, button = 'Ersten Eintrag anlegen') {
  return `
    <section class="empty">
      <div class="empty-rhythm" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <h2>Noch nichts eingetragen</h2>
      <p>${text}</p>
      <button class="btn primary" type="button" data-action="add">${button}</button>
    </section>`;
}

function payRow(p, showWeekday = false) {
  const once = isOnce(p.item);
  const day = D.parse(p.date).d;
  return `
    <li>
      <button class="pay" type="button" data-action="edit" data-id="${esc(p.item.id)}">
        <span class="pay-date">${showWeekday ? `<small>${D.weekday(p.date)}</small>` : ''}<b>${day}.</b></span>
        <span class="pay-text"><span class="pay-name">${esc(p.item.name)}</span><small>${once ? 'einmalig' : esc(intervalLabel(p.item.interval))}${showWeekday ? `, ${D.short(p.date)}` : ''}</small></span>
        <span class="pay-amount ${p.item.type}">${p.item.type === 'income' ? '+' : '−'}${fmt(p.amount)}</span>
      </button>
    </li>`;
}

/* ---------- Ansicht: Übersicht ---------- */

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
    return header + emptyState('Trag deine wiederkehrenden Ausgaben und Einnahmen ein, egal ob monatlich, vierteljährlich oder jährlich. Die App rechnet aus, was dich ein Monat im Schnitt kostet und was wirklich abgebucht wird.');
  }

  const s = monthSummary(y, m);
  const netAvg = s.avg.income - s.avg.expense;
  const netAct = s.actual.income - s.actual.expense;
  const diff = s.actual.expense - s.avg.expense;

  const rareNames = [...new Set(s.payments.filter((p) => p.item.type === 'expense' && !isMonthly(p.item) && !isOnce(p.item)).map((p) => p.item.name))];
  const onceNames = [...new Set(s.payments.filter((p) => p.item.type === 'expense' && isOnce(p.item)).map((p) => p.item.name))];
  const dueParts = [];
  if (rareNames.length) dueParts.push(listJoin(rareNames));
  if (onceNames.length) dueParts.push(`einmalig ${listJoin(onceNames)}`);

  let note;
  if (Math.abs(diff) < 0.5) {
    note = `Im ${monthName} wird genau so viel abgebucht wie im Schnitt.`;
  } else if (diff > 0) {
    const verb = rareNames.length + onceNames.length === 1 ? 'wird' : 'werden';
    note = `Im ${monthName} zahlst du <b>${fmt(diff)} mehr</b> als im Schnitt.${dueParts.length ? ` Fällig ${verb} ${esc(dueParts.join(', außerdem '))}.` : ''}`;
  } else {
    note = `Im ${monthName} zahlst du <b>${fmt(-diff)} weniger</b> als im Schnitt, weil seltenere Zahlungen diesmal nicht fällig sind.`;
  }
  if (s.once.expense || s.once.income) note += ' Einmalige Posten zählen nur in ihrem Monat, nicht im Schnitt.';

  const payments = s.payments.length
    ? s.payments.map((p) => payRow(p)).join('')
    : '<li class="muted-row">In diesem Monat ist keine Zahlung fällig.</li>';

  const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  const catHtml = cats.length
    ? cats.map(([name, val]) => `
        <li class="cat">
          <div class="cat-top"><span>${esc(name)}</span><span>${fmt(val)}</span></div>
          <div class="cat-bar"><i style="width:${Math.max(2, (val / maxCat) * 100).toFixed(1)}%"></i></div>
        </li>`).join('')
    : '<li class="muted-row">Keine laufenden Ausgaben in diesem Monat.</li>';

  return header + `
    ${backupReminder()}
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

/* ---------- Ansicht: Vorschau ---------- */

function renderPlan() {
  if (state.items.length === 0) {
    return topbar('Vorschau') + emptyState('Sobald du Einträge angelegt hast, siehst du hier die nächsten Zahlungen, die teuren Monate und was du zurücklegen solltest.');
  }
  const today = D.today();
  const t = D.parse(today);

  // Demnächst
  const upcoming = paymentsBetween(today, D.addDays(today, UPCOMING_DAYS));
  const deadlines = state.items
    .map((item) => ({ item, info: cancellationInfo(item, today) }))
    .filter((d) => d.info && !d.info.expired)
    .sort((a, b) => a.info.deadline.localeCompare(b.info.deadline));
  const urgent = deadlines.filter((d) => d.info.daysLeft <= DEADLINE_WARN_DAYS);
  const upcomingOut = upcoming.filter((p) => p.item.type === 'expense').reduce((sum, p) => sum + p.amount, 0);

  const urgentHtml = urgent.map((d) => `
    <li>
      <button class="alert-row" type="button" data-action="edit" data-id="${esc(d.item.id)}">
        <span><b>${esc(d.item.name)}</b> kündigen, falls nicht mehr gewünscht</span>
        <small>Frist ${daysText(d.info.daysLeft)} (${D.long(d.info.deadline)}), sonst Verlängerung über den ${D.long(d.info.termEnd)} hinaus</small>
      </button>
    </li>`).join('');

  const upcomingHtml = upcoming.length
    ? upcoming.map((p) => payRow(p, true)).join('')
    : '<li class="muted-row">In den nächsten 30 Tagen ist nichts fällig.</li>';

  // 12 Monate
  const months = [];
  for (let k = 0; k < 12; k++) {
    const ym = D.addMonths(t, k);
    const s = monthSummary(ym.y, ym.m);
    months.push({ ...ym, exp: s.actual.expense, inc: s.actual.income });
  }
  const avgNow = monthSummary(t.y, t.m).avg.expense;
  const max = Math.max(avgNow, ...months.map((x) => x.exp), 1);
  const peak = months.reduce((a, b) => (b.exp > a.exp ? b : a), months[0]);
  const yearOut = months.reduce((sum, x) => sum + x.exp, 0);
  const yearIn = months.reduce((sum, x) => sum + x.inc, 0);
  const bars = months.map((x) => {
    const h = (x.exp / max) * 100;
    const high = x.exp > avgNow + 0.5;
    return `
      <button class="bar${high ? ' high' : ''}" type="button" data-action="goto-month" data-y="${x.y}" data-m="${x.m}" aria-label="${MONTHS[x.m - 1]} ${x.y}: ${fmt(x.exp)}">
        <span class="bar-val">${Math.round(x.exp)}</span>
        <span class="bar-track"><i style="height:${h.toFixed(1)}%"></i></span>
        <small>${MONTH_INITIALS[x.m - 1]}</small>
      </button>`;
  }).join('');

  // Rücklagen
  const reserves = reserveRows(today);
  const recurringRes = reserves.filter((r) => r.kind === 'recurring');
  const onceRes = reserves.filter((r) => r.kind === 'once');
  const reservePerMonth = reserves.reduce((sum, r) => sum + r.perMonth, 0);
  const reserveTarget = recurringRes.reduce((sum, r) => sum + r.target, 0);
  const reserveHtml = reserves.length ? `
      <div class="reserve-sum">
        <div><small>Pro Monat zurücklegen</small><b>${fmt(reservePerMonth)}</b></div>
        <div><small>Sollte heute im Topf sein</small><b>${fmt(reserveTarget)}</b></div>
      </div>
      <ul class="plain-list">
        ${recurringRes.map((r) => `
          <li>
            <button class="row" type="button" data-action="edit" data-id="${esc(r.item.id)}">
              <span class="row-main"><span>${esc(r.item.name)}</span><b>${fmt(r.perMonth)} / Monat</b></span>
              <span class="row-sub"><span>${fmt(r.amount)} fällig am ${D.long(r.next)}</span><span>jetzt ${fmt(r.target)}</span></span>
            </button>
          </li>`).join('')}
        ${onceRes.map((r) => `
          <li>
            <button class="row" type="button" data-action="edit" data-id="${esc(r.item.id)}">
              <span class="row-main"><span>${esc(r.item.name)}</span><b>${fmt(r.perMonth)} / Monat</b></span>
              <span class="row-sub"><span>einmalig ${fmt(r.amount)} am ${D.long(r.next)}</span><span>${r.months === 1 ? 'diesen Monat' : `${r.months} Monate`}</span></span>
            </button>
          </li>`).join('')}
      </ul>
      <p class="hint">„Sollte heute im Topf sein“ ist der Anteil, der seit der letzten Zahlung angespart sein müsste. Für geplante Einmalausgaben teilt die App den Betrag auf die Monate bis zum Termin auf.</p>`
    : '<p class="block-text">Keine seltenen oder geplanten Ausgaben, für die du zurücklegen musst.</p>';

  // Kündigungsfristen
  const deadlineHtml = deadlines.length
    ? `<ul class="plain-list">${deadlines.map((d) => `
        <li>
          <button class="row${d.info.daysLeft <= DEADLINE_WARN_DAYS ? ' warn' : ''}" type="button" data-action="edit" data-id="${esc(d.item.id)}">
            <span class="row-main"><span>${esc(d.item.name)}</span><b>bis ${D.long(d.info.deadline)}</b></span>
            <span class="row-sub"><span>Ende zum ${D.long(d.info.termEnd)}</span><span>${daysText(d.info.daysLeft)}</span></span>
          </button>
        </li>`).join('')}</ul>`
    : '<p class="block-text">Noch keine Kündigungsfristen hinterlegt. Öffne einen Vertrag und schalte „Kündigungsfrist merken“ ein.</p>';

  // Jahreskosten und Was-wäre-wenn
  const yearly = state.items
    .filter((i) => i.type === 'expense' && !isOnce(i) && !isEnded(i, today))
    .map((i) => ({ item: i, year: monthlyAverage(i, today) * 12 }))
    .sort((a, b) => b.year - a.year);
  const yearTotal = yearly.reduce((sum, r) => sum + r.year, 0);
  const saved = yearly.filter((r) => ui.whatIfOff.has(r.item.id)).reduce((sum, r) => sum + r.year, 0);
  const whatIfText = saved > 0
    ? `Ohne die abgewählten Posten: <b>${fmt(yearTotal - saved)}</b> im Jahr. Du würdest <b>${fmt(saved)}</b> im Jahr sparen, also ${fmt(saved / 12)} im Monat.`
    : 'Schalte Posten aus, um zu sehen, was du ohne sie sparen würdest. Es wird nichts geändert.';
  const yearlyHtml = yearly.map((r) => {
    const off = ui.whatIfOff.has(r.item.id);
    return `
      <li class="whatif${off ? ' is-off' : ''}">
        <span class="row-main"><span>${esc(r.item.name)}</span><b>${fmt(r.year)}</b></span>
        <input class="switch" type="checkbox" role="switch" data-action="whatif" data-id="${esc(r.item.id)}" ${off ? '' : 'checked'} aria-label="${esc(r.item.name)} in der Rechnung behalten">
      </li>`;
  }).join('');

  return topbar('Vorschau') + `
    ${urgent.length ? `<section class="block first"><h2>Fristen beachten</h2><ul class="alert-list">${urgentHtml}</ul></section>` : ''}

    <section class="block${urgent.length ? '' : ' first'}">
      <h2>Nächste 30 Tage <small>${fmt(upcomingOut)} Ausgaben</small></h2>
      <ul class="pay-list">${upcomingHtml}</ul>
    </section>

    <section class="block">
      <h2>Die nächsten 12 Monate <small>Ausgaben pro Monat</small></h2>
      <div class="chart">
        <div class="chart-bars">
          <span class="chart-avg" style="--p:${(avgNow / max).toFixed(4)}"><em>Ø ${fmt0(avgNow)}</em></span>
          ${bars}
        </div>
      </div>
      <p class="ledger-note">Am teuersten wird der <b>${MONTHS[peak.m - 1]} ${peak.y}</b> mit ${fmt(peak.exp)}. In den nächsten 12 Monaten gehen ${fmt(yearOut)} raus und ${fmt(yearIn)} kommen rein. Tipp auf einen Monat für die Details.</p>
    </section>

    <section class="block">
      <h2>Rücklagen</h2>
      ${reserveHtml}
    </section>

    <section class="block">
      <h2>Kündigungsfristen</h2>
      ${deadlineHtml}
    </section>

    <section class="block">
      <h2>Jahreskosten <small>${fmt(yearTotal)} im Jahr</small></h2>
      <p class="block-text whatif-text">${whatIfText}</p>
      <ul class="plain-list">${yearlyHtml || '<li class="muted-row">Keine laufenden Ausgaben.</li>'}</ul>
    </section>`;
}

/* ---------- Ansicht: Einträge ---------- */

function entryRow(item, today, from) {
  const next = nextOccurrence(item, today);
  const ended = isEnded(item, today);
  const price = priceAt(item, today < item.startDate ? item.startDate : today);
  const lines = [];
  if (isOnce(item)) {
    lines.push(`${ended ? 'War am' : 'Am'} ${D.long(item.startDate)}`);
  } else if (ended) {
    lines.push(`Beendet am ${D.long(item.endDate)}`);
  } else {
    if (next) lines.push(`Nächste ${D.short(next)}`);
    if (item.endDate) lines.push(`endet ${D.long(item.endDate)}`);
    const c = cancellationInfo(item, today);
    if (c && !c.expired) lines.push(`<span class="${c.daysLeft <= DEADLINE_WARN_DAYS ? 'warn-text' : ''}">kündbar bis ${D.short(c.deadline)}</span>`);
    const change = item.prices.find((p) => p.from > today);
    if (change) lines.push(`ab ${D.short(change.from)} ${fmt(change.amount)}`);
  }

  let right = '';
  if (isOnce(item)) right = '';
  else if (isMonthly(item)) right = `${fmt(monthlyAverage(item, today) * 12)} im Jahr`;
  else right = `≈ ${fmt(monthlyAverage(item, today))} / Monat`;

  return `
    <li>
      <button class="entry${ended ? ' ended' : ''}" type="button" data-action="edit" data-id="${esc(item.id)}">
        <span class="entry-main">
          <span class="entry-name">${esc(item.name)}</span>
          <span class="entry-amount ${item.type}">${item.type === 'income' ? '+' : ''}${fmt(price)}</span>
        </span>
        <span class="entry-sub">
          <span>${esc(item.category)}, ${isOnce(item) ? 'einmalig' : esc(intervalLabel(item.interval))}</span>
          ${right ? `<span>${right}</span>` : ''}
        </span>
        <span class="entry-foot">
          ${rhythmStrip(item, from)}
          <span class="entry-next">${lines.join('<br>')}</span>
        </span>
      </button>
    </li>`;
}

function renderEntries() {
  const today = D.today();
  const from = D.parse(today);
  const current = state.items.filter((i) => !isEnded(i, today));
  const archive = state.items.filter((i) => isEnded(i, today));
  const list = ui.entryFilter === 'archive' ? archive : current;

  const section = (title, items, withTotal) => {
    if (!items.length) return '';
    const total = items.reduce((sum, i) => sum + monthlyAverage(i, today), 0);
    const totalLabel = withTotal ? `<small>${fmt(total)} / Monat im Schnitt</small>` : '';
    return `<section class="block"><h2>${title} ${totalLabel}</h2><ul class="entry-list">${items.map((i) => entryRow(i, today, from)).join('')}</ul></section>`;
  };
  const byAvg = (a, b) => monthlyAverage(b, today) - monthlyAverage(a, today);
  const recurring = list.filter((i) => !isOnce(i));
  const once = list.filter(isOnce).sort((a, b) => (ui.entryFilter === 'archive' ? b.startDate.localeCompare(a.startDate) : a.startDate.localeCompare(b.startDate)));
  const isArchive = ui.entryFilter === 'archive';

  const body = section('Ausgaben', recurring.filter((i) => i.type === 'expense').sort(byAvg), !isArchive)
    + section('Einnahmen', recurring.filter((i) => i.type === 'income').sort(byAvg), !isArchive)
    + section(isArchive ? 'Einmalig, vergangen' : 'Einmalig, geplant', once, false);

  const empty = isArchive
    ? '<p class="empty-text">Hier landen gekündigte Verträge und vergangene Einmalposten. Wenn du etwas kündigst, öffne den Eintrag und trag den letzten Tag ein. Vergangene Monate bleiben dann richtig.</p>'
    : emptyState('Lege deine erste Ausgabe oder Einnahme an.', 'Eintrag anlegen');

  return topbar('Einträge') + `
    <div class="segmented" role="radiogroup" aria-label="Filter">
      <button type="button" role="radio" aria-checked="${!isArchive}" data-action="filter" data-value="active">Aktuell <span>${current.length}</span></button>
      <button type="button" role="radio" aria-checked="${isArchive}" data-action="filter" data-value="archive">Archiv <span>${archive.length}</span></button>
    </div>
    ${body || empty}`;
}

/* ---------- Ansicht: Einstellungen ---------- */

function renderSettings() {
  const last = state.settings.lastBackupAt;
  let lastText = 'Noch kein Backup gesichert';
  if (last) {
    const dt = new Date(last);
    lastText = `Letztes Backup am ${D.long(D.iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()))}`;
  }
  const theme = state.settings.theme;
  const catList = (type) => state.categories[type].map((c) => `
      <li><span>${esc(c)}</span><button class="icon-btn small" type="button" data-action="delete-category" data-type="${type}" data-value="${esc(c)}" aria-label="Kategorie ${esc(c)} entfernen">${ICON.trash}</button></li>`).join('');

  return topbar('Einstellungen', false) + `
    <section class="block first">
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
  const views = { overview: renderOverview, plan: renderPlan, entries: renderEntries, settings: renderSettings };
  view.innerHTML = (views[ui.tab] || renderOverview)();
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
    + '<option value="__new">Neue Kategorie …</option>';
}

function openEntrySheet(id) {
  const today = D.today();
  const existing = id ? state.items.find((i) => i.id === id) : null;
  const item = existing || {
    type: 'expense', name: '', prices: null, interval: { unit: 'month', every: 1 },
    startDate: today, endDate: null, cancel: null, category: state.categories.expense[0], note: ''
  };
  const preset = INTERVAL_PRESETS.find((p) => p.unit === item.interval.unit && p.every === item.interval.every);
  const intervalKey = preset ? preset.key : 'custom';
  let draftPrices = item.prices ? item.prices.map((p) => ({ ...p })) : [];
  const shownPrice = existing ? priceAt(item, today < item.startDate ? item.startDate : today) : null;
  const c = item.cancel || { termEnd: '', renewMonths: 1, notice: 1, noticeUnit: 'months' };

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
          <label class="field"><span data-label="amount">${existing && !isOnce(item) ? 'Betrag aktuell' : 'Betrag'}</span>
            <span class="money-input"><input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${shownPrice ? amountToInput(shownPrice) : ''}"><em>€</em></span>
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
          <label class="field"><span data-label="date">${isOnce(item) ? 'Datum' : 'Fällig am'}</span>
            <input name="startDate" type="date" value="${esc(item.startDate)}">
          </label>
        </div>
        <p class="hint" data-label="date-hint"></p>

        <div class="fields">
          <label class="field"><span>Kategorie</span>
            <select name="category">${categoryOptions(item.type, item.category)}</select>
          </label>
          <label class="field" data-show="newcat" hidden><span>Neue Kategorie</span>
            <input name="newCategory" maxlength="30" autocomplete="off" placeholder="Name">
          </label>
        </div>

        ${existing ? `
        <div data-recurring>
          <h3 class="sheet-sub">Preisverlauf</h3>
          <ul class="price-list" id="price-list"></ul>
          <div class="fields price-add" hidden>
            <label class="field"><span>Neuer Betrag ab</span><input name="priceFrom" type="date" value="${today}"></label>
            <label class="field"><span>Neuer Betrag</span><span class="money-input"><input name="priceAmount" inputmode="decimal" autocomplete="off" placeholder="0,00"><em>€</em></span></label>
          </div>
          <div class="price-buttons">
            <button type="button" class="btn small" data-local="price-open">Preisänderung eintragen</button>
            <button type="button" class="btn small primary" data-local="price-apply" hidden>Übernehmen</button>
          </div>
          <p class="hint">„Betrag aktuell“ korrigiert den heute gültigen Preis. Für eine Erhöhung ab einem Datum nutze die Preisänderung, dann bleiben frühere Monate richtig.</p>
        </div>` : ''}

        <div data-recurring>
          <div class="fields">
            <label class="field switch-field"><span>Gekündigt oder befristet</span>
              <input class="switch" type="checkbox" name="hasEnd" role="switch"${item.endDate ? ' checked' : ''}>
            </label>
            <label class="field" data-show="end"${item.endDate ? '' : ' hidden'}><span>Letzter Tag</span>
              <input name="endDate" type="date" value="${esc(item.endDate || '')}">
            </label>
          </div>
          <p class="hint" data-show="end"${item.endDate ? '' : ' hidden'}>Danach fallen keine Zahlungen mehr an. Vergangene Monate bleiben unverändert.</p>
        </div>

        <div data-recurring data-show="cancel-block"${item.endDate ? ' hidden' : ''}>
          <div class="fields">
            <label class="field switch-field"><span>Kündigungsfrist merken</span>
              <input class="switch" type="checkbox" name="hasCancel" role="switch"${item.cancel ? ' checked' : ''}>
            </label>
            <label class="field" data-show="cancel"${item.cancel ? '' : ' hidden'}><span>Laufzeit bis</span>
              <input name="termEnd" type="date" value="${esc(c.termEnd)}">
            </label>
            <label class="field" data-show="cancel"${item.cancel ? '' : ' hidden'}><span>Verlängert sich</span>
              <select name="renewMonths">${RENEW_OPTIONS.map((o) => `<option value="${o.value}"${o.value === c.renewMonths ? ' selected' : ''}>${o.label}</option>`).join('')}</select>
            </label>
            <div class="field" data-show="cancel"${item.cancel ? '' : ' hidden'}><span>Kündigungsfrist</span>
              <span class="combo">
                <input name="notice" type="number" min="0" max="400" inputmode="numeric" value="${c.notice}" aria-label="Kündigungsfrist">
                <select name="noticeUnit" aria-label="Einheit">${Object.entries(NOTICE_UNITS).map(([k, v]) => `<option value="${k}"${k === c.noticeUnit ? ' selected' : ''}>${v}</option>`).join('')}</select>
              </span>
            </div>
          </div>
          <p class="hint" data-show="cancel" id="cancel-preview"${item.cancel ? '' : ' hidden'}></p>
        </div>

        <div class="fields">
          <label class="field stacked"><span>Notiz</span>
            <textarea name="note" rows="2" maxlength="300" placeholder="Optional, z. B. Vertragsnummer">${esc(item.note || '')}</textarea>
          </label>
        </div>

        <p class="form-error" role="alert"></p>

        ${existing ? `
          <div class="sheet-actions">
            ${isOnce(existing) || isEnded(existing) ? '' : `<button type="button" class="btn" data-action="end-today" data-id="${esc(existing.id)}">Heute beenden</button>`}
            <button type="button" class="btn danger" data-action="delete" data-id="${esc(existing.id)}">Eintrag löschen</button>
          </div>` : ''}
      </form>
    </div>`;

  const root = $('#sheet-root');
  root.innerHTML = html;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => root.classList.add('open'));

  const form = $('#entry-form');
  const sheet = form.closest('.sheet');
  const show = (key, on) => sheet.querySelectorAll(`[data-show="${key}"]`).forEach((el) => { el.hidden = !on; });
  const onceSelected = () => form.interval.value === 'once';

  function syncInterval() {
    const once = onceSelected();
    show('custom', form.interval.value === 'custom');
    sheet.querySelectorAll('[data-recurring]').forEach((el) => {
      el.hidden = once || (el.dataset.show === 'cancel-block' && form.hasEnd.checked);
    });
    sheet.querySelector('[data-label="date"]').textContent = once ? 'Datum' : 'Fällig am';
    sheet.querySelector('[data-label="date-hint"]').textContent = once
      ? 'Der Tag, an dem die Zahlung anfällt. Liegt er in der Zukunft, zeigt die Vorschau, wie viel du bis dahin pro Monat zurücklegen solltest.'
      : 'Ein Tag, an dem die Zahlung fällig war oder wird. Ab da wiederholt sie sich im gewählten Rhythmus, davor rechnet die App nicht mit.';
    const amountLabel = sheet.querySelector('[data-label="amount"]');
    if (amountLabel) amountLabel.textContent = existing && !once ? 'Betrag aktuell' : 'Betrag';
  }

  function renderPrices() {
    const listEl = $('#price-list');
    if (!listEl) return;
    listEl.innerHTML = draftPrices.map((p, i) => `
      <li>
        <span>ab ${D.long(p.from)}${p.from > today ? ' <em>geplant</em>' : ''}</span>
        <b>${fmt(p.amount)}</b>
        ${draftPrices.length > 1 ? `<button type="button" class="icon-btn small" data-local="price-del" data-index="${i}" aria-label="Preis ab ${D.long(p.from)} entfernen">${ICON.trash}</button>` : '<span class="icon-spacer"></span>'}
      </li>`).join('');
  }

  function renderCancelPreview() {
    const el = $('#cancel-preview');
    if (!el || !form.hasCancel.checked) return;
    const draft = normalizeCancel({ termEnd: form.termEnd.value, renewMonths: form.renewMonths.value, notice: form.notice.value, noticeUnit: form.noticeUnit.value });
    if (!draft) { el.textContent = 'Trag ein, bis wann der Vertrag aktuell läuft.'; return; }
    const info = cancellationInfo({ ...item, interval: { unit: 'month', every: 1 }, endDate: null, startDate: '1900-01-01', cancel: draft }, today);
    if (!info) el.textContent = '';
    else if (info.expired) el.textContent = `Der Vertrag endet am ${D.long(info.termEnd)} und verlängert sich nicht. Trag dann den letzten Tag oben ein.`;
    else el.textContent = `Nächste Frist: bis ${D.long(info.deadline)} kündigen (${daysText(info.daysLeft)}), dann endet der Vertrag am ${D.long(info.termEnd)}.`;
  }

  syncInterval();
  renderPrices();
  renderCancelPreview();

  form.interval.addEventListener('change', syncInterval);
  form.hasEnd.addEventListener('change', () => {
    show('end', form.hasEnd.checked);
    if (form.hasEnd.checked && !form.endDate.value) form.endDate.value = today;
    syncInterval();
  });
  form.hasCancel.addEventListener('change', () => {
    show('cancel', form.hasCancel.checked);
    if (form.hasCancel.checked && !form.termEnd.value) {
      // Vorschlag: Monatsende des aktuellen Monats
      const t = D.parse(today);
      form.termEnd.value = D.monthEnd(t.y, t.m);
    }
    renderCancelPreview();
  });
  ['termEnd', 'renewMonths', 'notice', 'noticeUnit'].forEach((n) => form[n].addEventListener('input', renderCancelPreview));
  ['renewMonths', 'noticeUnit'].forEach((n) => form[n].addEventListener('change', renderCancelPreview));
  form.category.addEventListener('change', () => {
    show('newcat', form.category.value === '__new');
    if (form.category.value === '__new') form.newCategory.focus();
  });
  form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
    const type = form.type.value;
    form.category.innerHTML = categoryOptions(type, state.categories[type][0]);
    show('newcat', false);
  }));

  sheet.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-local]');
    if (!btn) return;
    const errEl = form.querySelector('.form-error');
    errEl.textContent = '';
    if (btn.dataset.local === 'price-open') {
      sheet.querySelector('.price-add').hidden = false;
      sheet.querySelector('[data-local="price-apply"]').hidden = false;
      btn.hidden = true;
      form.priceAmount.focus();
    } else if (btn.dataset.local === 'price-apply') {
      const amount = parseAmount(form.priceAmount.value);
      const from = form.priceFrom.value;
      if (!D.valid(from)) { errEl.textContent = 'Wähle, ab wann der neue Betrag gilt.'; return; }
      if (!(amount > 0)) { errEl.textContent = 'Gib den neuen Betrag ein, z. B. 14,99.'; form.priceAmount.focus(); return; }
      draftPrices = draftPrices.filter((p) => p.from !== from);
      draftPrices.push({ from, amount });
      draftPrices.sort((a, b) => a.from.localeCompare(b.from));
      form.amount.value = amountToInput(priceAt({ prices: draftPrices }, today < form.startDate.value ? form.startDate.value : today));
      form.priceAmount.value = '';
      sheet.querySelector('.price-add').hidden = true;
      btn.hidden = true;
      sheet.querySelector('[data-local="price-open"]').hidden = false;
      renderPrices();
      toast('Preisänderung vorgemerkt, jetzt sichern');
    } else if (btn.dataset.local === 'price-del') {
      draftPrices.splice(Number(btn.dataset.index), 1);
      form.amount.value = amountToInput(priceAt({ prices: draftPrices }, today < form.startDate.value ? form.startDate.value : today));
      renderPrices();
    }
  });

  form.addEventListener('submit', (e) => { e.preventDefault(); submitEntry(form, existing, draftPrices); });

  if (!existing) setTimeout(() => form.name.focus({ preventScroll: true }), 320);
}

function submitEntry(form, existing, draftPrices) {
  const err = (msg, field) => {
    form.querySelector('.form-error').textContent = msg;
    if (field && form[field]) form[field].focus();
  };
  const today = D.today();
  const type = form.type.value;
  const name = form.name.value.trim();
  const amount = parseAmount(form.amount.value);
  const preset = INTERVAL_PRESETS.find((p) => p.key === form.interval.value);
  const every = preset ? preset.every : Math.round(Number(form.every.value));
  const unit = preset ? preset.unit : 'month';
  const once = unit === 'once';
  const startDate = form.startDate.value;
  const endDate = !once && form.hasEnd.checked ? form.endDate.value : null;
  let category = form.category.value;

  if (!name) return err('Gib einen Namen ein.', 'name');
  if (!(amount > 0)) return err('Gib einen Betrag größer als 0 ein, z. B. 12,99.', 'amount');
  if (!(every >= 1 && every <= 120)) return err('Der Rhythmus muss zwischen 1 und 120 Monaten liegen.', 'every');
  if (!D.valid(startDate)) return err(once ? 'Wähle das Datum.' : 'Wähle ein Datum, an dem die Zahlung fällig ist.', 'startDate');
  if (endDate !== null) {
    if (!D.valid(endDate)) return err('Wähle den letzten Tag.', 'endDate');
    if (endDate < startDate) return err('Der letzte Tag liegt vor dem Fälligkeitsdatum.', 'endDate');
  }

  let cancel = null;
  if (!once && !endDate && form.hasCancel.checked) {
    cancel = normalizeCancel({ termEnd: form.termEnd.value, renewMonths: form.renewMonths.value, notice: form.notice.value, noticeUnit: form.noticeUnit.value });
    if (!cancel) return err('Trag ein, bis wann der Vertrag läuft, oder schalte die Kündigungsfrist aus.', 'termEnd');
  }

  if (category === '__new') {
    category = form.newCategory.value.trim();
    if (!category) return err('Gib einen Namen für die neue Kategorie ein.', 'newCategory');
    if (!state.categories[type].includes(category)) state.categories[type].push(category);
  }

  let prices;
  if (once || !existing || !draftPrices.length) {
    prices = [{ from: startDate, amount }];
  } else {
    prices = draftPrices.map((p) => ({ ...p }));
    const ref = today < startDate ? startDate : today;
    let idx = -1;
    prices.forEach((p, i) => { if (p.from <= ref) idx = i; });
    if (idx < 0) idx = 0;
    prices[idx].amount = amount; // „Betrag aktuell“ korrigiert den gültigen Preis
    if (startDate < prices[0].from) prices[0].from = startDate;
  }

  const now = new Date().toISOString();
  const data = { type, name, prices, interval: { unit, every }, startDate, endDate, cancel, category, note: form.note.value.trim() };

  if (existing) {
    Object.assign(existing, data, { updatedAt: now });
    delete existing.amount;
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
    ui.whatIfOff.clear();
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
    case 'goto-month':
      ui.month = { y: Number(el.dataset.y), m: Number(el.dataset.m) };
      ui.tab = 'overview';
      render();
      window.scrollTo(0, 0);
      break;
    case 'filter': ui.entryFilter = value; render(); break;
    case 'theme': state.settings.theme = value; save(); applyTheme(); render(); break;
    case 'export': exportBackup(); break;
    case 'import': $('#import-file').click(); break;

    case 'end-today': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      const today = D.today();
      item.endDate = today < item.startDate ? item.startDate : today;
      item.cancel = null;
      item.updatedAt = new Date().toISOString();
      save(); closeSheet(); render();
      toast(`„${item.name}“ beendet`);
      break;
    }

    case 'delete': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      const hint = isOnce(item) ? '' : '\n\nDer Eintrag verschwindet auch aus vergangenen Monaten. Wenn du gekündigt hast, trag lieber einen letzten Tag ein.';
      if (!confirm(`„${item.name}“ endgültig löschen?${hint}`)) break;
      state.items = state.items.filter((i) => i.id !== id);
      ui.whatIfOff.delete(id);
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
      ui.whatIfOff.clear();
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
    return;
  }
  if (e.target.dataset && e.target.dataset.action === 'whatif') {
    const id = e.target.dataset.id;
    if (e.target.checked) ui.whatIfOff.delete(id); else ui.whatIfOff.add(id);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
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
window.__monatsausgaben = {
  D, monthSummary, occurrencesInMonth, monthlyAverage, nextOccurrence, priceAt, cancellationInfo, reserveRows, paymentsBetween,
  migrate, parseAmount, get state() { return state; }
};
