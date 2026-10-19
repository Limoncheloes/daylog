'use strict';
/*
 * Лог дня — запись дня за минуту. Без фреймворков, сборки и сети.
 * Данные: localStorage (ключ daylog.v1). Экспорт: JSON, Markdown (формат 1.5 из брифа), CSV.
 * Порядок файла: константы → время → данные → расчёты → Markdown → импорт/экспорт → экраны → действия → папка journal → запуск.
 */

/* ───────────── Константы ───────────── */

const STORE_KEY = 'daylog.v1';
const META_KEY = 'daylog.meta';   // служебное: когда была резервная копия, когда писали файлы в папку
const DAY_END_HOUR = 4;           // сутки заканчиваются в 04:00
const MINUS = '−';
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const SECTIONS = ['Сделано', 'Начато, не доделано', 'Не вышло', 'Лог', 'Заметка дня', 'Задачи на завтра'];
const HOURS = Array.from({ length: 17 }, (_, i) => i + 7);   // 07…23

// Списки занятий и триггеров пустые: их заводит пользователь в настройках или прямо в форме отметки.
// Роли: goal_activity — занятие, чьи минуты идут в greenhouse_min и цель недели;
// trigger_activity — занятие, у которого спрашивается триггер (заход в ленты не по плану).
const DEFAULT_SETTINGS = {
  checkins: ['11:30', '14:10', '17:30', '21:45'],
  checkins_on: [true, true, true, true],
  wake_target: '08:00',
  goal_activity: '',
  greenhouse_target_min: 450,
  trigger_activity: '',
  screen_ramp: [
    { from: '2026-10-19', max_min: 360 }, { from: '2026-10-26', max_min: 300 },
    { from: '2026-11-02', max_min: 240 }, { from: '2026-11-09', max_min: 180 },
  ],
  activities: [],
  triggers: [],
};
const LISTS = { activities: { field: 'activity', one: 'занятие' }, triggers: { field: 'trigger', one: 'триггер' } };

// Ключ из названия: «Главный проект» → glavnyy_proekt. Ключ не меняется при переименовании.
const TRANSLIT = Object.fromEntries([...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'].map((c, i) =>
  [c, ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'ts', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya'][i]]));
function makeKey(label, list) {
  const base = label.toLowerCase().replace(/[а-яё]/g, c => TRANSLIT[c]).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'item';
  let key = base;
  for (let n = 2; list.some(x => x.key === key); n++) key = `${base}_${n}`;
  return key;
}
function pairs(s) {
  return s.split('|').map(p => ({ key: p.slice(0, p.indexOf(' ')), label: p.slice(p.indexOf(' ') + 1) }));
}

/* ───────────── Время ───────────── */

// ?now=2026-10-20T02:30 подменяет часы — для проверки границы суток.
const NOW_PARAM = new URLSearchParams(location.search).get('now');
const now = () => (NOW_PARAM ? new Date(NOW_PARAM) : new Date());
const pad = n => String(n).padStart(2, '0');
const hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); };
const weekStart = s => addDays(s, -((parseDate(s).getDay() + 6) % 7));
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
const fmtDur = m => (m == null ? '' : `${Math.floor(m / 60)}:${pad(m % 60)}`);
const fmtDate = s => { const d = parseDate(s); return `${DOW[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// Логическая дата: до 04:00 ещё «вчера».
function logicalDate(d = now()) {
  const x = new Date(d);
  if (x.getHours() < DAY_END_HOUR) x.setDate(x.getDate() - 1);
  return ymd(x);
}

// Минуты логических суток: 00:00–03:59 идут после 23:59 (как 24:00–27:59).
const dayMin = t => { const m = toMin(t); return m < DAY_END_HOUR * 60 ? m + 1440 : m; };
const rowMin = r => (toMin(r.to) - toMin(r.from) + 1440) % 1440;
const rowSpan = r => { const a = dayMin(r.from); return [a, a + rowMin(r)]; };

// 2026-10-25T21:50:00+06:00 — с поясом устройства
function isoLocal(d = now()) {
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${ymd(d)}T${hm(d)}:${pad(d.getSeconds())}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Экранное время: 340 · 5:40 · 5ч40 · 5ч · 40м → минуты (или null)
function parseScreen(s) {
  s = String(s).trim().toLowerCase().replace(/\s+/g, '');
  let m;
  if (/^\d+$/.test(s)) return +s;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d+)[чh](?:(\d+)(?:м|мин|m)?)?$/))) return m[1] * 60 + +(m[2] || 0);
  if ((m = s.match(/^(\d+)(?:м|мин|m)$/))) return +m[1];
  return null;
}

/* ───────────── Данные ───────────── */

// Шаблоны задают и значения по умолчанию, и порядок ключей в экспорте.
const ROW_TEMPLATE = { id: '', from: '', to: '', activity: 'other', note: '', energy: 0, engagement: 0, trigger: null, trigger_note: '', flow: false, recalled: false, checkin: null };
const DAY_TEMPLATE = { wake: null, main_result: '', main_done: null, screen_min: null, backup: null, training: null, dessert_ok: null, done: [], started: [], failed: [], note: '', tomorrow: [], updated_at: null, rows: [] };

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const byDate = (a, b) => (a.date < b.date ? -1 : 1);
const time = s => Date.parse(s) || 0;

function normSettings(s) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const k in out) if (s?.[k] != null) out[k] = structuredClone(s[k]);
  out.checkins_on = out.checkins.map((_, i) => out.checkins_on[i] !== false);
  for (const name in LISTS) out[name] = out[name].map(x => (typeof x === 'string' ? { key: x, label: x } : x));
  // Данные первой версии: роли были зашиты в ключи greenhouse и phone_off.
  const has = k => out.activities.some(a => a.key === k);
  if (s?.goal_activity === undefined && has('greenhouse')) out.goal_activity = 'greenhouse';
  if (s?.trigger_activity === undefined && has('phone_off')) out.trigger_activity = 'phone_off';
  return out;
}

function normDay(d) {
  const day = { date: d.date, ...structuredClone(DAY_TEMPLATE), ...d };
  for (const k of ['done', 'started', 'failed', 'tomorrow']) if (!Array.isArray(day[k])) day[k] = [];
  day.rows = (day.rows || []).map(r => ({ ...ROW_TEMPLATE, ...r, id: r.id || newId() }));
  sortRows(day);
  return day;
}

function sortRows(day) {
  day.rows.sort((a, b) => dayMin(a.from) - dayMin(b.from) || rowMin(a) - rowMin(b));
}

function load() {
  let raw = null, data = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
    data = JSON.parse(raw);
  } catch {
    if (raw) localStorage.setItem(STORE_KEY + '.broken', raw);   // испорченное не затираем молча
  }
  const db = { version: 1, settings: normSettings(data?.settings), days: {} };
  for (const d of Object.values(data?.days || {})) if (d?.date) db.days[d.date] = normDay(d);
  return db;
}

function loadMeta() {
  try { return { last_backup_at: null, written: {}, ...JSON.parse(localStorage.getItem(META_KEY)) }; }
  catch { return { last_backup_at: null, written: {} }; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { flash('Не удалось сохранить: ' + e.message + '. Сделай экспорт JSON.'); }
}
const saveMeta = () => localStorage.setItem(META_KEY, JSON.stringify(meta));

const db = load();
const meta = loadMeta();
const ui = { view: 'today', date: logicalDate(), today: logicalDate(), week: null, draft: null };

const getDay = date => db.days[date] || normDay({ date });

// Любое изменение дня: отметка времени → сохранение → запись в папку (если подключена).
function touch(day) {
  day.updated_at = isoLocal();
  db.days[day.date] = day;
  save();
  folderQueue(day.date);
}
function setField(f, v) {
  const day = getDay(ui.date);
  day[f] = v;
  touch(day);
}

/* ───────────── Расчёты ───────────── */

const actLabel = k => db.settings.activities.find(a => a.key === k)?.label ?? k;
const trigLabel = k => db.settings.triggers.find(t => t.key === k)?.label ?? k;
const visible = name => db.settings[name].filter(x => !x.hidden);
const isTriggerAct = k => !!k && k === db.settings.trigger_activity;
// Минуты занятия-цели за день; null — роль не назначена (в Markdown это null).
const greenhouseMin = day => (db.settings.goal_activity
  ? day.rows.filter(r => r.activity === db.settings.goal_activity).reduce((s, r) => s + rowMin(r), 0)
  : null);
const reached = day => (day.rows.length ? Math.max(...day.rows.map(r => rowSpan(r)[1])) : null);

// Включённые отметки: [{ n: номер 1…4, t: 'ЧЧ:ММ' }]
const activeCheckins = () =>
  db.settings.checkins.map((t, i) => ({ n: i + 1, t })).filter(c => c.t && db.settings.checkins_on[c.n - 1]);

// Строка относится к первой отметке, до которой она закончилась (запас 30 минут на опоздание).
function checkinFor(to) {
  const m = dayMin(to);
  return activeCheckins().find(c => dayMin(c.t) + 30 >= m)?.n ?? null;
}

// ✓ сделана — лог дошёл до времени отметки (±15 мин); ● пора — время подошло; ○ впереди.
function checkinStatus(day, c, isToday) {
  if ((reached(day) ?? -1) >= dayMin(c.t) - 15) return 'done';
  if (!isToday || dayMin(hm(now())) >= dayMin(c.t) - 10) return 'due';
  return 'ahead';
}

// Лимит экрана на дату по лестнице. До начала лестницы действует её первая ступень.
function screenLimit(date) {
  const ramp = [...db.settings.screen_ramp].sort(byFrom);
  return ramp.length ? (ramp.filter(r => r.from <= date).pop() || ramp[0]).max_min : null;
}
const byFrom = (a, b) => (a.from < b.from ? -1 : 1);

function overlaps(day, d) {
  const [a, b] = rowSpan(d);
  return day.rows.filter(r => r.id !== d.id && rowSpan(r)[0] < b && a < rowSpan(r)[1]);
}

// Среднее по набору {min, e, v}: e и v — суммы «значение × минуты».
function withAvg(s) {
  s.ae = s.min ? s.e / s.min : null;
  s.av = s.min ? s.v / s.min : null;
  s.score = s.min ? (s.ae + s.av) / 2 : null;
  return s;
}

function weekStats(monday) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const days = dates.map(d => db.days[d] || null);
  const hours = Object.fromEntries(HOURS.map(h => [h, { h, min: 0, e: 0, v: 0 }]));
  const acts = {}, trig = {}, trigHours = {};
  let phoneMin = 0, phoneN = 0;

  for (const day of days) for (const r of day?.rows || []) {
    const [a, b] = rowSpan(r);
    // Час получает столько минут строки, сколько их попало в этот час.
    for (const h of HOURS) {
      const ov = Math.min(b, (h + 1) * 60) - Math.max(a, h * 60);
      if (ov > 0) { hours[h].min += ov; hours[h].e += ov * r.energy; hours[h].v += ov * r.engagement; }
    }
    const s = (acts[r.activity] ||= { key: r.activity, min: 0, e: 0, v: 0 });
    s.min += b - a; s.e += (b - a) * r.energy; s.v += (b - a) * r.engagement;
    if (isTriggerAct(r.activity)) {
      phoneMin += b - a; phoneN++;
      trig[r.trigger || ''] = (trig[r.trigger || ''] || 0) + 1;
      const h = Math.floor(toMin(r.from) / 60);
      trigHours[h] = (trigHours[h] || 0) + 1;
    }
  }

  const rated = HOURS.map(h => withAvg(hours[h])).filter(x => x.min > 0);
  const best = [...rated].sort((x, y) => y.score - x.score || y.min - x.min).slice(0, 3).map(x => x.h);
  const worst = [...rated].sort((x, y) => x.score - y.score || y.min - x.min).filter(x => !best.includes(x.h)).slice(0, 3).map(x => x.h);
  const actList = Object.values(acts).map(withAvg).sort((x, y) => y.min - x.min);
  return {
    dates, days, hours, best, worst, acts: actList, phoneMin, phoneN, trigHours,
    gives: actList.filter(x => x.ae > 0).sort((x, y) => y.ae - x.ae || y.min - x.min).slice(0, 3),
    takes: actList.filter(x => x.ae < 0).sort((x, y) => x.ae - y.ae || y.min - x.min).slice(0, 3),
    trig: Object.entries(trig).sort((x, y) => y[1] - x[1]),
  };
}

// Табло недели: одна структура и для экрана, и для Markdown.
function boardRows(w) {
  const s = db.settings, days = w.days, lim = screenLimit(w.dates[0]);
  const count = f => days.filter(d => d && f(d)).length;
  const bool = (name, short, f) => ({
    name, short, total: `${count(d => d[f] === true)}/7`,
    cells: days.map(d => (d?.[f] == null ? { text: '' } : d[f] ? { text: '✓', cls: 'ok' } : { text: '✗', cls: 'bad' })),
  });
  const goal = s.goal_activity && actLabel(s.goal_activity);
  const gh = days.reduce((sum, d) => sum + (d ? greenhouseMin(d) : 0), 0);
  const screens = days.filter(d => d?.screen_min != null).map(d => d.screen_min);
  return [
    { name: `Подъём ≤ ${s.wake_target}`, short: 'Подъём', total: `${count(d => d.wake && d.wake <= s.wake_target)}/7 (цель 6)`,
      cells: days.map(d => (d?.wake ? { text: d.wake.replace(/^0/, ''), cls: d.wake <= s.wake_target ? 'ok' : 'bad' } : { text: '' })) },
    { name: `Экран ≤ ${fmtDur(lim)}`, short: 'Экран', total: `${count(d => d.screen_min != null && d.screen_min <= screenLimit(d.date))}/7` + (screens.length ? `, в среднем ${fmtDur(Math.round(screens.reduce((a, b) => a + b, 0) / screens.length))}` : ''),
      cells: days.map(d => (d?.screen_min != null ? { text: fmtDur(d.screen_min), cls: d.screen_min <= screenLimit(d.date) ? 'ok' : 'bad' } : { text: '' })) },
    bool('Главный результат', 'Результат', 'main_done'),
    goal && { name: `${goal}, мин`, short: goal, total: `${fmtDur(gh)} из ${fmtDur(s.greenhouse_target_min)}`,
      cells: days.map(d => ({ text: d ? String(greenhouseMin(d)) : '' })) },
    bool('Бэкап', 'Бэкап', 'backup'),
    bool('Тренировка', 'Трен.', 'training'),
    bool('Дессерт в окнах', 'Дессерт', 'dessert_ok'),
  ].filter(Boolean);
}

/* ───────────── Markdown дня (формат 1.5 — его читает другая программа) ───────────── */

const clean = s => String(s ?? '').replace(/\s+/g, ' ').replace(/ · /g, ', ').trim();
const sign = v => (v > 0 ? '+' : v < 0 ? MINUS : '0');
const yamlStr = v => (v == null || v === '' ? 'null' : JSON.stringify(v));
const yamlVal = v => (v == null ? 'null' : String(v));
const mdList = items => (items.length ? items.map(x => '- ' + clean(x)).join('\n') : '- ');
const yesNo = v => (v === true ? 'да' : v === false ? 'нет' : '—');

function rowLine(r) {
  return `- ${r.from}–${r.to} · ${actLabel(r.activity)}${r.note ? ': ' + clean(r.note) : ''}` +
    ` · энергия ${sign(r.energy)} · вовлечённость ${sign(r.engagement)}` +
    ` · триггер: ${r.trigger ? trigLabel(r.trigger) : '—'}${r.trigger_note ? ` (${clean(r.trigger_note)})` : ''}` +
    (r.flow ? ' · flow' : '') + (r.recalled ? ' · по памяти' : '');
}

function dayMarkdown(day) {
  const fm = [
    'date: ' + day.date,
    'wake: ' + yamlStr(day.wake),
    'screen_min: ' + yamlVal(day.screen_min),
    'main_result: ' + yamlStr(clean(day.main_result)),
    'main_done: ' + yamlVal(day.main_done),
    'greenhouse_min: ' + yamlVal(greenhouseMin(day)),
    'backup: ' + yamlVal(day.backup),
    'training: ' + yamlVal(day.training),
    'dessert_ok: ' + yamlVal(day.dessert_ok),
  ];
  const bodies = [
    mdList(day.done), mdList(day.started), mdList(day.failed),
    day.rows.length ? day.rows.map(rowLine).join('\n') : '- ',
    clean(day.note) || '- ',
    mdList(day.tomorrow),
  ];
  const sections = SECTIONS.map((t, i) => `## ${t}\n${bodies[i]}`);
  return `---\n${fm.join('\n')}\n---\n# ${day.date} (${DOW[parseDate(day.date).getDay()]})\n\n${sections.join('\n\n')}\n`;
}

// Строка для чата ассистента («Скопировать для /day»)
function dayLine(day) {
  const j = a => (a.length ? a.map(clean).join('; ') : '—');
  return `/day подъём ${day.wake || '—'} · экран ${day.screen_min != null ? fmtDur(day.screen_min) : '—'}` +
    ` · главный результат: ${yesNo(day.main_done)} · сделано: ${j(day.done)} · начато: ${j(day.started)}` +
    ` · не вышло: ${j(day.failed)} · завтра: ${j(day.tomorrow)}`;
}

// Markdown → { fm: [[ключ, строка]], head: [строки до первого «## »], sections: [{ title, lines }] }
function splitMd(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fm = [], head = [], sections = [];
  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) fm.push([lines[i].match(/^([\w-]+):/)?.[1] ?? null, lines[i]]);
    i++;
  }
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^## (.+?)\s*$/);
    if (m) sections.push({ title: m[1], lines: [] });
    else (sections.length ? sections[sections.length - 1].lines : head).push(lines[i]);
  }
  return { fm, head, sections };
}

function yamlValue(v) {
  v = v.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return +v;
  if (v[0] === '"') try { return JSON.parse(v); } catch { /* ниже вернём как есть */ }
  if (v[0] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// «Подпись: заметка» или «подпись (заметка)» → ключ и заметка. Неизвестная подпись → other, текст в заметку.
function matchLabel(list, text, sep) {
  text = text.trim();
  const hit = list.filter(x => text === x.label || text.startsWith(x.label + sep)).sort((a, b) => b.label.length - a.label.length)[0];
  if (!hit) return { key: 'other', note: text };
  const note = text.slice(hit.label.length + sep.length);
  return { key: hit.key, note: (sep === ' (' ? note.replace(/\)$/, '') : note).trim() };
}

// Минус в файле — «−» (U+2212), при импорте принимаем и обычный «-».
const ROW_RE = /^- (\d{1,2}:\d\d)\s*[–-]\s*(\d{1,2}:\d\d) · (.+?) · энергия ([−+0-]) · вовлечённость ([−+0-]) · триггер: (.+?)((?: · (?:flow|по памяти))*)\s*$/;
const signValue = c => (c === '+' ? 1 : c === '0' ? 0 : -1);

function parseRowLine(line) {
  const m = line.match(ROW_RE);
  if (!m) return null;
  const [, from, to, actText, e, v, trigText, flags] = m;
  const act = matchLabel(db.settings.activities, actText, ': ');
  const trig = trigText.startsWith('—')
    ? { key: null, note: trigText.match(/\((.*)\)$/)?.[1] ?? '' }
    : matchLabel(db.settings.triggers, trigText, ' (');
  const row = {
    from: from.padStart(5, '0'), to: to.padStart(5, '0'), activity: act.key, note: act.note,
    energy: signValue(e), engagement: signValue(v), trigger: trig.key, trigger_note: trig.note,
    flow: flags.includes('flow'), recalled: flags.includes('по памяти'),
  };
  row.checkin = checkinFor(row.to);
  return row;
}

function parseDayMd(text, name = '') {
  const md = splitMd(text);
  const fm = Object.fromEntries(md.fm.filter(([k]) => k).map(([k, l]) => [k, yamlValue(l.slice(l.indexOf(':') + 1))]));
  const date = String(fm.date ?? name.match(/\d{4}-\d\d-\d\d/)?.[0] ?? '');
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error(`${name}: нет даты`);
  const sec = t => md.sections.find(s => s.title === t)?.lines || [];
  const items = t => sec(t).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(Boolean);
  return normDay({
    date, wake: fm.wake ?? null, main_result: fm.main_result ?? '', main_done: fm.main_done ?? null,
    screen_min: fm.screen_min ?? null, backup: fm.backup ?? null, training: fm.training ?? null, dessert_ok: fm.dessert_ok ?? null,
    done: items('Сделано'), started: items('Начато, не доделано'), failed: items('Не вышло'),
    note: sec('Заметка дня').map(l => l.trim()).filter(l => l && l !== '-').join(' '),
    tomorrow: items('Задачи на завтра'),
    rows: sec('Лог').map(parseRowLine).filter(Boolean),
  });
}

// В чужом файле обновляем только своё: ключи front matter, заголовок и шесть разделов. Остальное остаётся на месте.
function mergeMd(oldText, newText) {
  const o = splitMd(oldText), n = splitMd(newText);
  const ownKeys = new Set(n.fm.map(([k]) => k));
  const fm = [...n.fm, ...o.fm.filter(([k]) => !ownKeys.has(k))].map(([, l]) => l);
  const mine = new Map(n.sections.map(s => [s.title, s]));
  const out = o.sections.map(s => mine.get(s.title) || s);
  // своего раздела в файле не было — ставим после предыдущего своего
  n.sections.forEach((s, k) => { if (!out.includes(s)) out.splice(k ? out.indexOf(n.sections[k - 1]) + 1 : 0, 0, s); });
  const trimEnd = ls => { const a = [...ls]; while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };
  const head = trimEnd([...n.head.filter(l => l.startsWith('# ')), ...o.head.filter(l => !l.startsWith('# '))]);
  return ['---', ...fm, '---', ...head, '', ...out.flatMap(s => ['## ' + s.title, ...trimEnd(s.lines), ''])].join('\n');
}

/* ───────────── Неделя в Markdown, CSV, файлы ───────────── */

function fmtAvg(x) {
  if (x == null) return '—';
  const r = Math.round(x * 10) / 10;
  return (r > 0 ? '+' : r < 0 ? MINUS : '') + Math.abs(r).toFixed(1).replace('.', ',');
}

function rangeText(monday) {
  const a = parseDate(monday), b = parseDate(addDays(monday, 6));
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`
    : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

function weekMarkdown(monday) {
  const w = weekStats(monday);
  const hourText = h => `${pad(h)}:00 (${fmtAvg(w.hours[h].ae)} / ${fmtAvg(w.hours[h].av)})`;
  const L = [`# Итоги недели ${rangeText(monday)}`, '', '## Табло', '',
    `| | ${w.dates.map(d => DOW[parseDate(d).getDay()] + ' ' + d.slice(8)).join(' | ')} | итог |`, '|---|' + '---|'.repeat(8)];
  for (const m of boardRows(w)) L.push(`| ${m.name} | ${m.cells.map(c => c.text || '·').join(' | ')} | ${m.total} |`);
  L.push('', '## Часы 07–23 (энергия / вовлечённость, от −1 до +1, вес — минуты)', '',
    `- Лучшие: ${w.best.map(hourText).join('; ') || '—'}`, `- Худшие: ${w.worst.map(hourText).join('; ') || '—'}`);
  for (const h of HOURS) if (w.hours[h].min) L.push(`- ${hourText(h)} · ${w.hours[h].min} мин`);
  L.push('', '## Занятия', '', '| Занятие | Время | Энергия | Вовлечённость |', '|---|---|---|---|');
  for (const a of w.acts) L.push(`| ${actLabel(a.key)} | ${fmtDur(a.min)} | ${fmtAvg(a.ae)} | ${fmtAvg(a.av)} |`);
  L.push('', `- Даёт энергию: ${w.gives.map(a => actLabel(a.key)).join(', ') || '—'}`,
    `- Забирает: ${w.takes.map(a => actLabel(a.key)).join(', ') || '—'}`,
    '', '## Триггеры', '', `- ${db.settings.trigger_activity ? actLabel(db.settings.trigger_activity) : 'Занятие с триггером не выбрано'}: ${w.phoneN} раз, ${fmtDur(w.phoneMin)}`);
  for (const [k, n] of w.trig) L.push(`- ${k ? trigLabel(k) : 'не указан'}: ${n}`);
  L.push(`- По часам: ${Object.entries(w.trigHours).map(([h, n]) => `${pad(h)}:00 — ${n}`).join(', ') || '—'}`);
  return L.join('\n') + '\n';
}

function rowsCsv() {
  const q = v => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const out = ['date,from,to,minutes,activity,activity_label,note,energy,engagement,trigger,trigger_label,trigger_note,flow,recalled,checkin'];
  for (const day of Object.values(db.days).sort(byDate)) for (const r of day.rows) {
    out.push([day.date, r.from, r.to, rowMin(r), r.activity, actLabel(r.activity), r.note, r.energy, r.engagement,
      r.trigger ?? '', r.trigger ? trigLabel(r.trigger) : '', r.trigger_note, r.flow, r.recalled, r.checkin ?? ''].map(q).join(','));
  }
  return '﻿' + out.join('\n') + '\n';   // BOM — чтобы Excel узнал UTF-8
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text, done = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {   // старые браузеры и http:// без защищённого контекста
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  flash(done);
}

function exportJson() {
  const data = { version: 1, exported_at: isoLocal(), settings: db.settings, days: Object.values(db.days).sort(byDate) };
  download(`daylog-${logicalDate()}.json`, JSON.stringify(data, null, 2), 'application/json');
  meta.last_backup_at = isoLocal();
  saveMeta();
  render();
}

// Слияние по дате: побеждает более новый updated_at, равный — ничего не меняет (повторный импорт без дублей).
function mergeDay(d) {
  const cur = db.days[d.date];
  if (cur && time(d.updated_at) <= time(cur.updated_at)) return 'same';
  db.days[d.date] = d;
  return cur ? 'updated' : 'added';
}

async function importFiles(files) {
  const n = { added: 0, updated: 0, same: 0 };
  try {
    for (const f of files) {
      const text = await f.text();
      if (/\.md$/i.test(f.name)) {
        const d = parseDayMd(text, f.name);
        d.updated_at = isoLocal(new Date(f.lastModified));
        n[mergeDay(d)]++;
        continue;
      }
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.days)) throw new Error(`${f.name}: это не экспорт «Лога дня»`);
      if (data.settings) db.settings = normSettings(data.settings);
      for (const d of data.days) if (d?.date) n[mergeDay(normDay(d))]++;
    }
    save();
    flash(`Импорт: новых дней ${n.added}, обновлено ${n.updated}, без изменений ${n.same}`);
  } catch (e) {
    flash('Импорт не удался: ' + e.message);
  }
  render();
}

function needBackup() {
  const dates = Object.keys(db.days).filter(d => !db.days[d].demo).sort();
  if (!dates.length) return false;
  const since = meta.last_backup_at ? time(meta.last_backup_at) : parseDate(dates[0]).getTime();
  return now() - since > 7 * 864e5;
}

/* ───────────── Экраны ───────────── */

const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const btn = (act, arg, label, cls = '') => `<button type="button" class="${cls}" data-act="${act}" data-arg="${esc(arg)}">${esc(label)}</button>`;
const chip = (act, arg, label, on) =>
  `<button type="button" class="chip${on ? ' on' : ''}" data-act="${act}" data-arg="${esc(arg)}" aria-pressed="${!!on}">${esc(label)}</button>`;
const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);

function render() {
  const views = { today: viewToday, row: viewRow, close: viewClose, week: viewWeek, settings: viewSettings };
  const current = ui.view === 'row' || ui.view === 'close' ? 'today' : ui.view;
  const tab = (v, label) => `<button type="button" class="${current === v ? 'on' : ''}" data-act="go" data-arg="${v}">${label}</button>`;
  app.innerHTML = `<nav class="tabs">${tab('today', 'Сегодня')}${tab('week', 'Неделя')}${tab('settings', 'Настройки')}</nav>` + views[ui.view]();
  document.body.dataset.view = ui.view;
}

function viewToday() {
  const day = getDay(ui.date), isToday = ui.date === logicalDate();
  const marks = { done: ['✓', 'сделана'], due: ['●', 'пора'], ahead: ['○', 'впереди'] };
  const cks = activeCheckins().map(c => ({ ...c, st: checkinStatus(day, c, isToday) }));
  const due = isToday && cks.some(c => c.st === 'due');
  const total = day.rows.reduce((s, r) => s + rowMin(r), 0);
  return `
${needBackup() ? `<div class="banner">Сделай резервную копию: ${meta.last_backup_at ? 'последняя была больше недели назад' : 'копий ещё не было'}. ${btn('exportJson', '', 'Экспорт JSON')}</div>` : ''}
${folder.handle && !folder.ok ? `<div class="banner">Папка journal ждёт разрешения. ${btn('folderAllow', '', 'Разрешить')}</div>` : ''}
<header class="daynav">
  <button type="button" class="icon" data-act="shiftDay" data-arg="-1" aria-label="Предыдущий день">‹</button>
  <h1>${cap(fmtDate(ui.date))}${isToday ? '' : '<small>прошедший день</small>'}</h1>
  <button type="button" class="icon" data-act="shiftDay" data-arg="1" aria-label="Следующий день" ${isToday ? 'disabled' : ''}>›</button>
</header>
<section class="card">
  <div class="field"><label for="wake">Подъём</label>
    <div class="inline"><input id="wake" type="time" data-bind="wake" value="${day.wake || ''}">${btn('wakeNow', '', 'Сейчас')}</div></div>
  <div class="field"><label for="main">Главный результат дня</label>
    <input id="main" type="text" data-bind="main_result" value="${esc(day.main_result)}" placeholder="одна строка" autocomplete="off" enterkeyhint="done"></div>
</section>
<h2>Отметки</h2>
<div class="cks">${cks.map(c => `<button type="button" class="ck ${c.st}" data-act="newRow"><b>${c.t} ${marks[c.st][0]}</b><small>${marks[c.st][1]}</small></button>`).join('')}</div>
<h2>Лог <small>${day.rows.length ? `${day.rows.length} стр. · ${fmtDur(total)}` : ''}</small></h2>
${rowsList(day)}
<p class="muted small">Данные хранятся только на этом устройстве. ${btn('exportJson', '', 'Резервная копия (JSON)', 'link')}</p>
<div class="bar">${btn('newRow', '', due ? 'Отметка · пора' : 'Отметка', 'primary' + (due ? ' due' : ''))}${btn('go', 'close', 'Закрыть день')}</div>`;
}

function rowsList(day) {
  if (!day.rows.length) return '<p class="muted">Строк пока нет. Кнопка «Отметка» внизу.</p>';
  let out = '', prevEnd = null;
  for (const r of day.rows) {
    const [a, b] = rowSpan(r);
    // Дыра между строками ≥ 10 минут — подсказка восстановить по памяти.
    if (prevEnd != null && a - prevEnd >= 10) {
      out += `<li>${btn('fillGap', `${fromMin(prevEnd)}-${r.from}`, `пропуск ${fromMin(prevEnd)}–${r.from} · заполнить`, 'gap')}</li>`;
    }
    out += `<li>${rowItem(r)}</li>`;
    prevEnd = Math.max(prevEnd ?? 0, b);
  }
  return `<ul class="log">${out}</ul>`;
}

function rowItem(r) {
  const sg = (label, v) => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${label} ${sign(v)}</span>`;
  const extra = [
    r.trigger ? esc(trigLabel(r.trigger)) : isTriggerAct(r.activity) ? 'триггер —' : '',
    r.trigger_note ? `(${esc(r.trigger_note)})` : '',
    r.flow ? 'flow' : '', r.recalled ? 'по памяти' : '',
  ].filter(Boolean);
  return `<button type="button" class="logrow" data-act="editRow" data-arg="${r.id}">
  <span class="t">${r.from}–${r.to}<small>${fmtDur(rowMin(r))}</small></span>
  <span class="a">${esc(actLabel(r.activity))}${r.note ? `<em>: ${esc(r.note)}</em>` : ''}</span>
  <span class="m">${sg('энергия', r.energy)} · ${sg('вовл.', r.engagement)}${extra.length ? ' · ' + extra.join(' ') : ''}</span></button>`;
}

function newDraft(day, from) {
  const isToday = day.date === logicalDate();
  from = from ?? (reached(day) != null ? fromMin(reached(day)) : day.wake || '');
  return { ...ROW_TEMPLATE, activity: null, energy: null, engagement: null, from, to: isToday ? hm(now()) : from, recalled: !isToday };
}

function draftInfo() {
  const d = ui.draft;
  if (!d.from || !d.to) return ['', ''];
  const ov = overlaps(getDay(ui.date), d);
  return [fmtDur(rowMin(d)), ov.length ? 'Пересекается: ' + ov.map(r => `${r.from}–${r.to} ${actLabel(r.activity)}`).join(', ') : ''];
}

function showDraftInfo() {
  const [dur, warn] = draftInfo();
  document.getElementById('dur').textContent = dur;
  document.getElementById('overlap').textContent = warn;
}

// Поле «добавить в список»: в настройках видно всегда, в форме — по кнопке «+ новое» или когда список пуст.
const addBox = (name, ph) =>
  `<div class="inline add"><input id="add-${name}" type="text" data-add="${name}" placeholder="${ph}" autocomplete="off" enterkeyhint="done">${btn('listAdd', name, 'Добавить')}</div>`;

// Чипы списка в форме отметки (скрытые пункты не показываются).
function pickList(name) {
  const d = ui.draft, items = visible(name), first = name === 'activities' ? 'первое занятие' : 'первый триггер';
  const chips = items.map(x => (name === 'activities'
    ? chip('setDraft', 'activity:' + x.key, x.label, d.activity === x.key)
    : chip('setTrigger', x.key, x.label, d.trigger === x.key))).join('');
  const adding = ui.adding === name || !items.length;
  return `<div class="chips">${chips}${adding ? '' : btn('startAdd', name, '+ новое', 'chip add-chip')}</div>` + (adding
    ? `${items.length ? '' : `<p class="hint">Список пуст — добавь ${first}. Весь список правится в «Настройках».</p>`}${addBox(name, 'название')}`
    : '');
}

function viewRow() {
  const d = ui.draft, [dur, warn] = draftInfo();
  const three = (f, labels) => `<div class="seg">${[-1, 0, 1].map((v, i) => chip('setDraft', `${f}:${v}`, labels[i], d[f] === v)).join('')}</div>`;
  return `
<header class="formhead"><h1>${d.id ? 'Правка строки' : 'Отметка'} <small>${cap(fmtDate(ui.date))}</small></h1></header>
<div class="times">
  <label>От<input type="time" data-bind="row.from" value="${d.from}"></label>
  <label>До<input type="time" data-bind="row.to" value="${d.to}"></label>
  <output id="dur">${dur}</output>
</div>
<p id="overlap" class="warn" role="status">${esc(warn)}</p>
<h2>Занятие</h2>
${pickList('activities')}
<h2>Энергия после</h2>${three('energy', [MINUS + ' выжат', '0', '+ заряжен'])}
<h2>Вовлечённость во время</h2>${three('engagement', [MINUS + ' тянулось', '0', '+ затянуло'])}
${isTriggerAct(d.activity) ? `
<h2>Триггер <small>что было за минуту до?</small></h2>
${pickList('triggers')}
<div class="field"><input type="text" data-bind="row.trigger_note" value="${esc(d.trigger_note)}" placeholder="подробнее, по желанию" autocomplete="off" aria-label="Заметка к триггеру"></div>
${d.trigger ? '' : '<p class="hint">Триггер не выбран — можно сохранить и так.</p>'}` : ''}
<div class="field"><label for="rnote">Заметка <small>по желанию</small></label>
  <input id="rnote" type="text" data-bind="row.note" value="${esc(d.note)}" autocomplete="off" enterkeyhint="done"></div>
<label class="check"><input type="checkbox" data-bind="row.flow" ${d.flow ? 'checked' : ''}> flow — потерял счёт времени</label>
<label class="check"><input type="checkbox" data-bind="row.recalled" ${d.recalled ? 'checked' : ''}> по памяти — заполняю позже</label>
${d.id ? `
<section class="card">
  <div class="field"><label for="split">Разделить строку в</label>
    <div class="inline"><input id="split" type="time" data-bind="row.split" value="${d.split || ''}">${btn('splitRow', '', 'Разделить')}</div></div>
  ${btn('deleteRow', '', 'Удалить строку', 'danger')}
</section>` : ''}
<div class="bar">${btn('saveRow', '', 'Сохранить', 'primary')}${btn('saveRow', 'more', 'Сохранить и ещё')}</div>`;
}

function viewClose() {
  const day = getDay(ui.date), gh = greenhouseMin(day);
  const yn = (f, label) => `<div class="yn"><span>${label}</span><div class="seg">${chip('setBool', f + ':true', 'да', day[f] === true)}${chip('setBool', f + ':false', 'нет', day[f] === false)}</div></div>`;
  const area = (f, label, ph) => `<div class="field"><label for="${f}">${label}</label><textarea id="${f}" rows="3" data-bind="${f}" placeholder="${ph}">${esc(day[f].join('\n'))}</textarea></div>`;
  return `
<header class="formhead"><h1>Закрыть день <small>${cap(fmtDate(ui.date))}</small></h1></header>
<section class="card">
  <div class="field"><label for="wake">Подъём</label>
    <div class="inline"><input id="wake" type="time" data-bind="wake" value="${day.wake || ''}">${btn('wakeNow', '', 'Сейчас')}</div></div>
  <div class="field"><label for="screen">Экранное время <small>из «Экранного времени» телефона</small></label>
    <input id="screen" type="text" inputmode="text" data-bind="screen" value="${fmtDur(day.screen_min)}" placeholder="340, 5:40 или 5ч40" autocomplete="off">
    <small id="screenHint" class="muted">${screenHint(day.screen_min, fmtDur(day.screen_min))}</small></div>
  ${yn('main_done', 'Главный результат выполнен')}
  <p class="muted small">${day.main_result ? esc(day.main_result) : 'Главный результат не записан.'}</p>
</section>
<section class="card">${yn('backup', 'Бэкап приложения')}${yn('training', 'Тренировка')}${yn('dessert_ok', 'Дессерт только в своих окнах')}</section>
<section class="card">
  ${area('done', 'Сделано', '1–3 пункта, каждый с новой строки')}
  ${area('started', 'Начато, не доделано', '1–3 пункта')}
  ${area('failed', 'Не вышло', 'это данные, а не оценка')}
  <div class="field"><label for="note">Заметка дня</label><input id="note" type="text" data-bind="note" value="${esc(day.note)}" autocomplete="off"></div>
  ${area('tomorrow', 'Задачи на завтра', 'каждая с новой строки')}
</section>
${gh == null ? '' : `<p class="muted small">«${esc(actLabel(db.settings.goal_activity))}» за день: ${fmtDur(gh)} (${gh} мин) — считается по строкам лога.</p>`}
<div class="bar bar3">${btn('copyDay', '', 'Скопировать для /day', 'primary')}${btn('downloadMd', '', 'Скачать .md')}${btn('copyMd', '', 'Копировать .md')}</div>`;
}

function screenHint(min, raw) {
  if (min == null) return raw ? 'не понял формат: 340, 5:40 или 5ч40' : '';
  const lim = screenLimit(ui.date);
  return `= ${fmtDur(min)} (${min} мин)` + (lim ? ` · лимит недели ${fmtDur(lim)}${min > lim ? ', выше лимита' : ''}` : '');
}

function viewWeek() {
  ui.week ||= weekStart(logicalDate());
  const w = weekStats(ui.week), board = boardRows(w);
  const bar = v => `<span class="dbar">${v == null ? '' : `<i class="${v < 0 ? 'neg' : 'pos'}" style="width:${Math.abs(v) * 50}%"></i>`}</span>`;
  const hours = HOURS.map(h => {
    const x = w.hours[h];
    const cls = !x.min ? 'nodata' : w.best.includes(h) ? 'best' : w.worst.includes(h) ? 'worst' : '';
    return `<div class="hr ${cls}" title="${x.min} мин"><span class="h">${pad(h)}${cls === 'best' ? '▲' : cls === 'worst' ? '▼' : ''}</span>${bar(x.ae)}${bar(x.av)}<span class="v">${x.min ? `${fmtAvg(x.ae)} / ${fmtAvg(x.av)}` : '—'}</span></div>`;
  }).join('');
  const maxTrig = Math.max(1, ...w.trig.map(([, n]) => n));
  const names = list => list.map(a => esc(actLabel(a.key))).join(', ') || 'нет данных';
  return `
<header class="daynav">
  <button type="button" class="icon" data-act="shiftWeek" data-arg="-1" aria-label="Предыдущая неделя">‹</button>
  <h1>${rangeText(ui.week)}</h1>
  <button type="button" class="icon" data-act="shiftWeek" data-arg="1" aria-label="Следующая неделя">›</button>
</header>
<h2>Табло</h2>
<table class="board">
  <thead><tr><th></th>${w.dates.map(d => `<th>${DOW[parseDate(d).getDay()]}<small>${+d.slice(8)}</small></th>`).join('')}</tr></thead>
  <tbody>${board.map(m => `<tr><th scope="row">${m.short}</th>${m.cells.map(c => `<td class="${c.cls || ''}">${c.text}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<ul class="totals">${board.map(m => `<li><span>${esc(m.name)}</span><b>${m.total}</b></li>`).join('')}</ul>
<h2>Часы <small>энергия / вовлечённость, от −1 до +1, вес — минуты</small></h2>
<div class="hours">${hours}</div>
<p class="muted small">▲ три лучших часа, ▼ три худших (среднее энергии и вовлечённости). Серые — без данных.</p>
<h2>Занятия</h2>
${w.acts.length ? `<table class="acts"><thead><tr><th>Занятие</th><th>Время</th><th>Эн.</th><th>Вовл.</th></tr></thead><tbody>
${w.acts.map(a => `<tr><td>${esc(actLabel(a.key))}</td><td>${fmtDur(a.min)}</td><td>${fmtAvg(a.ae)}</td><td>${fmtAvg(a.av)}</td></tr>`).join('')}</tbody></table>
<ul class="totals"><li><span>Что даёт энергию</span><b>${names(w.gives)}</b></li><li><span>Что забирает</span><b>${names(w.takes)}</b></li></ul>` : '<p class="muted">Нет строк за эту неделю.</p>'}
<h2>Триггеры <small>${db.settings.trigger_activity ? `«${esc(actLabel(db.settings.trigger_activity))}»: ${w.phoneN} раз, ${fmtDur(w.phoneMin) || '0:00'}` : 'занятие с триггером не выбрано в настройках'}</small></h2>
${w.trig.length ? `<ul class="trig">${w.trig.map(([k, n]) => `<li><span>${esc(k ? trigLabel(k) : 'не указан')}</span><span class="cnt"><i style="width:${(n / maxTrig) * 100}%"></i></span><b>${n}</b></li>`).join('')}</ul>
<p class="small">По часам: ${Object.entries(w.trigHours).map(([h, n]) => `${pad(h)}:00 — ${n}`).join(' · ')}</p>` : '<p class="muted">Заходов не было.</p>'}
<div class="bar">${btn('copyWeek', '', 'Скопировать итоги недели', 'primary')}</div>`;
}

// Редактор списка: название правится на месте, ↑ поднимает пункт, ✕ удаляет
// (пункт, который уже есть в записях, не удаляется, а скрывается — старые строки сохраняют подпись).
function listEditor(name, ph) {
  const list = db.settings[name], hidden = list.filter(x => x.hidden);
  let firstShown = true;
  const items = list.map((x, i) => {
    if (x.hidden) return '';
    const up = `<button type="button" class="icon" data-act="listUp" data-arg="${name}:${i}" aria-label="Выше" ${firstShown ? 'disabled' : ''}>↑</button>`;
    firstShown = false;
    return `<li><input type="text" value="${esc(x.label)}" data-set="label" data-list="${name}" data-i="${i}" aria-label="Название" autocomplete="off">${up}` +
      `<button type="button" class="icon" data-act="listDelete" data-arg="${name}:${i}" aria-label="Удалить">✕</button></li>`;
  }).join('');
  return (items ? `<ul class="edit">${items}</ul>` : '<p class="muted small">Пока пусто.</p>') + addBox(name, ph) +
    (hidden.length ? `<p class="muted small">Скрыты, потому что есть в записях: ${hidden.map(x => `${esc(x.label)} ${btn('listRestore', `${name}:${list.indexOf(x)}`, 'вернуть', 'link')}`).join(' · ')}</p>` : '');
}

const roleSelect = (set, cur) => `<select id="${set}" data-set="${set}"><option value="">— не выбрано</option>${db.settings.activities.map(a =>
  `<option value="${esc(a.key)}"${a.key === cur ? ' selected' : ''}>${esc(a.label)}${a.hidden ? ' (скрыто)' : ''}</option>`).join('')}</select>`;

function viewSettings() {
  const s = db.settings, days = Object.values(db.days);
  const nRows = days.reduce((n, d) => n + d.rows.length, 0);
  return `
<h1>Настройки и данные</h1>
<section class="card">
  <h2>Данные</h2>
  <p class="muted small">Хранятся только в этом браузере (localStorage). Дней: ${days.length}, строк лога: ${nRows}.
  Последняя резервная копия: ${meta.last_backup_at ? meta.last_backup_at.slice(0, 16).replace('T', ' ') : 'ещё не было'}.</p>
  <div class="btns">${btn('exportJson', '', 'Экспорт JSON', 'primary')}${btn('importPick', '', 'Импорт JSON или .md')}${btn('exportCsv', '', 'CSV строк лога')}</div>
  <input type="file" id="importFile" accept=".json,.md,application/json,text/markdown" multiple hidden>
</section>
${folderSection()}
<section class="card">
  <h2>Занятия</h2>
  <p class="muted small">В этом порядке они идут чипами в форме отметки. Переименование не ломает старые записи.</p>
  ${listEditor('activities', 'Новое занятие')}
  <div class="field"><label for="trigger_activity">Спрашивать триггер у занятия <small>например, заход в ленты не по плану</small></label>${roleSelect('trigger_activity', s.trigger_activity)}</div>
</section>
<section class="card">
  <h2>Триггеры</h2>
  <p class="muted small">Что было за минуту до захода. Показываются только у выбранного выше занятия.</p>
  ${listEditor('triggers', 'Новый триггер')}
</section>
<section class="card">
  <h2>Отметки</h2>
  ${s.checkins.map((t, i) => `<div class="ckset"><label class="check"><input type="checkbox" data-set="ckOn" data-i="${i}" ${s.checkins_on[i] ? 'checked' : ''}> Отметка ${i + 1}</label><input type="time" data-set="ck" data-i="${i}" value="${t}" aria-label="Время отметки ${i + 1}"></div>`).join('')}
</section>
<section class="card">
  <h2>Цели</h2>
  <div class="field"><label for="wt">Подъём не позже</label><input id="wt" type="time" data-set="wake_target" value="${s.wake_target}"></div>
  <div class="field"><label for="goal_activity">Занятие с целью на неделю <small>его минуты идут в табло и в greenhouse_min</small></label>${roleSelect('goal_activity', s.goal_activity)}</div>
  <div class="field"><label for="gt">Цель по этому занятию за неделю, не меньше</label><input id="gt" type="text" data-set="greenhouse" value="${fmtDur(s.greenhouse_target_min)}"></div>
  <div class="field"><label for="ramp">Лестница экрана <small>с даты = лимит в день</small></label>
    <textarea id="ramp" rows="4" data-set="ramp">${s.screen_ramp.map(r => `${r.from} = ${fmtDur(r.max_min)}`).join('\n')}</textarea></div>
</section>
<section class="card">
  <h2>Демо и сброс</h2>
  <p class="muted small">Демо-неделя пишется в прошлую неделю и только в пустые дни.</p>
  <div class="btns">${btn('demo', '', 'Заполнить демо-неделей')}${btn('demoClear', '', 'Убрать демо-дни')}${btn('wipe', '', 'Удалить все данные', 'danger')}</div>
</section>`;
}

/* ───────────── Действия ───────────── */

let flashTimer = 0;
function flash(text) {
  const el = document.getElementById('flash');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 4000);
}

function showView(view) {
  ui.view = view;
  ui.adding = null;
  render();
  scrollTo(0, 0);
}

// Черновик → строка модели. Триггер хранится только у занятия с ролью «спрашивать триггер».
function toRow(d) {
  const phone = isTriggerAct(d.activity);
  return {
    id: d.id || newId(), from: d.from, to: d.to, activity: d.activity, note: d.note.trim(),
    energy: d.energy, engagement: d.engagement, trigger: phone ? d.trigger : null,
    trigger_note: phone ? d.trigger_note.trim() : '', flow: !!d.flow, recalled: !!d.recalled, checkin: checkinFor(d.to),
  };
}

const midpoint = r => { const [a, b] = rowSpan(r); return fromMin(Math.round((a + b) / 10) * 5); };
const isUsed = (name, key) => Object.values(db.days).some(d => d.rows.some(r => r[LISTS[name].field] === key));

// Изменения списков занятий и триггеров (настройки и форма отметки).
const listActions = {
  startAdd(name) {
    ui.adding = name;
    render();
    document.getElementById('add-' + name)?.focus();
  },
  listAdd(name) {
    const label = clean(document.getElementById('add-' + name)?.value);
    if (!label) return flash('Напиши название');
    const list = db.settings[name], same = list.find(x => x.label.toLowerCase() === label.toLowerCase());
    const item = same || { key: makeKey(label, list), label };
    if (!same) list.push(item);
    const restored = same?.hidden;
    delete item.hidden;
    save();
    if (ui.view === 'row') {   // добавили из формы — сразу выбираем
      ui.draft[LISTS[name].field] = item.key;
      ui.adding = null;
    }
    render();
    if (ui.view === 'settings') document.getElementById('add-' + name)?.focus();   // можно вводить следующий
    flash(!same ? `Добавлено: ${label}` : restored ? `Возвращено: ${same.label}` : `«${same.label}» уже есть`);
  },
  listUp(arg) {
    const [name, i] = arg.split(':'), list = db.settings[name];
    let j = +i - 1;
    while (j >= 0 && list[j].hidden) j--;
    if (j < 0) return;
    [list[j], list[+i]] = [list[+i], list[j]];
    save();
    render();
  },
  listDelete(arg) {
    const [name, i] = arg.split(':'), s = db.settings, item = s[name][+i];
    if (isUsed(name, item.key)) {
      item.hidden = true;
      flash(`«${item.label}» скрыто: оно есть в записях. Вернуть можно ниже.`);
    } else {
      s[name].splice(+i, 1);
      if (s.goal_activity === item.key) s.goal_activity = '';
      if (s.trigger_activity === item.key) s.trigger_activity = '';
      flash(`Удалено: ${item.label}`);
    }
    save();
    render();
  },
  listRestore(arg) {
    const [name, i] = arg.split(':');
    delete db.settings[name][+i].hidden;
    save();
    render();
  },
};

const actions = {
  ...listActions,
  go(v) {
    if (v === 'today') ui.date = logicalDate();
    showView(v);
  },
  shiftDay(n) {
    const d = addDays(ui.date, +n);
    if (d <= logicalDate()) { ui.date = d; render(); }
  },
  shiftWeek(n) { ui.week = addDays(ui.week, 7 * n); render(); },
  wakeNow() { setField('wake', hm(now())); render(); },
  newRow() { ui.draft = newDraft(getDay(ui.date)); showView('row'); },
  fillGap(arg) {
    const [from, to] = arg.split('-');
    ui.draft = { ...newDraft(getDay(ui.date), from), to };
    showView('row');
  },
  editRow(id) {
    const r = getDay(ui.date).rows.find(x => x.id === id);
    ui.draft = { ...r, split: midpoint(r) };
    showView('row');
  },
  setDraft(arg) {
    const [f, v] = arg.split(':');
    ui.draft[f] = f === 'activity' ? v : +v;
    render();
  },
  setTrigger(k) {
    ui.draft.trigger = ui.draft.trigger === k ? null : k;
    render();
  },
  saveRow(more) {
    const d = ui.draft, day = getDay(ui.date);
    const miss = [!d.from || !d.to ? 'время' : '', d.activity ? '' : 'занятие', d.energy == null ? 'энергию' : '', d.engagement == null ? 'вовлечённость' : ''].filter(Boolean);
    if (miss.length) return flash('Выбери: ' + miss.join(', '));
    const row = toRow(d), i = day.rows.findIndex(r => r.id === row.id);
    if (i >= 0) day.rows[i] = row; else day.rows.push(row);
    sortRows(day);
    touch(day);
    if (!more) { ui.draft = null; return showView('today'); }
    ui.draft = { ...newDraft(day, row.to), recalled: row.recalled };
    showView('row');
    flash(`Сохранено ${row.from}–${row.to}. Следующая строка`);
  },
  splitRow() {
    const d = ui.draft, [a, b] = rowSpan(d), t = d.split;
    if (!t || !(dayMin(t) > a && dayMin(t) < b)) return flash('Время раздела должно быть внутри строки');
    const day = getDay(ui.date), first = toRow({ ...d, to: t }), second = toRow({ ...d, id: '', from: t });
    day.rows = day.rows.filter(r => r.id !== d.id).concat(first, second);
    sortRows(day);
    touch(day);
    ui.draft = { ...second, split: midpoint(second) };
    showView('row');
    flash('Разделено. Открыта вторая часть — поменяй занятие, если нужно');
  },
  deleteRow() {
    if (!confirm('Удалить строку?')) return;
    const day = getDay(ui.date);
    day.rows = day.rows.filter(r => r.id !== ui.draft.id);
    touch(day);
    showView('today');
  },
  setBool(arg) {
    const [f, v] = arg.split(':'), day = getDay(ui.date), val = v === 'true';
    day[f] = day[f] === val ? null : val;   // повторное нажатие снимает ответ
    touch(day);
    render();
  },
  copyDay: () => copyText(dayLine(getDay(ui.date)), 'Строка для /day скопирована'),
  copyMd: () => copyText(dayMarkdown(getDay(ui.date)), 'Markdown дня скопирован'),
  downloadMd: () => download(ui.date + '.md', dayMarkdown(getDay(ui.date)), 'text/markdown'),
  copyWeek: () => copyText(weekMarkdown(ui.week), 'Итоги недели скопированы'),
  exportJson,
  exportCsv: () => download(`daylog-rows-${logicalDate()}.csv`, rowsCsv(), 'text/csv'),
  importPick: () => document.getElementById('importFile').click(),
  demo: fillDemo,
  demoClear() {
    const s = db.settings;
    for (const d of Object.keys(db.days)) if (db.days[d].demo) delete db.days[d];
    for (const name in LISTS) s[name] = s[name].filter(x => !x.demo || isUsed(name, x.key));
    if (!s.activities.some(a => a.key === s.goal_activity)) s.goal_activity = '';
    if (!s.activities.some(a => a.key === s.trigger_activity)) s.trigger_activity = '';
    save();
    render();
    flash('Демо-дни и демо-пункты списков убраны');
  },
  wipe() {
    if (!confirm('Удалить все дни и настройки из этого браузера? Сначала сделай экспорт JSON.')) return;
    for (const d of Object.keys(db.days)) delete db.days[d];
    db.settings = normSettings();
    save();
    render();
    flash('Данные удалены');
  },
  folderConnect, folderAllow, folderForget,
  async folderSyncNow() {
    try { flash(`Папка: из файлов обновлено дней — ${await folderSync()}`); }
    catch (e) { flash('Папка недоступна: ' + e.message); }
    render();
  },
};

// Поля, которые сохраняются на каждый ввод (без перерисовки — чтобы не терять фокус).
const binds = {
  wake: v => setField('wake', v || null),
  main_result: v => setField('main_result', v),
  screen: v => {
    const m = parseScreen(v);
    setField('screen_min', m);
    document.getElementById('screenHint').textContent = screenHint(m, v.trim());
  },
  note: v => setField('note', v),
  done: v => setField('done', lines(v)),
  started: v => setField('started', lines(v)),
  failed: v => setField('failed', lines(v)),
  tomorrow: v => setField('tomorrow', lines(v)),
  'row.from': v => { ui.draft.from = v; showDraftInfo(); },
  'row.to': v => { ui.draft.to = v; showDraftInfo(); },
  'row.note': v => (ui.draft.note = v),
  'row.trigger_note': v => (ui.draft.trigger_note = v),
  'row.flow': v => (ui.draft.flow = v),
  'row.recalled': v => (ui.draft.recalled = v),
  'row.split': v => (ui.draft.split = v),
};

// Строки «левое = правое» → объекты. Пустые строки пропускаются.
function parseLines(text, make) {
  return lines(text).map((l, n) => {
    const i = l.indexOf('=');
    if (i < 1) throw new Error(`строка ${n + 1}: нужен формат «… = …»`);
    return make(l.slice(0, i).trim(), l.slice(i + 1).trim());
  });
}
function applySetting(el) {
  const s = db.settings, i = +el.dataset.i, v = el.value.trim();
  try {
    switch (el.dataset.set) {
      case 'ck': if (v) s.checkins[i] = v; break;
      case 'ckOn': s.checkins_on[i] = el.checked; break;
      case 'wake_target': if (v) s.wake_target = v; break;
      case 'greenhouse': {
        const m = parseScreen(v);
        if (m == null) throw new Error('время в формате 7:30');
        s.greenhouse_target_min = m;
        break;
      }
      case 'ramp':
        s.screen_ramp = parseLines(v, (from, lim) => {
          const max = parseScreen(lim);
          if (!/^\d{4}-\d\d-\d\d$/.test(from) || max == null) throw new Error(`«${from} = ${lim}»: нужно 2026-10-19 = 6:00`);
          return { from, max_min: max };
        }).sort(byFrom);
        break;
      case 'label': {   // переименование пункта списка; ключ остаётся прежним
        const list = s[el.dataset.list], label = clean(v);
        if (!label) throw new Error('название не может быть пустым');
        if (list.some((x, j) => j !== i && x.label.toLowerCase() === label.toLowerCase())) throw new Error(`«${label}» уже есть в списке`);
        list[i].label = label;
        delete list[i].demo;
        break;
      }
      case 'goal_activity':
      case 'trigger_activity': s[el.dataset.set] = el.value; break;
    }
    save();
    flash('Настройки сохранены');
  } catch (e) {
    if (el.dataset.set === 'label') el.value = s[el.dataset.list][i].label;
    flash('Не сохранено: ' + e.message);
  }
}

app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act](el.dataset.arg, el);
});
app.addEventListener('input', e => {
  const el = e.target, fn = binds[el.dataset.bind];
  if (fn) fn(el.type === 'checkbox' ? el.checked : el.value);
});
app.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.set) applySetting(el);
  if (el.id === 'importFile') importFiles([...el.files]);
});
app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset.add) {
    e.preventDefault();
    actions.listAdd(e.target.dataset.add);
  }
});

/* ───────────── Демо-неделя ───────────── */

// [«подъём экран флаги», главный результат, «сделано|начато|не вышло|заметка|завтра» (пункты через ;), строки лога через |]
// Флаги — 4 цифры: главный результат, бэкап, тренировка, дессерт в окнах.
// Строка лога: «от до занятие энергия вовлечённость [триггер [заметка]]»; после занятия * — flow, ~ — по памяти.
const DEMO_LISTS = {
  activities: pairs('work Работа|project Главный проект|calls Созвоны|study Учёба|reading Чтение|sport Спорт|hobby Хобби|meal Еда|travel Дорога|home Дом|snack Перекус|feed Ленты не по плану|rest Отдых'),
  triggers: pairs('boredom скука|fatigue усталость|anxiety тревога|habit привычка|notification уведомление|excitement азарт|social общение'),
};
const DEMO = [
  ['07:50 340 1101', 'Черновик отчёта и 3 письма', 'Черновик отчёта|Письма (2 из 3)|Не разобрал почту|Лучше всего шло после обеда.|Дописать письма',
    '08:00 08:30 meal 0 0|08:30 11:30 work 0 +|11:30 12:00 feed − − boredom после сложного шага|12:00 13:30 project + +|13:30 14:10 meal + 0|14:15 14:55 snack 0 0|15:00 17:30 calls 0 0|17:30 18:10 travel 0 −|18:10 19:00 feed − − fatigue|19:00 21:00 hobby + +|21:00 21:45 home 0 0'],
  ['08:20 390 0111', 'Замеры для проекта', 'Сделал замеры|Чертёж (наполовину)|Не дошёл до учёбы|Утро шло лучше вечера.|Закончить чертёж;Позвонить заказчику',
    '08:30 09:00 meal 0 0|09:00 11:00 project + +|11:00 11:30 feed − 0 habit|11:30 13:00 study 0 −|13:00 14:00 meal + 0|14:10 14:30 snack 0 0|14:30 16:30 work 0 +|16:30 17:00 feed − − fatigue|17:00 18:00 sport + +|18:00 19:30 rest + 0|19:30 21:30 reading 0 +|21:30 22:30 feed − − boredom'],
  ['07:30 300 1101', 'Экран входа', 'Экран входа|Тесты для экрана входа||Шло легко с утра.|Тесты для экрана входа',
    '07:45 08:15 meal 0 0|08:15 10:45 work* + +|10:45 11:30 home 0 0|11:30 13:30 project + +|13:30 14:10 meal 0 0|14:10 14:40 snack 0 0|14:40 15:10 feed − − notification пришло сообщение|15:10 17:30 calls 0 0|17:30 19:00 hobby + +|19:00 20:00 travel 0 0|20:00 21:45 rest + 0'],
  ['07:55 420 0010', 'Созвон с заказчиком', '|Подготовка к созвону|Созвон перенёсся|Тревожный день, много телефона.|Созвон с заказчиком',
    '08:00 08:40 meal 0 0|08:40 10:30 calls 0 −|10:30 11:20 feed − − anxiety перед созвоном|11:20 12:30 study − −|12:30 14:10 meal 0 0|14:10 15:00 snack − 0|15:00 17:00 work 0 +|17:00 18:00 sport + +|18:00 19:00 feed − − fatigue|19:00 21:00 project~ + +|21:00 22:00 feed − − excitement'],
  ['07:45 310 1101', 'Отправить 3 заявки', 'Отправил 3 заявки;Каркас для проекта|Разбор заметок||Длинный блок проекта с утра — хорошо.|Обзор недели',
    '07:50 08:20 meal 0 0|08:20 11:30 project* + +|11:30 12:00 feed − − boredom|12:00 13:45 work 0 +|13:45 14:10 meal + 0|14:10 14:30 snack 0 0|14:30 16:00 reading 0 +|16:00 17:30 calls 0 −|17:30 19:30 home 0 0|19:30 21:45 hobby + +'],
  ['08:40 450 1111', 'Отдых и спорт', 'Спорт;Долгая прогулка|||Поздний подъём сдвинул всё.|Ранний подъём',
    '09:00 09:45 meal + 0|09:45 11:30 sport + +|11:30 12:30 feed − − habit|12:30 14:10 rest + 0|14:10 14:40 snack 0 0|14:40 16:00 project 0 +|16:00 17:30 travel 0 0|17:30 18:30 feed − − social|18:30 21:45 rest + +'],
  ['07:55 280 1101', 'Обзор недели', 'Обзор недели|План на неделю (черновик)||Спокойный день.|Дописать план недели',
    '08:00 08:30 meal 0 0|08:30 10:00 home 0 0|10:00 11:30 project + +|11:30 12:30 rest + 0|12:30 14:10 hobby + +|14:10 14:30 snack 0 0|14:30 15:00 feed − − boredom|15:00 17:30 reading 0 +|17:30 19:00 meal + 0|19:00 21:45 rest 0 0'],
];

// Демо добавляет в списки недостающие пункты (с пометкой demo) и назначает роли, только если они не заданы.
function demoLists() {
  const s = db.settings, keyMap = {};
  for (const name in DEMO_LISTS) for (const it of DEMO_LISTS[name]) {
    const found = s[name].find(x => x.key === it.key || x.label.toLowerCase() === it.label.toLowerCase());
    if (!found) s[name].push({ ...it, demo: true });
    keyMap[it.key] = found ? found.key : it.key;
  }
  s.goal_activity ||= keyMap.project;
  s.trigger_activity ||= keyMap.feed;
  return keyMap;
}

function fillDemo() {
  const monday = addDays(weekStart(logicalDate()), -7), key = demoLists();
  DEMO.forEach(([head, main, diary, rows], i) => {
    const date = addDays(monday, i);
    if (db.days[date] && !db.days[date].demo) return;   // настоящие дни не трогаем
    const [wake, screen, f] = head.split(' ');
    const [done, started, failed, note, tomorrow] = diary.split('|').map(s => s.split(';').filter(Boolean));
    db.days[date] = normDay({
      date, wake, main_result: main, main_done: f[0] === '1', screen_min: +screen,
      backup: f[1] === '1', training: f[2] === '1', dessert_ok: f[3] === '1',
      done, started, failed, note: note.join(''), tomorrow, updated_at: isoLocal(), demo: true,
      rows: rows.split('|').map(s => {
        const [from, to, act, e, v, trigger, ...tn] = s.split(' ');
        const [, activity, marks] = act.match(/^(\w+)([*~]*)$/);
        return { from, to, activity: key[activity], energy: signValue(e), engagement: signValue(v), trigger: trigger ? key[trigger] : null,
          trigger_note: tn.join(' '), flow: marks.includes('*'), recalled: marks.includes('~'), checkin: checkinFor(to) };
      }),
    });
  });
  save();
  ui.week = monday;
  showView('week');
  flash(`Демо-неделя: ${rangeText(monday)}. Убрать — в настройках`);
}

/* ───────────── Папка journal (Chrome и Edge на компьютере) ───────────── */
// Файлы ГГГГ-ММ-ДД.md в формате 1.5. Доступ к папке хранится в IndexedDB, разрешение браузер может сбросить.

const folder = { handle: null, ok: false, timer: 0, queue: new Set() };

function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('daylog', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', mode), r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

function folderSection() {
  if (!window.showDirectoryPicker) return '';   // Safari, Firefox, Android — только экспорт
  const status = !folder.handle ? 'Не подключена. Приложение будет читать и писать файлы дней ГГГГ-ММ-ДД.md, чужие разделы не трогает.'
    : folder.ok ? `Подключена «${esc(folder.handle.name)}». Дни пишутся в файлы автоматически.`
    : `«${esc(folder.handle.name)}»: браузер сбросил разрешение.`;
  return `<section class="card"><h2>Папка journal</h2><p class="muted small">${status}</p><div class="btns">
  ${!folder.handle ? btn('folderConnect', '', 'Подключить папку journal', 'primary') : folder.ok ? btn('folderSyncNow', '', 'Синхронизировать') : btn('folderAllow', '', 'Разрешить доступ', 'primary')}
  ${folder.handle ? btn('folderForget', '', 'Отключить') : ''}</div></section>`;
}

async function folderInit() {
  if (!window.showDirectoryPicker) return;
  folder.handle = (await kv('readonly', s => s.get('journal'))) || null;
  if (folder.handle) folder.ok = (await folder.handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  if (folder.ok) await folderSync();
}

async function folderConnect() {
  try {
    folder.handle = await window.showDirectoryPicker({ id: 'journal', mode: 'readwrite' });
    await kv('readwrite', s => s.put(folder.handle, 'journal'));
    folder.ok = true;
    await actions.folderSyncNow();
  } catch (e) {
    if (e.name !== 'AbortError') flash('Не удалось подключить: ' + e.message);
  }
}

async function folderAllow() {
  folder.ok = (await folder.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  if (folder.ok) await actions.folderSyncNow();
  else render();
}

async function folderForget() {
  await kv('readwrite', s => s.delete('journal'));
  Object.assign(folder, { handle: null, ok: false });
  render();
}

function folderQueue(date) {
  if (!folder.ok) return;
  folder.queue.add(date);
  clearTimeout(folder.timer);
  folder.timer = setTimeout(async () => {
    const dates = [...folder.queue];
    folder.queue.clear();
    try { for (const d of dates) await folderWrite(d); }
    catch (e) { folder.ok = false; flash('Папка недоступна: ' + e.message); }
  }, 1500);
}

async function folderWrite(date) {
  const day = db.days[date];
  if (!day || day.demo) return;
  const fh = await folder.handle.getFileHandle(date + '.md', { create: true });
  const old = await (await fh.getFile()).text();
  const text = old.trim() ? mergeMd(old, dayMarkdown(day)) : dayMarkdown(day);
  if (text !== old) {
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  meta.written[date] = (await fh.getFile()).lastModified;
  saveMeta();
}

// Файлы, изменённые после нашей записи, — в приложение (по правилу updated_at); наши более новые дни — в файлы.
async function folderSync() {
  let n = 0;
  for await (const [name, h] of folder.handle.entries()) {
    if (h.kind !== 'file' || !/^\d{4}-\d\d-\d\d\.md$/.test(name)) continue;
    const f = await h.getFile(), date = name.slice(0, 10);
    if (f.lastModified <= (meta.written[date] || 0)) continue;
    const d = parseDayMd(await f.text(), name);
    d.updated_at = isoLocal(new Date(f.lastModified));
    if (mergeDay(d) !== 'same') n++;
    meta.written[date] = f.lastModified;
  }
  save();
  saveMeta();
  for (const [date, day] of Object.entries(db.days)) if (time(day.updated_at) > (meta.written[date] || 0)) await folderWrite(date);
  return n;
}

/* ───────────── Запуск ───────────── */

// Раз в полминуты и при возвращении в приложение: обновить «пора» и перейти на новые сутки после 04:00.
function tick() {
  const t = logicalDate();
  if (t !== ui.today) {
    if (ui.date === ui.today) ui.date = t;
    ui.today = t;
  }
  if (ui.view === 'today' && !app.contains(document.activeElement)) render();
}

render();
setInterval(tick, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
folderInit().then(() => folder.handle && render()).catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
