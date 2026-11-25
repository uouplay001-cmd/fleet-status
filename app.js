/* Fleet Status app — สถานะรถวิ่งงาน ภาษี และ Leasing
 * ข้อมูลเก็บใน IndexedDB ของเบราว์เซอร์ แยกตาม บริษัท + งวด (YYYY-MM)
 * กติกาการจัดชั้นรถ (ยืนยันกับผู้ใช้แล้ว):
 *   วิ่งงาน = คอลัมน์เดือนของงวด = "วิ่งงาน"
 *   พร้อมใช้งาน ไม่มีงานวิ่ง = ไม่วิ่งงาน แต่ภาษีปกติ (สถานะภาษีเป็นวันที่)
 *   ไม่พร้อมใช้งาน = ม.89 / ม.79 / ไม่มีทะเบียน / ระงับทะเบียน
 *   ขายแล้ว = มีค่า "ขายแล้ว" ในเดือนใดก็ตามตั้งแต่ 01 ถึงงวดรายงาน (ไม่นับในฐาน)
 *   อัตราใช้ประโยชน์ = วิ่งงาน ÷ (วิ่งงาน + พร้อมใช้งานไม่มีงานวิ่ง)
 */
'use strict';

const TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const TIER = {
  run:  {label:'วิ่งงาน', cls:'p-run', color:'var(--run)'},
  idle: {label:'พร้อมใช้งาน ไม่มีงานวิ่ง', cls:'p-idle', color:'var(--idle)'},
  down: {label:'ไม่พร้อมใช้งาน', cls:'p-down', color:'var(--down)'},
  sold: {label:'ขายแล้ว', cls:'p-sold', color:'var(--sold)'},
};
const TIER_KEYS = ['run','idle','down'];
const DEFAULT_LOCMAP = {
  'Laemchabang Office Esso':'Sriracha Office',
  'NFC Plant SCC':'NFC Plant',
  'Songkhla Office SCC':'Songkhla Office',
  'Songkhla Office SCM (Offshore)':'Songkhla Office',
};

/* ---------- column mapping (อ่านจากหัวตาราง ไม่ผูกตำแหน่ง) ---------- */
const FIELDS = [
  ['seq', /^ลำดับ$/],
  ['buyDate', /วันที่ซื้อ/],
  ['company', /^บริษัท$/],
  ['assetS4', /รหัสสินทรัพย์\s*\(?(SAP|S4)/i],
  ['assetECC', /รหัสสินทรัพย์\s*\(?(Mac5|ECC)/i],
  ['desc', /^รายการ$/],
  ['plate', /^ทะเบียน(รถ)?$/],
  ['locRaw', /^Location$/i],
  ['sapStatus', /^สถานะ$/],
  ['lessorName', /(Leasing company name|ชื่อ\s*Leasing)/i],
  ['lessorCode', /^Leasing company$/i],
  ['agreementNo', /Agreement number/i],
  ['agreementDate', /Agreement date/i],
  ['leaseStart', /Lease start/i],
  ['noticeDate', /Notice date/i],
  ['leaseType', /Supplementary/i],
  ['vtype', /^ประเภทรถ$/],
  ['wbs', /^WBS/i],
  ['costCenter', /^Cost\s*Center$/i],
  ['note', /^หมายเหตุ$/],
  ['usage', /^การใช้งาน$/],
  ['sale', /^ขาย\s*\/\s*ไม่ขาย$/],
  ['contract', /^สัญญางาน$/],
  ['insurance', /^ประกันภัย$/],
  ['taxRaw', /^สถานะภาษี$/],
];
const FIELD_LABEL = {
  seq:'ลำดับ', buyDate:'วันที่ซื้อ', company:'บริษัท', assetS4:'รหัสสินทรัพย์ (SAP)', assetECC:'รหัสสินทรัพย์ (Mac5)',
  desc:'รายการ', plate:'ทะเบียนรถ', locRaw:'Location', sapStatus:'สถานะ', lessorCode:'Leasing company',
  lessorName:'Leasing company name', agreementNo:'Agreement number', agreementDate:'Agreement date',
  leaseStart:'Lease start date', noticeDate:'Notice date', leaseType:'Supplementary text', vtype:'ประเภทรถ',
  wbs:'WBS', costCenter:'Cost Center', note:'หมายเหตุ', usage:'การใช้งาน', sale:'ขาย/ไม่ขาย', contract:'สัญญางาน', insurance:'ประกันภัย', taxRaw:'สถานะภาษี',
};
const DATE_FIELDS = new Set(['buyDate','agreementDate','leaseStart','noticeDate']);
const MONTH_HDR = /วิ่งงาน[^\d]*(\d{1,2})[.\/-](\d{4})/;

/* ---------- utils ---------- */
const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtN = n => (n ?? 0).toLocaleString('th-TH');
const fmtP = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '–';
const pad2 = n => String(n).padStart(2, '0');
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const periodLabel = (y, m) => `${pad2(m)}.${y}`;
const keyOf = (co, y, m) => `${String(co).replace(/[^A-Za-z0-9_.~:@+-]/g, '-')}_${y}-${pad2(m)}`;

function serialToISO(v){
  const d = new Date(Math.round((v - 25569) * 864e5));
  return d.toISOString().slice(0, 10);
}
/** รับค่าวันที่หลายรูปแบบ (serial Excel, Date, dd/mm/yyyy พ.ศ./ค.ศ.) คืน 'YYYY-MM-DD' ค.ศ. หรือ null */
function toISO(v){
  if (v == null || v === '') return null;
  let iso = null;
  if (v instanceof Date && !isNaN(v)) iso = new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0,10);
  else if (typeof v === 'number' && v > 1000 && v < 200000) iso = serialToISO(v);
  else if (typeof v === 'string'){
    const s = v.trim();
    let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
    if (m){ let y = +m[3]; if (y < 100) y += y > 50 ? 2500 : 2000; iso = `${y}-${pad2(m[2])}-${pad2(m[1])}`; }
    else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else if (/^\d{5}(\.\d+)?$/.test(s)) iso = serialToISO(+s);
  }
  if (!iso) return null;
  let y = +iso.slice(0, 4);
  if (y > 2400) iso = (y - 543) + iso.slice(4);   // พ.ศ. → ค.ศ.
  return iso;
}
const fmtDT = ms => { const d = new Date(ms); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtD = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '–';
const monYear = iso => iso ? `${TH_MON[+iso.slice(5,7)-1]} ${iso.slice(0,4)}` : '–';
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const lastDayISO = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
function fmtPlate(p){
  const s = String(p ?? '').trim();
  return /^\d{6}$/.test(s) ? s.slice(0,2) + '-' + s.slice(2) : s;
}
function toast(msg, ms=2600){
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', ms);
}
const ls = {
  get(k, d){ try { const v = localStorage.getItem('fleet.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem('fleet.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------- state ---------- */
const S = {
  periods: [],          // ทุกงวดที่นำเข้า (เรียง)
  cur: null,            // งวดที่เลือก
  rows: [],             // แถวที่คำนวณแล้วของงวดที่เลือก
  tab: ls.get('tab', 'search'),
  q: '', fLoc: '', fType: '', fTax: '', fTier: 'all', fLeased: false, card: '', fField: null,
  favs: new Set(ls.get('favs', [])),
  locMap: {...DEFAULT_LOCMAP},
  refOverride: {},   // key -> ISO (มาจาก Store)
  taxWindow: ls.get('taxWindow', 90),
  shown: 100, selIdx: -1,
};

/* ---------- import ---------- */
function findHeader(aoa){
  let best = {row: -1, score: 0};
  for (let r = 0; r < Math.min(15, aoa.length); r++){
    const row = aoa[r] || []; let score = 0;
    for (const c of row){ const h = norm(c); if (!h) continue;
      if (FIELDS.some(([, re]) => re.test(h)) || MONTH_HDR.test(h)) score++; }
    if (score > best.score) best = {row: r, score};
  }
  return best;
}
function parseWorkbook(wb, fileName){
  // เลือกชีต: ชื่อที่รู้จักก่อน แล้วค่อยชีตที่หัวตารางเข้ากันมากที่สุด
  const preferred = ['สถานะการใช้งานรถ', '1_Data'];
  let pick = null;
  const cands = wb.SheetNames.map(n => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], {header: 1, defval: null, raw: true});
    return {n, aoa, h: findHeader(aoa)};
  });
  pick = cands.find(c => preferred.includes(c.n) && c.h.score >= 8)
      || cands.filter(c => c.h.score >= 8).sort((a, b) => b.h.score - a.h.score)[0];
  if (!pick) throw new Error('ไม่พบชีตข้อมูลรถ (ต้องมีหัวคอลัมน์ เช่น ทะเบียนรถ, Location, ประเภทรถ, สถานะภาษี, วิ่งงาน/ไม่วิ่งงาน MM.YYYY)');

  const hdr = (pick.aoa[pick.h.row] || []).map(norm);
  const col = {}; const months = {}; let year = null;
  hdr.forEach((h, i) => {
    if (!h) return;
    const mm = h.match(MONTH_HDR);
    if (mm){ const m = +mm[1]; if (m >= 1 && m <= 12 && months[m] == null){ months[m] = i; year = year || +mm[2]; } return; }
    for (const [f, re] of FIELDS) if (col[f] == null && re.test(h)){ col[f] = i; break; }
  });
  if (col.plate == null) throw new Error('ไม่พบคอลัมน์ "ทะเบียนรถ"');
  if (!Object.keys(months).length) throw new Error('ไม่พบคอลัมน์สถานะรายเดือน "วิ่งงาน/ไม่วิ่งงาน MM.YYYY"');

  const rows = [];
  for (let r = pick.h.row + 1; r < pick.aoa.length; r++){
    const a = pick.aoa[r] || [];
    const plate = a[col.plate];
    if (plate == null || String(plate).trim() === '') continue;
    const rec = {};
    for (const [f] of FIELDS){
      if (col[f] == null) { rec[f] = null; continue; }
      let v = a[col[f]];
      if (DATE_FIELDS.has(f)) v = toISO(v);
      else if (f === 'taxRaw') v = (typeof v === 'number' || v instanceof Date) ? toISO(v) : (v == null ? null : norm(v) || null);
      else v = v == null ? null : (typeof v === 'string' ? (norm(v) || null) : v);
      rec[f] = v;
    }
    rec.plate = String(rec.plate).trim();
    rec.months = Array.from({length: 12}, (_, i) => months[i+1] != null ? (norm(a[months[i+1]]) || null) : null);
    rows.push(rec);
  }

  // เดาเดือนงวด: จากชื่อไฟล์ → หัว WBS → เดือนสุดท้ายที่มีค่า วิ่งงาน/ไม่วิ่งงาน
  let pm = null, py = null, m;
  if ((m = fileName.match(/(?:^|[^\d])(\d{2})[.\-_](20\d{2})(?:[^\d]|$)/))){ pm = +m[1]; py = +m[2]; }
  else if ((m = fileName.match(/(20\d{2})(0[1-9]|1[0-2])(?:[^\d]|$)/))){ py = +m[1]; pm = +m[2]; }
  if (!pm && col.wbs != null && (m = hdr[col.wbs].match(/(\d{2})\.(\d{4})/))){ pm = +m[1]; py = +m[2]; }
  if (!pm){ for (let i = 11; i >= 0; i--) if (rows.some(r => r.months[i] === 'วิ่งงาน' || r.months[i] === 'ไม่วิ่งงาน')){ pm = i + 1; break; } }
  py = py || year || new Date().getFullYear();
  const companies = [...new Set(rows.map(r => r.company).filter(Boolean))];
  return {sheet: pick.n, rows, month: pm || 1, year: py, company: companies[0] || 'SCC', companies,
          mapped: Object.keys(col), missing: FIELDS.map(f => f[0]).filter(f => col[f] == null)};
}

/* ---------- compute ---------- */
function taxInfo(raw){
  if (!raw) return {group: 'ไม่มีข้อมูล', date: null, ok: false};
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return {group: 'ภาษีปกติ', date: raw, ok: true};
  if (/ม\.?\s*89/.test(raw)) return {group: 'แจ้งหยุดใช้รถ (ม.89)', date: null, ok: false};
  if (/ม\.?\s*79/.test(raw)) return {group: 'แจ้งหยุดใช้รถ (ม.79)', date: null, ok: false};
  if (/ไม่มีทะเบียน/.test(raw)) return {group: 'ไม่มีทะเบียน', date: null, ok: false};
  if (/ระงับ/.test(raw)) return {group: 'ระงับทะเบียน', date: null, ok: false};
  return {group: raw, date: null, ok: false};
}
function refDateOf(p){ return S.refOverride[p.key] || lastDayISO(p.year, p.month); }
function computeRow(r, month, ref, locMap){
  const t = taxInfo(r.taxRaw);
  let soldMonth = null;
  for (let i = 0; i < 12; i++) if (/ขายแล้ว/.test(r.months[i] || '')){ soldMonth = i + 1; break; }
  const cur = r.months[month - 1];
  let tier;
  if (soldMonth && soldMonth <= month) tier = 'sold';
  else if (cur === 'วิ่งงาน') tier = 'run';
  else if (t.ok) tier = 'idle';
  else tier = 'down';
  const leased = !!(r.lessorCode || r.lessorName);
  let usage = r.usage || '';
  if (usage === 'ใช้งานอื่น') usage = 'ใช้งานอื่นๆ';
  let runMonths = 0; for (let i = 0; i < month; i++) if (r.months[i] === 'วิ่งงาน') runMonths++;
  return {
    ...r, tier, cur, soldMonth, runMonths, usage,
    loc: locMap[r.locRaw] || r.locRaw || '(ไม่ระบุ)',
    vtype: r.vtype || '(ไม่ระบุ)',
    taxGroup: t.group, taxDate: t.date, taxDays: t.date ? daysBetween(t.date, ref) : null,
    leased, leaseKind: leased ? (r.leaseType || '(ไม่ระบุ)') : '-',
    leaseDue: leased ? (r.noticeDate ? r.noticeDate.slice(0, 4) : 'ค้ำประกันวงเงิน') : '-',
    watch: tier !== 'sold' && usage === 'ระงับใช้งาน' && t.ok,
    plateF: fmtPlate(r.plate),
  };
}
function computePeriod(p, month = p.month){
  const ref = month === p.month ? refDateOf(p) : lastDayISO(p.year, month);
  return p.rows.map(r => computeRow(r, month, ref, S.locMap));
}
function count(rows){
  const c = {run: 0, idle: 0, down: 0, sold: 0};
  rows.forEach(r => c[r.tier]++);
  c.base = c.run + c.idle + c.down; c.total = c.base + c.sold;
  c.util = (c.run + c.idle) ? c.run / (c.run + c.idle) : null;
  return c;
}
/** โครงสร้างกองรถรายเดือน: ใช้งวดที่นำเข้าไว้ของเดือนนั้น (ตรึงตัวเลขที่เคยรายงาน) ถ้าไม่มีคำนวณจากงวดปัจจุบัน */
function monthlySeries(p){
  const out = [];
  for (let m = 1; m <= p.month; m++){
    const snap = S.periods.find(x => x.company === p.company && x.year === p.year && x.month === m);
    if (snap && m !== p.month) out.push({m, src: 'snap', ...count(computePeriod(snap))});
    else out.push({m, src: m === p.month ? 'cur' : 'calc', ...count(computePeriod(p, m))});
  }
  return out;
}
function groupBy(rows, keyFn){
  const g = new Map();
  rows.forEach(r => { const k = keyFn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); });
  return g;
}
function prevPeriod(p){
  return S.periods.filter(x => x.company === p.company && (x.year * 12 + x.month) < (p.year * 12 + p.month)).pop() || null;
}
const recKey = r => r.assetS4 ? 'A' + r.assetS4 : 'P' + r.plate;
function diffPeriods(prev, cur){
  const a = new Map(computePeriod(prev).map(r => [recKey(r), r]));
  const b = new Map(computePeriod(cur).map(r => [recKey(r), r]));
  const added = [], removed = [], changes = [];
  const fields = [['tier', 'ชั้นการใช้งาน', v => TIER[v].label], ['taxRaw', 'สถานะภาษี', v => v && /^\d{4}-/.test(v) ? fmtD(v) : (v || '–')],
    ['loc', 'Location'], ['vtype', 'ประเภทรถ'], ['wbs', 'WBS'], ['usage', 'การใช้งาน'], ['leaseKind', 'ภาระผูกพัน'], ['plate', 'ทะเบียนรถ']];
  for (const [k, r] of b){
    const o = a.get(k);
    if (!o){ added.push(r); continue; }
    for (const [f, label, fmt] of fields){
      if ((o[f] ?? '') !== (r[f] ?? '')) changes.push({r, field: label, from: fmt ? fmt(o[f]) : (o[f] ?? '–'), to: fmt ? fmt(r[f]) : (r[f] ?? '–')});
    }
  }
  for (const [k, r] of a) if (!b.has(k)) removed.push(r);
  return {added, removed, changes};
}

/* ---------- storage ----------
 * ออนไลน์ (เปิดผ่าน claude.ai): ฐานข้อมูลกลางของ artifact
 *   periods/<key>              ข้อมูลงวด (meta + สถิติสรุป)
 *   periods/<key>/chunks/<i>   แถวรถ ทีละ CHUNK คัน (เก็บเป็น array ตามลำดับ ROW_COLS)
 *   config/settings            ตารางเทียบชื่อ Location + วันที่อ้างอิงที่แก้เอง
 *   เจ้าของ artifact เท่านั้นที่บันทึก/ลบได้ ผู้ใช้อื่นอ่านและส่งออกอย่างเดียว
 * ออฟไลน์ (เปิดไฟล์ในเครื่อง): IndexedDB ของเบราว์เซอร์ ผู้ใช้เครื่องนั้นบันทึกได้
 */
// ลำดับคอลัมน์ที่บันทึกในฐานข้อมูล: ห้ามแทรกกลาง ฟิลด์ใหม่ต่อท้ายเท่านั้น งวดเก่าจะได้ค่า null
const ADDED_COLS = ['costCenter'];
const ROW_COLS = [...FIELDS.map(f => f[0]).filter(f => !ADDED_COLS.includes(f)), 'months', ...ADDED_COLS];
const CHUNK = 150;
const encodeRow = r => ROW_COLS.map(f => r[f] ?? null);
const decodeRow = a => Object.fromEntries(ROW_COLS.map((f, i) => [f, a[i] ?? null]));
function periodStats(p){
  const c = count(p.rows.map(r => computeRow(r, p.month, lastDayISO(p.year, p.month), {})));
  return {run: c.run, idle: c.idle, down: c.down, sold: c.sold};
}

const Local = {
  db: null, mem: new Map(),
  async open(){
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('fleet-status', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('periods', {keyPath: 'key'});
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch (e) { console.warn('IndexedDB unavailable, using memory', e); this.db = null; }
  },
  tx(mode){ return this.db.transaction('periods', mode).objectStore('periods'); },
  req(r){ return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async all(){ return this.db ? this.req(this.tx('readonly').getAll()) : [...this.mem.values()]; },
  async put(p){ if (this.db) await this.req(this.tx('readwrite').put(p)); else this.mem.set(p.key, p); },
  async del(k){ if (this.db) await this.req(this.tx('readwrite').delete(k)); else this.mem.delete(k); },
};

/* ---------- โหมดเว็บ (GitHub Pages + Supabase) ----------
 * ผู้ดู: ใส่รหัสผ่านกลาง → อ่านผ่าน RPC fleet_list / fleet_rows ที่ตรวจรหัสก่อน
 * ผู้ดูแล: ล็อกอิน Supabase Auth (อยู่ในตาราง fleet_admins) → เขียนตารางได้ตาม RLS
 */
const SB = {
  client: null, pw: '',
  async init(cfg){
    this.client = supabase.createClient(cfg.url, cfg.key);
    this.pw = ls.get('viewerPw', '');
    const {data} = await this.client.auth.getSession();
    if (data.session) await this.checkAdmin();
  },
  async checkAdmin(){
    const {data, error} = await this.client.rpc('fleet_is_admin');
    Store.canWrite = !error && data === true;
    Store.adminEmail = Store.canWrite ? (await this.client.auth.getUser()).data.user?.email || '' : '';
  },
  async refresh(){
    const {data, error} = await this.client.rpc('fleet_list', {pw: this.pw});
    if (error){
      Store.needPw = /invalid_password/.test(error.message);
      Store.error = Store.needPw ? '' : 'อ่านข้อมูลไม่สำเร็จ: ' + error.message;
      Store.metas = []; return;
    }
    Store.needPw = false; Store.error = '';
    const st = data.settings || {};
    S.locMap = st.loc_map || {...DEFAULT_LOCMAP}; S.refOverride = {...(st.ref_override || {})};
    Store.metas = data.periods.map(p => ({key: p.key, company: p.company, year: p.year, month: p.month, label: p.label,
      fileName: p.file_name, sheet: p.sheet, importedAt: p.imported_at, chunks: p.chunks, rowCount: p.row_count, stats: p.stats}));
  },
  async rows(p){
    const {data, error} = await this.client.rpc('fleet_rows', {pw: this.pw, p_key: p.key});
    if (error) throw error;
    return data.flat().map(decodeRow);
  },
  async put(p, progress){
    const c = this.client, n = Math.ceil(p.rows.length / CHUNK);
    const {rows, ...m} = p;
    const meta = {key: m.key, company: m.company, year: m.year, month: m.month, label: m.label, file_name: m.fileName,
      sheet: m.sheet, imported_at: m.importedAt, chunks: n, row_count: rows.length, stats: periodStats(p)};
    let r = await c.from('fleet_periods').upsert(meta); if (r.error) throw r.error;
    for (let i = 0; i < n; i++){
      progress(i + 1, n);
      r = await c.from('fleet_chunks').upsert({period_key: p.key, idx: i, rows: rows.slice(i * CHUNK, (i + 1) * CHUNK).map(encodeRow)});
      if (r.error) throw r.error;
    }
    r = await c.from('fleet_chunks').delete().eq('period_key', p.key).gte('idx', n); if (r.error) throw r.error;
  },
  async del(p){ const r = await this.client.from('fleet_periods').delete().eq('key', p.key); if (r.error) throw r.error; },
  async saveSettings(){
    const r = await this.client.from('fleet_settings').upsert({id: 1, loc_map: S.locMap, ref_override: S.refOverride});
    if (r.error) throw r.error;
  },
};

const Store = {
  mode: 'local',        // 'local' | 'cloud' | 'nodb' | 'sb'
  needPw: false, adminEmail: '',
  canWrite: true,
  db: null, downloads: null,
  metas: [], ready: false, error: '',
  rowCache: new Map(),  // key@importedAt -> Promise<rows>
  onChange: () => {},
  async init(onChange){
    this.onChange = onChange;
    if (window.claude && typeof claude.use === 'function'){
      this.mode = 'cloud'; this.canWrite = false;
      const [db, user, downloads] = await Promise.all([claude.use('db'), claude.use('user'), claude.use('downloads')]);
      this.downloads = downloads;
      this.canWrite = user ? await user.isOwner() : false;
      if (!db){ this.mode = 'nodb'; this.canWrite = false; this.ready = true; this.error = 'ยังเปิดฐานข้อมูลไม่ได้ ลองลงชื่อเข้าใช้ claude.ai แล้วเปิดหน้านี้อีกครั้ง'; return onChange(); }
      this.db = db;
      const timer = setTimeout(() => { if (!this.ready){ this.error = 'ยังเชื่อมต่อฐานข้อมูลไม่ได้ ข้อมูลจะแสดงทันทีที่เชื่อมต่อได้'; onChange(); } }, 10000);
      db.doc('config/settings').onSnapshot(snap => {
        const d = snap.exists ? snap.data() : {};
        S.locMap = d.locMap || {...DEFAULT_LOCMAP}; S.refOverride = {...(d.refOverride || {})};
        if (this.ready) onChange();
      }, e => console.warn('settings', e));
      db.collection('periods').onSnapshot(snap => {
        this.metas = snap.docs.map(d => ({...d.data(), key: d.id}));
        if (!snap.metadata.fromCache){ clearTimeout(timer); this.error = ''; }
        this.ready = true; onChange();
      }, e => { clearTimeout(timer); this.ready = true; this.error = 'อ่านข้อมูลไม่สำเร็จ (' + e.code + ')'; onChange(); });
      return;
    }
    if (window.FLEET_CONFIG && window.supabase){
      this.mode = 'sb'; this.canWrite = false;
      try { await SB.init(window.FLEET_CONFIG); await SB.refresh(); }
      catch (e){ this.error = 'เชื่อมต่อฐานข้อมูลไม่ได้: ' + (e.message || e); }
      this.ready = true; return onChange();
    }
    await Local.open();
    S.locMap = ls.get('locMap', DEFAULT_LOCMAP); S.refOverride = ls.get('refOverride', {});
    this.metas = await Local.all(); this.ready = true; onChange();
  },
  /** ให้แน่ใจว่างวดนี้มีแถวข้อมูล (ออนไลน์จะโหลดจากฐานข้อมูลครั้งเดียวแล้วเก็บไว้) */
  async ensureRows(p){
    if (p.rows) return p;
    const ck = p.key + '@' + p.importedAt;
    if (!this.rowCache.has(ck)){
      const job = this.mode === 'sb' ? SB.rows(p) : (async () => {
        const snaps = await Promise.all(Array.from({length: p.chunks || 0}, (_, i) => this.db.doc(`periods/${p.key}/chunks/${i}`).get()));
        return snaps.flatMap(s => (s.exists ? s.data().rows : []).map(decodeRow));
      })();
      job.catch(() => this.rowCache.delete(ck));
      this.rowCache.set(ck, job);
    }
    p.rows = await this.rowCache.get(ck);
    return p;
  },
  async put(p, progress = () => {}){
    if (this.mode === 'local'){ await Local.put(p); this.metas = await Local.all(); return this.onChange(); }
    if (this.mode === 'sb'){
      await SB.put(p, progress);
      this.rowCache.set(p.key + '@' + p.importedAt, Promise.resolve(p.rows));
      return SB.refresh();
    }
    const old = this.metas.find(m => m.key === p.key);
    const n = Math.ceil(p.rows.length / CHUNK);
    for (let i = 0; i < n; i++){   // เขียนทีละก้อน รอให้เสร็จก่อนก้อนถัดไป
      progress(i + 1, n);
      await this.db.doc(`periods/${p.key}/chunks/${i}`).set({i, rows: p.rows.slice(i * CHUNK, (i + 1) * CHUNK).map(encodeRow)});
    }
    for (let i = n; i < (old?.chunks || 0); i++) await this.db.doc(`periods/${p.key}/chunks/${i}`).delete();
    const {rows, ...meta} = p;
    this.rowCache.set(p.key + '@' + p.importedAt, Promise.resolve(rows));
    await this.db.doc(`periods/${p.key}`).set({...meta, chunks: n, rowCount: rows.length, stats: periodStats(p)});
  },
  async del(p){
    if (this.mode === 'local'){ await Local.del(p.key); this.metas = await Local.all(); return this.onChange(); }
    if (this.mode === 'sb'){ await SB.del(p); return SB.refresh(); }
    await this.db.doc(`periods/${p.key}`).delete();
    for (let i = 0; i < (p.chunks || 0); i++) await this.db.doc(`periods/${p.key}/chunks/${i}`).delete();
  },
  async saveSettings(){
    if (this.mode === 'local'){ ls.set('locMap', S.locMap); ls.set('refOverride', S.refOverride); return; }
    if (this.mode === 'sb') return SB.saveSettings();
    await this.db.doc('config/settings').set({locMap: S.locMap, refOverride: S.refOverride});
  },
};
async function saveFile(filename, data){
  if (Store.mode === 'cloud' || Store.mode === 'nodb'){
    if (!Store.downloads){ toast('มุมมองนี้ดาวน์โหลดไฟล์ไม่ได้ ลองเปิดผ่าน claude.ai', 4000); return; }
    try { await Store.downloads.save({filename, data}); toast('ส่งออก ' + filename); }
    catch (e){ if (e.code !== 'declined') toast('ส่งออกไม่สำเร็จ: ' + (e.message || e.code), 4000); }
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('ส่งออก ' + filename);
}

/* ---------- render helpers ---------- */
const pill = t => `<span class="pill ${TIER[t].cls}">${TIER[t].label}</span>`;
function taxPill(r){
  if (r.taxGroup === 'ภาษีปกติ'){
    const d = r.taxDays;
    const cls = d < 0 ? 'p-info' : d <= 30 ? 'p-down' : d <= S.taxWindow ? 'p-idle' : 'p-run';
    return `<span class="pill ${cls}" title="${d < 0 ? 'เลยวันอ้างอิง: ต่อภาษีแล้ว รอฝ่ายประกันอัปเดตวันที่' : 'อีก ' + d + ' วัน'}">ครบ ${monYear(r.taxDate)}</span>`;
  }
  return `<span class="pill p-down">${esc(r.taxGroup)}</span>`;
}
const leasePill = r => r.leased ? `<span class="pill p-info">${esc(r.leaseKind)}</span>` : '<span class="faint small">ปลอดภาระ</span>';
const deltaTxt = (now, before, invert) => {
  if (before == null) return '';
  const d = now - before; if (!d) return '<span class="muted">เท่าเดิม</span>';
  const good = invert ? d < 0 : d > 0;
  return `<span class="${good ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${fmtN(Math.abs(d))}</span>`;
};
const EXPORTS = {};   // id -> () => {name, rows(aoa)}
function exportBtn(id){ return `<button class="btn sm" data-export="${id}" title="ส่งออกตารางนี้เป็น Excel">⭳ Excel</button>`; }
/** ตารางสรุปแบบ ฐานคงเหลือ แยก วิ่งงาน/พร้อมใช้/ไม่พร้อม + ขายแล้ว */
function tierTable(id, title, groups, firstCol, sortBy = 'base'){
  const list = [...groups].map(([k, rows]) => ({k, ...count(rows)})).sort((a, b) => b[sortBy] - a[sortBy] || String(a.k).localeCompare(String(b.k), 'th'));
  const tot = list.reduce((s, x) => { ['base','run','idle','down','sold','total'].forEach(f => s[f] += x[f]); return s; }, {base:0,run:0,idle:0,down:0,sold:0,total:0});
  const head = [firstCol, 'ฐานคงเหลือ', 'วิ่งงาน', 'พร้อมใช้ ไม่มีงานวิ่ง', 'ไม่พร้อมใช้งาน', 'อัตราใช้ประโยชน์', 'ขายแล้ว'];
  EXPORTS[id] = () => ({name: title, rows: [head, ...list.map(x => [x.k, x.base, x.run, x.idle, x.down, x.util == null ? '' : +x.util.toFixed(4), x.sold]),
    ['รวม', tot.base, tot.run, tot.idle, tot.down, (tot.run + tot.idle) ? +(tot.run / (tot.run + tot.idle)).toFixed(4) : '', tot.sold]]});
  const bar = x => x.base ? `<div class="bar">${TIER_KEYS.map(t => `<span style="width:${x[t] / x.base * 100}%;background:${TIER[t].color}"></span>`).join('')}</div>` : '';
  return `<h2 class="sec">${esc(title)}<span class="spacer"></span>${exportBtn(id)}</h2>
  <div class="tblwrap"><table><thead><tr>${head.map((h, i) => `<th class="${i ? 'n' : ''}">${h}</th>`).join('')}<th>สัดส่วน</th></tr></thead><tbody>
  ${list.map(x => `<tr class="click" data-drill="${esc(id)}" data-k="${esc(x.k)}"><td>${esc(x.k)}</td><td class="n">${fmtN(x.base)}</td><td class="n">${fmtN(x.run)}</td><td class="n">${fmtN(x.idle)}</td><td class="n">${fmtN(x.down)}</td><td class="n">${x.util == null ? '–' : (x.util * 100).toFixed(1) + '%'}</td><td class="n">${x.sold ? fmtN(x.sold) : '–'}</td><td>${bar(x)}</td></tr>`).join('')}
  </tbody><tfoot><tr><td>รวม</td><td class="n">${fmtN(tot.base)}</td><td class="n">${fmtN(tot.run)}</td><td class="n">${fmtN(tot.idle)}</td><td class="n">${fmtN(tot.down)}</td><td class="n">${fmtP(tot.run, tot.run + tot.idle)}</td><td class="n">${fmtN(tot.sold)}</td><td></td></tr></tfoot></table></div>`;
}
/** ตารางรายคันแบบย่อ */
const LIST_COLS = [
  ['ทะเบียน', r => r.plateF], ['ประเภทรถ', r => r.vtype], ['Location', r => r.loc], ['ชั้นการใช้งาน', r => TIER[r.tier].label],
  ['สถานะภาษี', r => r.taxGroup === 'ภาษีปกติ' ? 'ครบกำหนด ' + monYear(r.taxDate) : r.taxGroup], ['วันครบกำหนดภาษี', r => fmtD(r.taxDate)],
  ['ภาระผูกพัน', r => r.leased ? 'ติดภาระ' : 'ปลอดภาระ'], ['ประเภทภาระ', r => r.leaseKind], ['ผู้ให้สินเชื่อ', r => r.lessorName || '-'],
  ['ครบกำหนดภาระ', r => r.leaseDue], ['การใช้งาน', r => r.usage || '-'], ['สัญญางาน', r => r.contract || '-'],
];
function listTable(id, title, rows, cols, opts = {}){
  EXPORTS[id] = () => ({name: title, rows: [cols.map(c => c[0]), ...rows.map(r => cols.map(c => c[1](r)))]});
  const lim = opts.limit || 300;
  return `<h2 class="sec">${esc(title)} <span class="muted small">${fmtN(rows.length)} คัน</span><span class="spacer"></span>${exportBtn(id)}</h2>
  ${opts.note ? `<div class="muted small" style="margin:-4px 0 8px">${opts.note}</div>` : ''}
  ${rows.length ? `<div class="tblwrap" style="max-height:${opts.h || 460}px"><table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>
  ${rows.slice(0, lim).map(r => `<tr class="click" data-open="${esc(recKey(r))}">${cols.map(c => `<td>${c[2] ? c[2](r) : esc(c[1](r))}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>${rows.length > lim ? `<div class="muted small" style="margin-top:6px">แสดง ${lim} จาก ${fmtN(rows.length)} คัน · ส่งออก Excel เพื่อดูทั้งหมด</div>` : ''}`
  : '<div class="note info">ไม่มีรายการ</div>'}`;
}
const baseRows = () => S.rows.filter(r => r.tier !== 'sold');
function soldFoot(rows){
  const sold = S.rows.filter(r => r.tier === 'sold').length;
  return `<div class="muted small" style="margin-top:6px">ฐานคงเหลือ ${fmtN(rows)} คัน · บวก รถขายแล้วสะสม (นอกฐาน) ${fmtN(sold)} คัน · รวมรถทั้งหมดในไฟล์ ${fmtN(S.rows.length)} คัน</div>`;
}

/* ---------- tabs ---------- */
function render(){
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  for (const k in EXPORTS) delete EXPORTS[k];
  const main = $('#main');
  if (Store.needPw){ main.innerHTML = gateView(); const i = $('#viewerPw'); if (i) i.focus(); return; }
  if (!S.cur && S.tab !== 'io'){ main.innerHTML = emptyState(); return; }
  main.innerHTML = ({search: viewSearch, run: viewRun, tax: viewTax, lease: viewLease, io: viewIO})[S.tab]();
  if (S.tab === 'search') bindSearch();
}
function gateView(){
  return `<div class="empty" style="max-width:440px;margin:0 auto;text-align:left">
  <h2 style="text-align:center">ใส่รหัสผ่านเพื่อดูข้อมูลรถ</h2>
  <p class="muted" style="text-align:center">ขอรหัสผ่านได้จากผู้ดูแลระบบ เครื่องนี้จะจำรหัสไว้ ครั้งต่อไปไม่ต้องใส่อีก</p>
  <form id="pwForm" class="row" style="flex-wrap:nowrap">
    <input type="password" id="viewerPw" autocomplete="current-password" placeholder="รหัสผ่าน" aria-label="รหัสผ่านสำหรับผู้ดู" style="flex:1;padding:11px 12px">
    <button class="btn pri" type="submit">เข้าดูข้อมูล</button>
  </form>
  <p id="pwErr" class="small" style="color:var(--down);min-height:1.5em">${Store.pwError ? esc(Store.pwError) : ''}</p>
  <p class="small muted" style="text-align:center">ผู้ดูแลระบบ? <a href="#" data-act="adminLogin">เข้าสู่ระบบผู้ดูแล</a></p></div>`;
}
function adminLoginModal(){
  showModal(`<h2>เข้าสู่ระบบผู้ดูแล</h2>
  <p class="muted small">ใช้บัญชีผู้ดูแลที่สร้างไว้ใน Supabase ผู้ดูแลนำเข้า แก้ไข ลบข้อมูล และตั้งรหัสผ่านของผู้ดูได้</p>
  <form id="loginForm" style="display:grid;gap:10px;margin-top:12px">
    <input type="email" id="adEmail" autocomplete="username" placeholder="อีเมล" aria-label="อีเมลผู้ดูแล">
    <input type="password" id="adPw" autocomplete="current-password" placeholder="รหัสผ่าน" aria-label="รหัสผ่านผู้ดูแล">
    <p id="loginErr" class="small" style="color:var(--down);margin:0;min-height:1.4em"></p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="closeModal">ยกเลิก</button><button type="submit" class="btn pri">เข้าสู่ระบบ</button></div>
  </form>`);
  $('#adEmail').focus();
}
function emptyState(){
  if (!Store.ready) return `<div class="empty"><h2>กำลังโหลดข้อมูลรถ…</h2><p>${esc(Store.error || 'ดึงข้อมูลงวดล่าสุดจากฐานข้อมูล')}</p></div>`;
  if (Store.error) return `<div class="empty"><h2>ยังแสดงข้อมูลไม่ได้</h2><p>${esc(Store.error)}</p></div>`;
  if (!Store.canWrite) return `<div class="empty"><h2>ยังไม่มีข้อมูลรถ</h2><p>ผู้ดูแลยังไม่ได้นำเข้าข้อมูลประจำเดือน เมื่อนำเข้าแล้วข้อมูลจะแสดงที่หน้านี้ทันที</p></div>`;
  return `<div class="empty"><h2>ยังไม่มีข้อมูลรถ</h2>
  <p>นำเข้าไฟล์ Excel สถานะรถประจำเดือน (เช่น <b>00 SCC อัพเดต สถานะรถ MM.YYYY.xlsx</b> หรือ <b>FleetStatus_SCC_YYYYMM.xlsx</b>)</p>
  <p><button class="btn pri" data-act="pick">⭱ เลือกไฟล์ Excel</button></p>
  <p class="small">${Store.mode === 'local' ? 'ข้อมูลจะเก็บไว้ในเบราว์เซอร์เครื่องนี้เท่านั้น' : 'ข้อมูลจะบันทึกในฐานข้อมูลกลาง ผู้ที่ได้รับลิงก์ดูและส่งออกได้ แต่บันทึกหรือลบไม่ได้'}</p></div>`;
}

/* ===== ค้นหา ===== */
function filtered(){
  const q = S.q.trim().toLowerCase().replace(/-/g, '');
  const terms = q ? q.split(/\s+/) : [];
  return S.rows.filter(r => {
    if (S.fTier !== 'all' && r.tier !== S.fTier) return false;
    if (S.fLoc && r.loc !== S.fLoc) return false;
    if (S.fType && r.vtype !== S.fType) return false;
    if (S.fTax && r.taxGroup !== S.fTax) return false;
    if (S.fLeased && !r.leased) return false;
    if (S.card === 'taxSoon' && !(r.tier !== 'sold' && r.taxDays != null && r.taxDays >= 0 && r.taxDays <= S.taxWindow)) return false;
    if (S.card === 'watch' && !r.watch) return false;
    if (S.card === 'run' && r.tier !== 'run') return false;
    if (S.card === 'fav' && !S.favs.has(recKey(r))) return false;
    if (S.fField && String(fieldVal(r, S.fField.f)) !== String(S.fField.v)) return false;
    if (terms.length){
      const hay = [r.plate, r.plateF, r.desc, r.assetS4, r.assetECC, r.wbs, r.costCenter, r.loc, r.locRaw, r.vtype, r.contract, r.lessorName, r.agreementNo, r.note, r.usage, r.sale]
        .map(x => String(x ?? '')).join(' ').toLowerCase().replace(/-/g, '');
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });
}
function opts(values, sel, all){
  return `<option value="">${all}</option>` + values.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function viewSearch(){
  const R = S.rows, base = baseRows(), c = count(R);
  const uniq = f => [...new Set(R.map(f))].sort((a, b) => String(a).localeCompare(String(b), 'th'));
  const taxSoon = base.filter(r => r.taxDays != null && r.taxDays >= 0 && r.taxDays <= S.taxWindow).length;
  const watch = R.filter(r => r.watch).length;
  const card = (id, num, h, p) => `<button class="card ${S.card === id ? 'on' : ''}" data-card="${id}"><div class="num">${num}</div><h3>${h}</h3><p>${p}</p></button>`;
  return `
  <div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input type="search" id="q" placeholder="พิมพ์ทะเบียนรถ, รหัสสินทรัพย์, WBS, Cost Center, Location หรือสัญญางาน" value="${esc(S.q)}" autocomplete="off"></div>
  <div class="filters">
    <select id="fLoc" aria-label="Location">${opts(uniq(r => r.loc), S.fLoc, 'ทุก Location')}</select>
    <select id="fType" aria-label="ประเภทรถ">${opts(uniq(r => r.vtype), S.fType, 'ทุกประเภทรถ')}</select>
    <select id="fTax" aria-label="สถานะภาษี">${opts(uniq(r => r.taxGroup), S.fTax, 'ทุกสถานะภาษี')}</select>
    <div class="seg" id="fTier">${[['all', 'ทั้งหมด'], ['run', 'วิ่งงาน'], ['idle', 'พร้อมใช้'], ['down', 'ไม่พร้อมใช้'], ['sold', 'ขายแล้ว']]
      .map(([k, l]) => `<button data-tier="${k}" class="${S.fTier === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label class="chk"><input type="checkbox" id="fLeased" ${S.fLeased ? 'checked' : ''}> เฉพาะรถติดภาระ Leasing</label>
  </div>
  <div class="cards">
    ${card('run', fmtN(c.run) + ' <span class="muted small">/ ' + fmtN(c.base) + '</span>', 'รถวิ่งงานงวดนี้', 'อัตราใช้ประโยชน์ ' + fmtP(c.run, c.run + c.idle) + ' ของรถพร้อมใช้งาน')}
    ${card('taxSoon', fmtN(taxSoon), `ภาษีครบกำหนดใน ${S.taxWindow} วัน`, 'นับจากวันที่อ้างอิง ' + fmtD(refDateOf(S.cur)))}
    ${card('watch', fmtN(watch), 'ระงับใช้งาน ภาษียังปกติ', 'ปล่อยหมดอายุตามรอบ ไม่ต่อภาษีเพิ่ม')}
    ${card('fav', fmtN(S.favs.size), 'รายการโปรด', 'กดดาว ☆ ที่รายการเพื่อเก็บไว้ที่นี่')}
  </div>
  <div id="results"></div>
  <div class="foot">
    <b>หลักการจัดชั้นรถ</b> ${pill('run')} คอลัมน์เดือนของงวด = วิ่งงาน · ${pill('idle')} ไม่วิ่งงานแต่ภาษีปกติ · ${pill('down')} ม.89 / ไม่มีทะเบียน / ระงับทะเบียน · ${pill('sold')} มีสถานะขายแล้วตั้งแต่ต้นปีถึงงวด (ไม่นับในฐาน)<br>
    อัตราใช้ประโยชน์ = วิ่งงาน ÷ (วิ่งงาน + พร้อมใช้งานไม่มีงานวิ่ง) · วันหมดภาษีที่อยู่ก่อนวันที่อ้างอิง ${'<span class="pill p-info">สีฟ้า</span>'} = ต่อภาษีแล้ว รอฝ่ายประกันอัปเดต ไม่ใช่ภาษีขาด
    <div style="margin-top:10px" class="small">คีย์ลัด: <kbd>/</kbd> ไปช่องค้นหา <kbd>↓</kbd> <kbd>↑</kbd> เลื่อนในผลลัพธ์ <kbd>Enter</kbd> เปิดรายละเอียด <kbd>Esc</kbd> ปิด/ล้าง</div>
  </div>`;
}
const SEARCH_COLS = [
  ['ทะเบียน', r => r.plateF, r => `<b>${esc(r.plateF)}</b><div class="faint small">${esc(r.assetS4 || '')}</div>`],
  ['ประเภทรถ', r => r.vtype], ['Location', r => r.loc],
  ['ชั้นการใช้งาน', r => TIER[r.tier].label, r => pill(r.tier)],
  ['ภาษี', r => r.taxGroup === 'ภาษีปกติ' ? fmtD(r.taxDate) : r.taxGroup, taxPill],
  ['Leasing', r => r.leased ? r.leaseKind : 'ปลอดภาระ', leasePill],
  ['สัญญางาน', r => r.contract || '-'],
];
function renderResults(){
  const rows = filtered();
  S.lastFiltered = rows;
  EXPORTS.searchList = () => ({name: 'ผลการค้นหา', rows: exportRowsFull(rows)});
  const el = $('#results'); if (!el) return;
  const shown = rows.slice(0, S.shown);
  if (S.selIdx >= shown.length) S.selIdx = shown.length - 1;
  el.innerHTML = `<h2 class="sec">${S.card === 'fav' ? 'รายการโปรด' : 'ผลลัพธ์'} <span class="muted small">${fmtN(rows.length)} คัน</span><span class="spacer"></span>
    ${S.fField ? `<span class="pill p-info">${esc(S.fField.label)}</span>` : ''}${(S.q || S.fLoc || S.fType || S.fTax || S.fTier !== 'all' || S.fLeased || S.card || S.fField) ? '<button class="btn sm" data-act="clear">ล้างตัวกรอง</button>' : ''}${exportBtn('searchList')}</h2>
  ${rows.length ? `<div class="tblwrap"><table><thead><tr><th style="width:30px"></th>${SEARCH_COLS.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>
  ${shown.map((r, i) => `<tr class="click ${i === S.selIdx ? 'sel' : ''}" data-open="${esc(recKey(r))}" data-i="${i}">
    <td><button class="star ${S.favs.has(recKey(r)) ? 'on' : ''}" data-fav="${esc(recKey(r))}" title="รายการโปรด">${S.favs.has(recKey(r)) ? '★' : '☆'}</button></td>
    ${SEARCH_COLS.map(c => `<td>${c[2] ? c[2](r) : esc(c[1](r))}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>
  ${rows.length > S.shown ? `<p style="text-align:center"><button class="btn" data-act="more">แสดงเพิ่ม (${fmtN(rows.length - S.shown)} คัน)</button></p>` : ''}`
  : `<div class="note">${S.card === 'fav' ? 'ยังไม่มีรายการโปรด กดรูปดาวที่รายการหรือในหน้ารายละเอียดเพื่อเก็บรถที่ดูบ่อยไว้ที่นี่' : 'ไม่พบรถตามเงื่อนไข ลองลดตัวกรองหรือเปลี่ยนคำค้น'}</div>`}`;
}
function bindSearch(){
  const q = $('#q');
  q.addEventListener('input', () => { S.q = q.value; S.shown = 100; S.selIdx = -1; renderResults(); });
  ['fLoc', 'fType', 'fTax'].forEach(id => $('#' + id).addEventListener('change', e => { S[id] = e.target.value; S.shown = 100; renderResults(); }));
  $('#fLeased').addEventListener('change', e => { S.fLeased = e.target.checked; renderResults(); });
  renderResults();
}

/* ===== สถานะวิ่งงาน ===== */
function monthlyChart(series){
  const W = 760, H = 240, pl = 40, pb = 26, pt = 24, n = series.length;
  const max = Math.max(...series.map(s => s.base), 1);
  const bw = Math.min(46, (W - pl - 10) / n * .62), step = (W - pl - 10) / n;
  const y = v => pt + (H - pt - pb) * (1 - v / max);
  const ticks = [0, .25, .5, .75, 1].map(f => Math.round(max * f));
  let g = ticks.map(t => `<line x1="${pl}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-dasharray="${t ? '3 4' : ''}"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  series.forEach((s, i) => {
    const x = pl + i * step + (step - bw) / 2; let acc = 0;
    TIER_KEYS.forEach(t => { const h = (H - pt - pb) * s[t] / max; acc += s[t];
      g += `<rect x="${x}" y="${y(acc)}" width="${bw}" height="${Math.max(h - 1, 0)}" fill="${TIER[t].color}" rx="2"><title>${TH_MON[s.m - 1]} · ${TIER[t].label} ${s[t]} คัน</title></rect>`; });
    g += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${TH_MON[s.m - 1]}</text>`;
    g += `<text x="${x + bw / 2}" y="${y(s.base) - 4}" text-anchor="middle" style="fill:var(--text);font-weight:600">${s.util == null ? '' : Math.round(s.util * 100) + '%'}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="โครงสร้างกองรถรายเดือน">${g}</svg>`;
}
function viewRun(){
  const p = S.cur, c = count(S.rows), base = baseRows();
  const series = monthlySeries(p);
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const leased = base.filter(r => r.leased).length;
  const soldNow = S.rows.filter(r => r.soldMonth === p.month).length;
  const kpi = (cls, l, v, d) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d || '&nbsp;'}</div></div>`;
  EXPORTS.monthly = () => ({name: 'โครงสร้างกองรถรายเดือน', rows: [['เดือน', 'วิ่งงาน', 'พร้อมใช้งาน ไม่มีงานวิ่ง', 'ไม่พร้อมใช้งาน', 'ฐานคงเหลือ', 'อัตราใช้ประโยชน์', 'ขายแล้วสะสม', 'รวมทั้งไฟล์', 'ที่มา'],
    ...series.map(s => [periodLabel(p.year, s.m), s.run, s.idle, s.down, s.base, s.util == null ? '' : +s.util.toFixed(4), s.sold, s.total, s.src === 'snap' ? 'งวดที่นำเข้าไว้' : s.src === 'cur' ? 'งวดปัจจุบัน' : 'คำนวณจากงวดปัจจุบัน'])]});
  return `
  <div class="kpis">
    ${kpi('acc', 'ฐานรถคงเหลือ', fmtN(c.base), prev ? 'เทียบเดือนก่อน ' + deltaTxt(c.base, prev.base) : '')}
    ${kpi('run', 'วิ่งงาน', fmtN(c.run), prev ? deltaTxt(c.run, prev.run) : '')}
    ${kpi('idle', 'พร้อมใช้งาน ไม่มีงานวิ่ง', fmtN(c.idle), prev ? deltaTxt(c.idle, prev.idle, true) : '')}
    ${kpi('info', 'อัตราใช้ประโยชน์', fmtP(c.run, c.run + c.idle), `<span title="วิ่งงาน ÷ (วิ่งงาน + พร้อมใช้งานไม่มีงานวิ่ง)">${fmtN(c.run)} ÷ ${fmtN(c.run + c.idle)} คัน (ฐานคำนวณ)</span>` + (prev && prev.util != null ? '<br>เดือนก่อน ' + (prev.util * 100).toFixed(1) + '%' : ''))}
    ${kpi('down', 'ไม่พร้อมใช้งาน', fmtN(c.down), prev ? deltaTxt(c.down, prev.down, true) : '')}
    ${kpi('sold', 'ขายแล้วสะสม (นอกฐาน)', fmtN(c.sold), soldNow ? 'ขายในงวดนี้ ' + soldNow + ' คัน' : 'ไม่มีขายในงวดนี้')}
  </div>
  <div class="muted small" style="margin-top:8px">ติดภาระ Leasing ${fmtN(leased)} คัน (${fmtP(leased, c.base)} ของฐาน) · อัตราใช้ประโยชน์ = วิ่งงาน ÷ (วิ่งงาน + พร้อมใช้งานไม่มีงานวิ่ง)</div>

  <h2 class="sec">โครงสร้างกองรถรายเดือน ปี ${p.year}<span class="spacer"></span>${exportBtn('monthly')}</h2>
  <div class="chart"><div class="legend">${TIER_KEYS.map(t => `<span><i style="background:${TIER[t].color}"></i>${TIER[t].label}</span>`).join('')}<span>ตัวเลขบนแท่ง = อัตราใช้ประโยชน์</span></div>${monthlyChart(series)}</div>
  <div class="tblwrap" style="margin-top:10px"><table><thead><tr><th>เดือน</th>${series.map(s => `<th class="n">${TH_MON[s.m - 1]}</th>`).join('')}</tr></thead><tbody>
    ${TIER_KEYS.map(t => `<tr><td>${pill(t)}</td>${series.map(s => `<td class="n">${fmtN(s[t])}</td>`).join('')}</tr>`).join('')}
    <tr><td><b>ฐานคงเหลือ</b></td>${series.map(s => `<td class="n"><b>${fmtN(s.base)}</b></td>`).join('')}</tr>
    <tr><td>อัตราใช้ประโยชน์</td>${series.map(s => `<td class="n">${s.util == null ? '–' : (s.util * 100).toFixed(1) + '%'}</td>`).join('')}</tr>
    <tr class="sub"><td>บวก ขายแล้วสะสม (นอกฐาน)</td>${series.map(s => `<td class="n">${fmtN(s.sold)}</td>`).join('')}</tr>
    <tr class="sub"><td>รวมรถทั้งหมดในไฟล์</td>${series.map(s => `<td class="n">${fmtN(s.total)}</td>`).join('')}</tr>
    <tr class="sub"><td>ที่มา</td>${series.map(s => `<td class="n" title="${s.src === 'snap' ? 'ใช้ตัวเลขจากงวดที่นำเข้าไว้ (ตรึงค่าที่เคยรายงาน)' : 'คำนวณจากข้อมูลงวดที่เลือก'}">${s.src === 'snap' ? '● งวดเดิม' : s.src === 'cur' ? '◆ งวดนี้' : '○ คำนวณ'}</td>`).join('')}</tr>
  </tbody></table></div>
  <div class="muted small" style="margin-top:6px">● ใช้ตัวเลขของงวดที่เคยนำเข้า (ตัวเลขที่รายงานไปแล้วจะไม่เปลี่ยนตามสถานะภาษีล่าสุด) · ○ ไม่มีงวดนั้นในระบบ คำนวณย้อนจากข้อมูลงวดนี้</div>

  ${tierTable('byType', 'แยกตามประเภทรถ', groupBy(S.rows, r => r.vtype), 'ประเภทรถ')}
  ${tierTable('byLoc', 'แยกตาม Location', groupBy(S.rows, r => r.loc), 'Location')}
  ${tierTable('byUsage', 'แยกตามการใช้งาน', groupBy(S.rows, r => r.usage || '(ไม่ระบุ)'), 'การใช้งาน')}
  ${soldFoot(c.base)}
  ${listTable('soldList', 'รถที่ขายออกไปแล้ว (สะสมตั้งแต่ต้นปี)', S.rows.filter(r => r.tier === 'sold'),
    [['ทะเบียน', r => r.plateF], ['ประเภทรถ', r => r.vtype], ['Location', r => r.loc], ['เดือนที่ขาย', r => TH_MON[r.soldMonth - 1] + ' ' + p.year], ['ขาย/ไม่ขาย', r => r.sale || '-'], ['ภาระผูกพัน', r => r.leased ? 'ติดภาระ (ต้องไถ่ถอนก่อนโอน)' : 'ปลอดภาระ'], ['หมายเหตุ', r => r.note || '-']], {h: 320})}`;
}

/* ===== สถานะภาษี ===== */
function viewTax(){
  const base = baseRows(), ref = refDateOf(S.cur);
  const groups = groupBy(base, r => r.taxGroup);
  const normal = base.filter(r => r.taxGroup === 'ภาษีปกติ');
  const soon = normal.filter(r => r.taxDays >= 0 && r.taxDays <= S.taxWindow).sort((a, b) => a.taxDays - b.taxDays);
  const past = normal.filter(r => r.taxDays < 0);
  const watch = S.rows.filter(r => r.watch);
  const kpi = (cls, l, v, d) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d || '&nbsp;'}</div></div>`;

  const glist = [...groups].map(([k, rs]) => ({k, n: rs.length, ...count(rs)})).sort((a, b) => b.n - a.n);
  EXPORTS.taxGroups = () => ({name: 'สรุปกลุ่มภาษี', rows: [['กลุ่มภาษี', 'จำนวน', 'สัดส่วน', 'วิ่งงาน', 'พร้อมใช้งาน ไม่มีงานวิ่ง', 'ไม่พร้อมใช้งาน'], ...glist.map(g => [g.k, g.n, +(g.n / base.length).toFixed(4), g.run, g.idle, g.down]), ['รวม', base.length, 1, ...TIER_KEYS.map(t => base.filter(r => r.tier === t).length)]]});
  const byDue = groupBy(normal.slice().sort((a, b) => a.taxDate.localeCompare(b.taxDate)), r => r.taxDate.slice(0, 7));
  const dlist = [...byDue].map(([k, rs]) => ({k, label: monYear(k + '-01'), n: rs.length, run: rs.filter(r => r.tier === 'run').length, idle: rs.filter(r => r.tier === 'idle').length, watch: rs.filter(r => r.watch).length, days: daysBetween(lastDayISO(+k.slice(0, 4), +k.slice(5, 7)), ref)}));
  EXPORTS.taxDue = () => ({name: 'รอบครบกำหนดภาษี', rows: [['เดือนครบกำหนด', 'จำนวน', 'วิ่งงาน', 'พร้อมใช้งาน ไม่มีงานวิ่ง', 'ในนั้นเป็นรถระงับใช้งาน'], ...dlist.map(d => [d.label, d.n, d.run, d.idle, d.watch])]});
  const TAX_COLS = [['ทะเบียน', r => r.plateF], ['ประเภทรถ', r => r.vtype], ['Location', r => r.loc], ['ชั้นการใช้งาน', r => TIER[r.tier].label, r => pill(r.tier)],
    ['วันครบกำหนด', r => fmtD(r.taxDate)], ['อีก (วัน)', r => r.taxDays], ['การใช้งาน', r => r.usage || '-'], ['ประกันภัย', r => r.insurance || '-']];
  return `
  <div class="row" style="justify-content:space-between">
    <div class="muted small">วันที่อ้างอิง <b style="color:var(--text)">${fmtD(ref)}</b> (แก้ได้ที่แท็บ นำเข้า/ส่งออก) · ฐาน = รถคงเหลือ ไม่รวมขายแล้ว</div>
    <label class="chk small">ช่วงเตือนล่วงหน้า <select id="taxWin">${[30, 60, 90, 120, 180, 365].map(d => `<option value="${d}" ${d === S.taxWindow ? 'selected' : ''}>${d} วัน</option>`).join('')}</select></label>
  </div>
  <div class="kpis" style="margin-top:12px">
    ${kpi('run', 'ภาษีปกติ', fmtN(normal.length), fmtP(normal.length, base.length) + ' ของฐาน')}
    ${kpi('idle', `ครบกำหนดใน ${S.taxWindow} วัน`, fmtN(soon.length), soon[0] ? 'เร็วสุด ' + fmtD(soon[0].taxDate) : '')}
    ${kpi('info', 'เลยวันอ้างอิง (รออัปเดต)', fmtN(past.length), 'ต่อแล้ว รอฝ่ายประกันแก้วันที่')}
    ${kpi('down', 'แจ้งหยุดใช้รถ (ม.89/79)', fmtN(base.filter(r => /ม\.\d/.test(r.taxGroup)).length), '')}
    ${kpi('down', 'ไม่มีทะเบียน / ระงับทะเบียน', fmtN(base.filter(r => /ไม่มีทะเบียน|ระงับทะเบียน/.test(r.taxGroup)).length), '')}
    ${kpi('acc', 'ระงับใช้งาน ภาษียังปกติ', fmtN(watch.length), 'รายการเฝ้าดู')}
  </div>
  <div class="grid2">
    <div><h2 class="sec">สรุปกลุ่มภาษี<span class="spacer"></span>${exportBtn('taxGroups')}</h2>
    <div class="tblwrap"><table><thead><tr><th>กลุ่มภาษี</th><th class="n">จำนวน</th><th class="n">สัดส่วน</th><th class="n">วิ่งงาน</th><th class="n">พร้อมใช้</th><th class="n">ไม่พร้อมใช้</th></tr></thead><tbody>
    ${glist.map(g => `<tr class="click" data-drill="taxGroup" data-k="${esc(g.k)}"><td>${esc(g.k)}</td><td class="n">${fmtN(g.n)}</td><td class="n">${fmtP(g.n, base.length)}</td><td class="n">${fmtN(g.run)}</td><td class="n">${fmtN(g.idle)}</td><td class="n">${fmtN(g.down)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td>รวม</td><td class="n">${fmtN(base.length)}</td><td class="n">100%</td>${TIER_KEYS.map(t => `<td class="n">${fmtN(base.filter(r => r.tier === t).length)}</td>`).join('')}</tr></tfoot></table></div>
    ${soldFoot(base.length)}</div>
    <div><h2 class="sec">รอบครบกำหนดภาษี (เฉพาะภาษีปกติ)<span class="spacer"></span>${exportBtn('taxDue')}</h2>
    <div class="tblwrap"><table><thead><tr><th>เดือนครบกำหนด</th><th class="n">จำนวน</th><th class="n">วิ่งงาน</th><th class="n">พร้อมใช้</th><th class="n">ระงับใช้งาน</th></tr></thead><tbody>
    ${dlist.map(d => `<tr class="click" data-drill="taxMonth" data-k="${d.k}"><td>${d.label} ${d.days < 0 ? '<span class="pill p-info">รออัปเดต</span>' : d.days <= S.taxWindow ? '<span class="pill p-idle">ใกล้ครบ</span>' : ''}</td><td class="n">${fmtN(d.n)}</td><td class="n">${fmtN(d.run)}</td><td class="n">${fmtN(d.idle)}</td><td class="n">${d.watch ? fmtN(d.watch) : '–'}</td></tr>`).join('')}
    </tbody><tfoot><tr><td>รวม</td><td class="n">${fmtN(normal.length)}</td><td class="n">${fmtN(normal.filter(r => r.tier === 'run').length)}</td><td class="n">${fmtN(normal.filter(r => r.tier === 'idle').length)}</td><td class="n">${fmtN(normal.filter(r => r.watch).length)}</td></tr></tfoot></table></div></div>
  </div>
  ${listTable('taxSoon', `ภาษีครบกำหนดภายใน ${S.taxWindow} วัน`, soon, TAX_COLS)}
  ${past.length ? listTable('taxPast', 'วันหมดภาษีอยู่ก่อนวันที่อ้างอิง', past, TAX_COLS, {note: 'ตามข้อตกลง: ต่อภาษีแล้ว รอฝ่ายประกันอัปเดตวันที่ ไม่ใช่ภาษีขาด ควรตามให้อัปเดตในไฟล์ต้นทาง'}) : ''}
  ${listTable('watch', 'รายการเฝ้าดู: รถระงับใช้งานที่ภาษียังปกติ', watch.sort((a, b) => a.taxDate.localeCompare(b.taxDate)), TAX_COLS,
    {note: 'แนวปฏิบัติที่ตกลงไว้: ปล่อยให้ภาษีหมดอายุตามรอบ ไม่ต่อภาษีเพิ่ม และคงทะเบียนไว้เผื่อนำรถกลับมาใช้'})}`;
}

/* ===== Leasing ===== */
function viewLease(){
  const base = baseRows(), L = base.filter(r => r.leased), F = base.filter(r => !r.leased);
  const cl = count(L), cf = count(F), y = String(S.cur.year);
  const dueThisYear = L.filter(r => r.leaseDue === y).length;
  const kpi = (cls, l, v, d) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d || '&nbsp;'}</div></div>`;
  const soldLeased = S.rows.filter(r => r.tier === 'sold' && r.leased).length;
  const byDue = groupBy(L, r => r.leaseDue);
  const dueList = [...byDue].map(([k, rs]) => ({k, n: rs.length, ...count(rs)})).sort((a, b) => String(a.k).localeCompare(String(b.k)));
  EXPORTS.leaseDue = () => ({name: 'ปีครบกำหนดภาระ', rows: [['ปีครบกำหนด', 'จำนวน', 'วิ่งงาน', 'พร้อมใช้งาน ไม่มีงานวิ่ง', 'ไม่พร้อมใช้งาน'], ...dueList.map(d => [d.k, d.n, d.run, d.idle, d.down])]});
  const LCOLS = [['ทะเบียน', r => r.plateF], ['ประเภทรถ', r => r.vtype], ['Location', r => r.loc], ['ชั้นการใช้งาน', r => TIER[r.tier].label, r => pill(r.tier)],
    ['ประเภทภาระ', r => r.leaseKind], ['ผู้ให้สินเชื่อ', r => r.lessorName || r.lessorCode || '-'], ['เลขที่สัญญา', r => r.agreementNo || '-'],
    ['วันเริ่ม', r => fmtD(r.leaseStart)], ['Notice date', r => fmtD(r.noticeDate)], ['ครบกำหนดภาระ', r => r.leaseDue]];
  return `
  <div class="kpis">
    ${kpi('info', 'ติดภาระ', fmtN(L.length), fmtP(L.length, base.length) + ' ของฐาน')}
    ${kpi('run', 'ปลอดภาระ', fmtN(F.length), '')}
    ${kpi('acc', 'อัตราใช้ประโยชน์ รถติดภาระ', fmtP(cl.run, cl.run + cl.idle), 'วิ่ง ' + cl.run + ' / ' + (cl.run + cl.idle))}
    ${kpi('acc', 'อัตราใช้ประโยชน์ รถปลอดภาระ', fmtP(cf.run, cf.run + cf.idle), 'วิ่ง ' + cf.run + ' / ' + (cf.run + cf.idle))}
    ${kpi('idle', 'ครบกำหนดภาระในปี ' + y, fmtN(dueThisYear), 'ตาม Notice date')}
    ${kpi('down', 'ติดภาระ แต่ไม่วิ่งงาน', fmtN(cl.idle + cl.down), 'พร้อมใช้ ' + cl.idle + ' · ไม่พร้อม ' + cl.down)}
  </div>
  ${soldLeased ? `<div class="note">มีรถที่ขายแล้วแต่ยังติดภาระ ${soldLeased} คัน ต้องไถ่ถอนก่อนโอน</div>` : ''}
  ${tierTable('leaseFlag', 'ชั้นการใช้งานแยกตามภาระผูกพัน', groupBy(base, r => r.leased ? 'ติดภาระ' : 'ปลอดภาระ'), 'ภาระผูกพัน')}
  <div class="grid2">
    <div>${tierTable('leaseKind', 'แยกตามประเภทภาระ', groupBy(L, r => r.leaseKind), 'ประเภทภาระ')}</div>
    <div><h2 class="sec">ปีครบกำหนดภาระ<span class="spacer"></span>${exportBtn('leaseDue')}</h2>
    <div class="tblwrap"><table><thead><tr><th>ปีครบกำหนด</th><th class="n">จำนวน</th><th class="n">วิ่งงาน</th><th class="n">พร้อมใช้</th><th class="n">ไม่พร้อมใช้</th></tr></thead><tbody>
    ${dueList.map(d => `<tr class="click" data-drill="leaseDue" data-k="${esc(d.k)}"><td>${esc(d.k)} ${d.k === y ? '<span class="pill p-idle">ปีนี้</span>' : ''}</td><td class="n">${fmtN(d.n)}</td><td class="n">${fmtN(d.run)}</td><td class="n">${fmtN(d.idle)}</td><td class="n">${fmtN(d.down)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td>รวม</td><td class="n">${fmtN(L.length)}</td><td class="n">${fmtN(cl.run)}</td><td class="n">${fmtN(cl.idle)}</td><td class="n">${fmtN(cl.down)}</td></tr></tfoot></table></div>
    <div class="muted small" style="margin-top:6px">Loan Agreement ที่ไม่มี Notice date = รถค้ำประกันวงเงิน ไม่ระบุวันหมดภาระ</div></div>
  </div>
  ${tierTable('lessor', 'แยกตามผู้ให้สินเชื่อ', groupBy(L, r => r.lessorName || r.lessorCode || '(ไม่ระบุ)'), 'ผู้ให้สินเชื่อ')}
  ${listTable('leaseList', 'รายการรถติดภาระรายคัน', L.slice().sort((a, b) => String(a.leaseDue).localeCompare(String(b.leaseDue)) || a.loc.localeCompare(b.loc, 'th')), LCOLS)}`;
}

/* ===== นำเข้า/ส่งออก ===== */
function viewIO(){
  const p = S.cur;
  const list = S.periods.slice().reverse();
  let diffHtml = '';
  if (p){
    const pv = prevPeriod(p);
    if (pv){
      const d = diffPeriods(pv, p);
      const cnt = f => d.changes.filter(c => c.field === f).length;
      EXPORTS.diff = () => ({name: 'เปลี่ยนแปลงจากงวดก่อน', rows: [['ประเภท', 'ทะเบียน', 'รหัสสินทรัพย์', 'หัวข้อ', 'งวดก่อน (' + pv.label + ')', 'งวดนี้ (' + p.label + ')'],
        ...d.added.map(r => ['เพิ่มใหม่', r.plateF, r.assetS4, '', '', '']), ...d.removed.map(r => ['หายไป', r.plateF, r.assetS4, '', '', '']),
        ...d.changes.map(c => ['เปลี่ยนแปลง', c.r.plateF, c.r.assetS4, c.field, c.from, c.to])]});
      diffHtml = `<h2 class="sec">เปลี่ยนแปลงจากงวดก่อน (${pv.label} → ${p.label})<span class="spacer"></span>${exportBtn('diff')}</h2>
      <div class="diffbox">${[['รถเพิ่มใหม่', d.added.length], ['รถหายไปจากไฟล์', d.removed.length], ['เปลี่ยนชั้นการใช้งาน', cnt('ชั้นการใช้งาน')], ['เปลี่ยนสถานะภาษี', cnt('สถานะภาษี')],
        ['เปลี่ยน Location', cnt('Location')], ['เปลี่ยน WBS', cnt('WBS')], ['เปลี่ยนการใช้งาน', cnt('การใช้งาน')], ['เปลี่ยนภาระผูกพัน', cnt('ภาระผูกพัน')]]
        .map(([l, n]) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:20px">${fmtN(n)}</div></div>`).join('')}</div>
      ${d.changes.length || d.added.length || d.removed.length ? `<div class="tblwrap" style="max-height:340px"><table><thead><tr><th>ทะเบียน</th><th>หัวข้อ</th><th>งวดก่อน</th><th>งวดนี้</th></tr></thead><tbody>
        ${d.added.map(r => `<tr class="click" data-open="${esc(recKey(r))}"><td>${esc(r.plateF)}</td><td><span class="pill p-run">เพิ่มใหม่</span></td><td>–</td><td>${esc(r.vtype)} · ${esc(r.loc)}</td></tr>`).join('')}
        ${d.removed.map(r => `<tr><td>${esc(r.plateF)}</td><td><span class="pill p-down">หายไป</span></td><td>${esc(r.vtype)} · ${esc(r.loc)}</td><td>–</td></tr>`).join('')}
        ${d.changes.slice(0, 400).map(c => `<tr class="click" data-open="${esc(recKey(c.r))}"><td>${esc(c.r.plateF)}</td><td>${esc(c.field)}</td><td>${esc(c.from)}</td><td><b>${esc(c.to)}</b></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="note info">ไม่มีการเปลี่ยนแปลงจากงวดก่อน (ถือว่าปกติ บางงวดไม่มีการเปลี่ยนแปลง)</div>'}`;
    } else diffHtml = `<div class="note info" style="margin-top:20px">ยังไม่มีงวดก่อนหน้าของ ${esc(p.company)} ในระบบ นำเข้างวดก่อนเพื่อดูการเปลี่ยนแปลงเดือนต่อเดือน</div>`;
  }
  const locLines = Object.entries(S.locMap).map(([a, b]) => `${a} => ${b}`).join('\n');
  const rawLocs = p ? [...new Set(p.rows.map(r => r.locRaw).filter(Boolean))].sort() : [];
  const W = Store.canWrite;
  const acct = Store.mode !== 'sb' ? '' : W ? `
  <h2 class="sec">บัญชีผู้ดูแล</h2>
  <div class="grid2"><div class="note info">เข้าสู่ระบบเป็น <b>${esc(Store.adminEmail)}</b><div class="row" style="margin-top:8px"><button class="btn sm" data-act="logout">ออกจากระบบ</button></div></div>
  <div><form id="setPwForm" class="row" style="flex-wrap:nowrap"><input type="password" id="newViewerPw" autocomplete="new-password" placeholder="รหัสผ่านใหม่สำหรับผู้ดู (อย่างน้อย 8 ตัว)" aria-label="รหัสผ่านใหม่สำหรับผู้ดู" style="flex:1"><button class="btn pri" type="submit">ตั้งรหัสผ่าน</button></form>
  <div class="muted small" style="margin-top:6px">รหัสผ่านกลางที่แจกให้ทีมเพื่อดูข้อมูล เปลี่ยนเมื่อไหร่ ทุกคนต้องใส่รหัสใหม่</div></div></div>`
    : `<h2 class="sec">การเข้าถึง</h2><div class="row"><button class="btn sm" data-act="forgetPw">ลืมรหัสผ่านที่จำไว้ในเครื่องนี้</button><button class="btn sm" data-act="adminLogin">เข้าสู่ระบบผู้ดูแล</button></div>`;
  const where = Store.mode === 'sb' ? 'ข้อมูลเก็บในฐานข้อมูลกลาง ผู้ดูต้องใช้รหัสผ่านกลางจึงจะเห็นข้อมูล' : Store.mode === 'local' ? 'ข้อมูลเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น แนะนำสำรองเป็นไฟล์ทุกเดือน' : 'ข้อมูลเก็บในฐานข้อมูลกลาง ทุกคนที่ได้รับลิงก์เห็นข้อมูลชุดเดียวกันทันที';
  const importPanel = W ? `
      <h2 class="sec" style="margin-top:0">นำเข้าข้อมูลประจำเดือน</h2>
      <div class="drop" id="drop" data-act="pick"><h3>⭱ ลากไฟล์ Excel มาวาง หรือคลิกเพื่อเลือก</h3>
        <div class="muted small">รองรับ <b>00 SCC อัพเดต สถานะรถ MM.YYYY.xlsx</b> (ชีต สถานะการใช้งานรถ) และ <b>FleetStatus_SCC_YYYYMM.xlsx</b> (ชีต 1_Data)<br>ระบบอ่านคอลัมน์จากชื่อหัวตาราง และเดางวดจากชื่อไฟล์ ยืนยันได้ก่อนบันทึก</div></div>
      <div class="muted small" style="margin-top:8px">นำเข้างวดเดิมซ้ำ = แทนที่ข้อมูลงวดนั้น · ${where}</div>`
    : `<h2 class="sec" style="margin-top:0">ข้อมูลในระบบ</h2>
      <div class="note info">คุณดูข้อมูลและส่งออกเป็นไฟล์ได้ การนำเข้า แก้ไข และลบข้อมูลทำได้เฉพาะผู้ดูแลระบบ<br><span class="muted small">${where}</span></div>`;
  return `
  <div class="grid2">
    <div>${importPanel}</div>
    <div>
      <h2 class="sec" style="margin-top:0">ส่งออกข้อมูล</h2>
      <div class="row" style="flex-direction:column;align-items:stretch">
        <button class="btn pri" data-act="exportReport" ${p ? '' : 'disabled'}>⭳ รายงานงวด ${p ? p.label : ''} (Excel หลายชีต)</button>
        <button class="btn" data-act="exportRaw" ${p ? '' : 'disabled'}>⭳ ข้อมูลดิบรูปแบบไฟล์ต้นทาง (ใช้เป็นตั้งต้นเดือนถัดไป)</button>
        <button class="btn" data-act="exportCsv" ${p ? '' : 'disabled'}>⭳ รายการรถพร้อมคอลัมน์คำนวณ (CSV)</button>
        ${W ? `<div class="row"><button class="btn" data-act="backup" style="flex:1" ${list.length ? '' : 'disabled'}>⭳ สำรองทุกงวด (.json)</button><button class="btn" data-act="restore" style="flex:1">⭱ กู้คืนจากไฟล์สำรอง</button></div>` : ''}
      </div>
    </div>
  </div>

  <h2 class="sec">งวดในระบบ <span class="muted small">${list.length} งวด</span></h2>
  ${list.length ? `<div class="tblwrap"><table><thead><tr><th>บริษัท</th><th>งวด</th><th class="n">จำนวนรถ</th><th class="n">วิ่งงาน</th><th class="n">อัตราใช้ประโยชน์</th><th>ไฟล์ต้นทาง</th><th>Last Updated</th><th>วันที่อ้างอิง</th><th></th></tr></thead><tbody>
  ${list.map(x => { const c = x.rows ? count(computePeriod(x)) : (x.stats || {run: 0, idle: 0}); const n = x.rows ? x.rows.length : (x.rowCount || 0); return `<tr class="${p && x.key === p.key ? 'sel' : ''}"><td>${esc(x.company)}</td><td><b>${x.label}</b></td><td class="n">${fmtN(n)}</td><td class="n">${fmtN(c.run)}</td><td class="n">${fmtP(c.run, c.run + c.idle)}</td>
    <td class="small">${esc(x.fileName)}<div class="faint">ชีต ${esc(x.sheet)}</div></td><td class="small">${fmtDT(x.importedAt)}</td>
    <td>${W ? `<input type="date" value="${refDateOf(x)}" data-ref="${esc(x.key)}" aria-label="วันที่อ้างอิง ${x.label}" style="padding:4px 6px">` : fmtD(refDateOf(x))}</td>
    <td><button class="btn sm" data-goto="${esc(x.key)}">เปิด</button>${W ? ` <button class="btn sm danger" data-del="${esc(x.key)}">ลบ</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>` : `<div class="note">${W ? 'ยังไม่มีงวดในระบบ นำเข้าไฟล์ Excel ด้านบนเพื่อเริ่มต้น' : 'ผู้ดูแลยังไม่ได้นำเข้าข้อมูล'}</div>`}
  ${diffHtml}
  ${acct}

  <h2 class="sec">ตารางเทียบชื่อ Location</h2>
  <div class="grid2">
    <div><textarea id="locMap" rows="7" ${W ? '' : 'readonly'} style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:13px">${esc(locLines)}</textarea>
    ${W ? `<div class="row" style="margin-top:6px"><button class="btn sm pri" data-act="saveLoc">บันทึก</button><button class="btn sm" data-act="resetLoc">คืนค่าเริ่มต้น</button>
    <span class="muted small">รูปแบบ: ชื่อในไฟล์ต้นทาง => ชื่อที่ใช้แสดง (บรรทัดละคู่)</span></div>` : ''}</div>
    <div class="muted small">ชื่อที่เปลี่ยนถือเป็นสถานที่เดียวกัน รวมเป็นแถวเดียวในทุกตาราง${rawLocs.length ? `<br><br>Location ในงวดนี้: ${rawLocs.map(l => `<span class="pill p-sold" style="margin:2px">${esc(l)}</span>`).join(' ')}` : ''}</div>
  </div>`;
}

/* ---------- export ---------- */
function exportRowsFull(rows){
  const head = ['ทะเบียนรถ', 'รหัสสินทรัพย์ (SAP)', 'รหัสสินทรัพย์ (Mac5)', 'รายการ', 'ประเภทรถ', 'Location', 'Location (ในไฟล์ต้นทาง)', 'WBS', 'Cost Center', 'การใช้งาน', 'ขาย/ไม่ขาย',
    'สถานะงวดรายงาน', 'ชั้นการใช้งาน', 'เดือนวิ่งงานสะสม', 'เดือนที่ขาย', 'สถานะภาษี', 'กลุ่มภาษี', 'วันครบกำหนดภาษี', 'วันคงเหลือถึงครบกำหนด', 'ประกันภัย',
    'ภาระผูกพัน', 'ประเภทภาระ', 'ผู้ให้สินเชื่อ', 'เลขที่สัญญา', 'วันเริ่มสัญญา', 'Notice date', 'ครบกำหนดภาระ', 'สัญญางาน', 'หมายเหตุ'];
  return [head, ...rows.map(r => [r.plateF, r.assetS4, r.assetECC, r.desc, r.vtype, r.loc, r.locRaw, r.wbs, r.costCenter ?? '', r.usage, r.sale,
    r.cur || '', TIER[r.tier].label, r.runMonths, r.soldMonth ? TH_MON[r.soldMonth - 1] : '-', r.taxGroup === 'ภาษีปกติ' ? 'ครบกำหนด ' + monYear(r.taxDate) : r.taxGroup,
    r.taxGroup, fmtD(r.taxDate), r.taxDays ?? '', r.insurance, r.leased ? 'ติดภาระ' : 'ปลอดภาระ', r.leaseKind, r.lessorName || '-', r.agreementNo || '',
    fmtD(r.leaseStart), fmtD(r.noticeDate), r.leaseDue, r.contract, r.note])];
}
function sheetFrom(aoa){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const w = aoa[0].map((_, i) => ({wch: Math.min(48, Math.max(8, ...aoa.slice(0, 200).map(r => String(r[i] ?? '').length + 2)))}));
  ws['!cols'] = w;
  if (aoa.length > 1) ws['!autofilter'] = {ref: XLSX.utils.encode_range({s: {r: 0, c: 0}, e: {r: aoa.length - 1, c: aoa[0].length - 1}})};
  return ws;
}
const safeSheet = n => n.replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31);
function download(wb, name){ return saveFile(name, new Blob([XLSX.write(wb, {type: 'array', bookType: 'xlsx', compression: true})])); }
function exportOne(id){
  const f = EXPORTS[id]; if (!f) return;
  const {name, rows} = f();
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheetFrom(rows), safeSheet(name));
  download(wb, `${name}_${S.cur.company}_${S.cur.year}${pad2(S.cur.month)}.xlsx`);
}
const SHEET_NAMES = {
  monthly: 'รายเดือน', byType: 'ประเภทรถ', byLoc: 'Location', byUsage: 'การใช้งาน', soldList: 'ขายแล้ว',
  taxGroups: 'ภาษี_สรุป', taxDue: 'ภาษี_รอบครบกำหนด', taxSoon: 'ภาษี_ใกล้ครบกำหนด', watch: 'ภาษี_Watchlist',
  leaseFlag: 'Leasing_สรุป', leaseKind: 'Leasing_ประเภทภาระ', leaseDue: 'Leasing_ปีครบกำหนด', lessor: 'Leasing_ผู้ให้สินเชื่อ',
  leaseList: 'Leasing_รายคัน', diff: 'เปลี่ยนแปลงจากงวดก่อน',
};
function exportReport(){
  const p = S.cur; const keep = S.tab;
  // สร้าง EXPORTS ของทุกแท็บโดยเรนเดอร์ลงสตริงทิ้ง
  const sheets = [];
  const c = count(S.rows);
  sheets.push(['สรุป', [['รายงานสถานะการใช้งานรถ', p.company], ['งวดรายงาน', p.label], ['วันที่อ้างอิง', fmtD(refDateOf(p))], ['ไฟล์ต้นทาง', p.fileName], [],
    ['ฐานรถคงเหลือ', c.base], ['วิ่งงาน', c.run], ['พร้อมใช้งาน ไม่มีงานวิ่ง', c.idle], ['ไม่พร้อมใช้งาน', c.down], ['อัตราใช้ประโยชน์', c.util == null ? '' : +c.util.toFixed(4)],
    ['ขายแล้วสะสม (นอกฐาน)', c.sold], ['รวมรถทั้งหมดในไฟล์', c.total], ['ตรวจดุล ฐาน + ขายแล้ว = ทั้งไฟล์', c.base + c.sold === S.rows.length ? 'ผ่าน' : 'ไม่ผ่าน'], [],
    ['หมายเหตุ', 'อัตราใช้ประโยชน์ = วิ่งงาน ÷ (วิ่งงาน + พร้อมใช้งานไม่มีงานวิ่ง)']]]);
  const order = [['run', ['monthly', 'byType', 'byLoc', 'byUsage', 'soldList']], ['tax', ['taxGroups', 'taxDue', 'taxSoon', 'watch']], ['lease', ['leaseFlag', 'leaseKind', 'leaseDue', 'lessor', 'leaseList']], ['io', ['diff']]];
  for (const [tab, ids] of order){
    for (const k in EXPORTS) delete EXPORTS[k];
    S.tab = tab; ({run: viewRun, tax: viewTax, lease: viewLease, io: viewIO})[tab]();
    ids.forEach(id => { if (EXPORTS[id]){ const {name, rows} = EXPORTS[id](); sheets.push([SHEET_NAMES[id] || name, rows]); } });
  }
  sheets.push(['รายการรถทั้งกอง', exportRowsFull(S.rows)]);
  S.tab = keep;
  const wb = XLSX.utils.book_new();
  sheets.forEach(([n, rows]) => XLSX.utils.book_append_sheet(wb, sheetFrom(rows), safeSheet(n)));
  download(wb, `FleetStatus_${p.company}_${p.year}${pad2(p.month)}.xlsx`);
  render();
}
function exportRaw(){
  const p = S.cur;
  const fs = FIELDS.map(f => f[0]);
  const insertAt = fs.indexOf('contract');   // เดือน 01–12 อยู่ก่อน สัญญางาน ตามไฟล์ต้นทาง
  const head = fs.map(f => f === 'wbs' ? `WBS ${p.label}` : FIELD_LABEL[f]);
  head.splice(insertAt, 0, ...Array.from({length: 12}, (_, i) => `วิ่งงาน/ไม่วิ่งงาน ${pad2(i + 1)}.${p.year}`));
  const rows = p.rows.map(r => {
    const a = fs.map(f => { const v = r[f]; return DATE_FIELDS.has(f) || (f === 'taxRaw' && /^\d{4}-\d{2}-\d{2}$/.test(v || '')) ? (v ? new Date(v + 'T00:00:00Z') : null) : v; });
    a.splice(insertAt, 0, ...r.months);
    return a;
  });
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows], {cellDates: true, dateNF: 'dd/mm/yyyy'});
  ws['!cols'] = head.map(h => ({wch: Math.max(10, Math.min(30, h.length + 2))}));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'สถานะการใช้งานรถ');
  download(wb, `00 ${p.company} อัพเดต สถานะรถ ${p.label} (ส่งออกจากระบบ).xlsx`);
}
function exportCsv(){
  const ws = XLSX.utils.aoa_to_sheet(exportRowsFull(S.rows));
  const csv = '﻿' + XLSX.utils.sheet_to_csv(ws);
  saveFile(`FleetList_${S.cur.company}_${S.cur.year}${pad2(S.cur.month)}.csv`, new Blob([csv]));
}
async function backup(){
  for (const p of S.periods) await Store.ensureRows(p);
  const periods = S.periods.map(({key, company, year, month, label, fileName, sheet, importedAt, rows}) => ({key, company, year, month, label, fileName, sheet, importedAt, rows}));
  const data = {app: 'fleet-status', version: 1, exportedAt: new Date().toISOString(), locMap: S.locMap, refOverride: S.refOverride, periods};
  saveFile(`fleet-status-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)]));
}

/* ---------- import flow ---------- */
async function handleFile(file){
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type: 'array', cellDates: false});
    const res = parseWorkbook(wb, file.name);
    confirmImport(res, file.name);
  } catch (e){ console.error(e); showModal(`<h2>นำเข้าไม่สำเร็จ</h2><p>${esc(e.message || e)}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-act="closeModal">ปิด</button></div>`); }
}
function confirmImport(res, fileName){
  const tmp = {rows: res.rows, month: res.month, year: res.year, key: 'tmp', company: res.company};
  const c = count(tmp.rows.map(r => computeRow(r, res.month, lastDayISO(res.year, res.month), S.locMap)));
  const exists = S.periods.find(p => p.key === keyOf(res.company, res.year, res.month));
  showModal(`<h2>ยืนยันการนำเข้า</h2>
  <p class="muted small">${esc(fileName)} · ชีต <b>${esc(res.sheet)}</b> · พบรถ <b>${fmtN(res.rows.length)}</b> คัน</p>
  <div class="row" style="margin:12px 0">
    <div class="ctl"><label>บริษัท</label><input type="text" id="impCo" value="${esc(res.company)}" style="width:110px"></div>
    <div class="ctl"><label>เดือน</label><select id="impM">${TH_MON.map((m, i) => `<option value="${i + 1}" ${i + 1 === res.month ? 'selected' : ''}>${pad2(i + 1)} · ${m}</option>`).join('')}</select></div>
    <div class="ctl"><label>ปี (ค.ศ.)</label><input type="number" id="impY" value="${res.year}" style="width:100px"></div>
  </div>
  <div class="diffbox">${[['วิ่งงาน', c.run], ['พร้อมใช้ ไม่มีงานวิ่ง', c.idle], ['ไม่พร้อมใช้งาน', c.down], ['ขายแล้วสะสม', c.sold]].map(([l, n]) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:20px">${fmtN(n)}</div></div>`).join('')}</div>
  <p class="muted small">ตัวเลขข้างบนคำนวณตามเดือนที่ระบบเดาได้ ถ้าเปลี่ยนเดือน ระบบจะคำนวณใหม่หลังบันทึก
  ${res.missing.length ? `<br>คอลัมน์ที่ไม่พบในไฟล์: ${res.missing.map(f => FIELD_LABEL[f]).join(', ')}` : ''}</p>
  ${exists ? `<div class="note">มีงวด ${exists.label} ของ ${esc(exists.company)} อยู่แล้ว การนำเข้าจะ<b>แทนที่</b>ข้อมูลเดิม</div>` : ''}
  <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">ยกเลิก</button><button class="btn pri" id="impOk">บันทึกงวดนี้</button></div>`);
  $('#impOk').onclick = async () => {
    const company = norm($('#impCo').value) || 'SCC', month = +$('#impM').value, year = +$('#impY').value;
    const p = {key: keyOf(company, year, month), company, year, month, label: periodLabel(year, month), fileName, sheet: res.sheet, importedAt: Date.now(), rows: res.rows};
    const btn = $('#impOk'); btn.disabled = true;
    try { await Store.put(p, (i, n) => { btn.textContent = `กำลังบันทึก ${i}/${n}…`; }); }
    catch (e){ btn.disabled = false; btn.textContent = 'บันทึกงวดนี้'; toast('บันทึกไม่สำเร็จ: ' + (e.code === 'quota_exceeded' ? 'พื้นที่ฐานข้อมูลเต็ม ลบงวดเก่าที่ไม่ใช้ก่อน' : (e.message || e.code)), 5000); return; }
    closeModal(); S.cur = null; await load(p.key);
    toast(`นำเข้างวด ${p.label} แล้ว (${fmtN(p.rows.length)} คัน)`);
  };
}

/* ---------- drawer ---------- */
function openDrawer(key){
  const r = S.rows.find(x => recKey(x) === key);
  if (!r) return;
  const p = S.cur;
  const hist = S.periods.filter(x => x.company === p.company).map(x => {
    const raw = x.rows.find(y => recKey(y) === key); if (!raw) return null;
    const c = computeRow(raw, x.month, refDateOf(x), S.locMap); return {x, c};
  }).filter(Boolean);
  const kv = pairs => `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v ?? '–'}</dd>`).join('')}</dl>`;
  const fav = S.favs.has(key);
  $('#drawer').innerHTML = `<div class="hd"><div style="flex:1"><div class="muted small">${esc(r.desc || '')}</div><h2 style="margin:2px 0 6px">${esc(r.plateF)}</h2>
    <div class="row">${pill(r.tier)} ${taxPill(r)} ${leasePill(r)}</div></div>
    <button class="star ${fav ? 'on' : ''}" data-fav="${esc(key)}" style="font-size:22px">${fav ? '★' : '☆'}</button><button class="iconbtn" data-act="closeDrawer" aria-label="ปิด">✕</button></div>
  <div class="bd">
    <h3>สถานะวิ่งงานรายเดือน ${p.year}</h3>
    <div class="months">${r.months.map((m, i) => `<div class="${m === 'วิ่งงาน' ? 'r' : m === 'ไม่วิ่งงาน' ? 'x' : /ขาย/.test(m || '') ? 's' : ''} ${i + 1 === p.month ? 'cur' : ''}" title="${esc(m || 'ไม่มีข้อมูล')}">${TH_MON[i]}<br>${m === 'วิ่งงาน' ? '●' : m === 'ไม่วิ่งงาน' ? '○' : /ขาย/.test(m || '') ? '✕' : '·'}</div>`).join('')}</div>
    <div class="muted small" style="margin-top:4px">วิ่งงานสะสม ${r.runMonths} จาก ${p.month} เดือน · ● วิ่งงาน ○ ไม่วิ่งงาน ✕ ขายแล้ว</div>
    <h3>ข้อมูลรถ</h3>
    ${kv([['ประเภทรถ', esc(r.vtype)], ['Location', esc(r.loc) + (r.loc !== r.locRaw ? ` <span class="faint small">(${esc(r.locRaw)})</span>` : '')], ['การใช้งาน', esc(r.usage)], ['ขาย/ไม่ขาย', esc(r.sale)],
      ['สัญญางาน', esc(r.contract)], ['WBS', `<code>${esc(r.wbs)}</code>`], ['Cost Center', r.costCenter ? `<code>${esc(r.costCenter)}</code>` : '–'], ['รหัสสินทรัพย์ (SAP)', esc(r.assetS4)], ['รหัสสินทรัพย์ (Mac5)', esc(r.assetECC)], ['วันที่ซื้อ', fmtD(r.buyDate)], ['สถานะ SAP', esc(r.sapStatus)]])}
    <h3>ภาษีและประกันภัย</h3>
    ${kv([['สถานะภาษี', esc(r.taxGroup)], ['วันครบกำหนด', fmtD(r.taxDate) + (r.taxDays != null ? ` <span class="muted small">(${r.taxDays < 0 ? 'เลยวันอ้างอิง ' + -r.taxDays + ' วัน · รออัปเดต' : 'อีก ' + r.taxDays + ' วัน'})</span>` : '')], ['ประกันภัย', esc(r.insurance)]])}
    <h3>Leasing / ภาระผูกพัน</h3>
    ${r.leased ? kv([['ประเภทภาระ', esc(r.leaseKind)], ['ผู้ให้สินเชื่อ', esc(r.lessorName || r.lessorCode)], ['รหัส', esc(r.lessorCode)], ['เลขที่สัญญา', esc(r.agreementNo)], ['วันทำสัญญา', fmtD(r.agreementDate)], ['วันเริ่ม', fmtD(r.leaseStart)], ['Notice date', fmtD(r.noticeDate)], ['ครบกำหนดภาระ', esc(r.leaseDue)]]) : '<div class="muted">ปลอดภาระ</div>'}
    ${r.note ? `<h3>หมายเหตุ</h3><div>${esc(r.note)}</div>` : ''}
    ${hist.length > 1 ? `<h3>ประวัติตามงวดที่นำเข้า</h3><div class="tblwrap"><table><thead><tr><th>งวด</th><th>ชั้นการใช้งาน</th><th>Location</th><th>ภาษี</th></tr></thead><tbody>
      ${hist.map(({x, c}) => `<tr><td>${x.label}</td><td>${pill(c.tier)}</td><td>${esc(c.loc)}</td><td>${c.taxGroup === 'ภาษีปกติ' ? fmtD(c.taxDate) : esc(c.taxGroup)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
  $('#drawer').classList.add('open'); $('#drawerBg').classList.add('open');
}
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawerBg').classList.remove('open'); }
function showModal(html){ $('#modal').innerHTML = html; $('#modalBg').style.display = 'flex'; }
function closeModal(){ $('#modalBg').style.display = 'none'; }

/* drill-down จากตารางสรุป → ไปแท็บค้นหาพร้อมตัวกรอง */
const DRILL = {
  byType: ['vtype', 'ประเภทรถ'], byLoc: ['loc', 'Location'], byUsage: ['usage', 'การใช้งาน'], taxGroup: ['taxGroup', 'สถานะภาษี'],
  taxMonth: ['taxMonth', 'ภาษีครบกำหนด'], leaseFlag: ['leaseFlag', 'ภาระผูกพัน'], leaseKind: ['leaseKind', 'ประเภทภาระ'],
  leaseDue: ['leaseDue', 'ครบกำหนดภาระ'], lessor: ['lessorLabel', 'ผู้ให้สินเชื่อ'],
};
const fieldVal = (r, f) => f === 'taxMonth' ? (r.taxDate || '').slice(0, 7) : f === 'leaseFlag' ? (r.leased ? 'ติดภาระ' : 'ปลอดภาระ')
  : f === 'lessorLabel' ? (r.lessorName || r.lessorCode || '(ไม่ระบุ)') : f === 'usage' ? (r.usage || '(ไม่ระบุ)') : r[f];
function drill(kind, k){
  const d = DRILL[kind]; if (!d) return;
  Object.assign(S, {q: '', fLoc: '', fType: '', fTax: '', fTier: 'all', fLeased: false, card: '', shown: 100, selIdx: -1,
    fField: {f: d[0], v: k, label: d[1] + ': ' + (d[0] === 'taxMonth' ? monYear(k + '-01') : k)}});
  setTab('search');
}

/* ---------- load / controls ---------- */
function setTab(t){ S.tab = t; ls.set('tab', t); render(); window.scrollTo(0, 0); }
async function load(selectKey){
  S.periods = Store.metas.slice().sort((a, b) => a.company.localeCompare(b.company) || (a.year * 12 + a.month) - (b.year * 12 + b.month));
  const want = selectKey || (S.cur && S.cur.key) || ls.get('period', null);
  S.cur = S.periods.find(p => p.key === want) || S.periods[S.periods.length - 1] || null;
  if (S.cur){
    ls.set('period', S.cur.key);
    try { await Promise.all(S.periods.filter(p => p.company === S.cur.company).map(p => Store.ensureRows(p))); }
    catch (e){ console.error(e); toast('โหลดข้อมูลรถไม่สำเร็จ ลองรีเฟรชหน้า', 4000); }
  }
  S.rows = S.cur ? computePeriod(S.cur) : [];
  const cos = [...new Set(S.periods.map(p => p.company))];
  $('#selCompany').innerHTML = cos.length ? cos.map(c => `<option ${S.cur && S.cur.company === c ? 'selected' : ''}>${esc(c)}</option>`).join('') : '<option>–</option>';
  $('#selPeriod').innerHTML = S.cur ? S.periods.filter(p => p.company === S.cur.company).slice().reverse().map(p => `<option value="${esc(p.key)}" ${p.key === S.cur.key ? 'selected' : ''}>${p.label}</option>`).join('') : '<option>ยังไม่มีงวด</option>';
  $('#subline').innerHTML = S.cur ? `ข้อมูลจาก ${esc(S.cur.fileName)} · Last Updated ${fmtDT(S.cur.importedAt)} · ${fmtN(S.rows.length)} คัน · วันที่อ้างอิง ${fmtD(refDateOf(S.cur))}` : (Store.ready ? 'ยังไม่มีข้อมูล' : 'กำลังโหลดข้อมูล…');
  $('#role').innerHTML = Store.mode === 'sb' && Store.needPw ? '' : Store.mode === 'local' ? '<span class="pill p-sold">เก็บในเครื่องนี้</span>' : Store.canWrite ? '<span class="pill p-run">ผู้ดูแล · บันทึกได้</span>' : '<span class="pill p-info">ดูและส่งออกได้</span>';
  render();
}
function recompute(){ S.rows = S.cur ? computePeriod(S.cur) : []; }

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],[data-export],[data-open],[data-fav],[data-card],[data-tier],[data-goto],[data-del],[data-drill]');
  if (!t) return;
  const d = t.dataset;
  if (d.fav){
    e.stopPropagation();
    S.favs.has(d.fav) ? S.favs.delete(d.fav) : S.favs.add(d.fav); ls.set('favs', [...S.favs]);
    document.querySelectorAll(`[data-fav="${CSS.escape(d.fav)}"]`).forEach(b => { b.classList.toggle('on', S.favs.has(d.fav)); b.textContent = S.favs.has(d.fav) ? '★' : '☆'; });
    if (S.tab === 'search' && S.card === 'fav') renderResults();
    return;
  }
  if (d.tab) return setTab(d.tab);
  if (d.export) return exportOne(d.export);
  if (d.open) return openDrawer(d.open);
  if (d.card !== undefined){ S.card = S.card === d.card ? '' : d.card; S.shown = 100; S.selIdx = -1; return render(); }
  if (d.tier){ S.fTier = d.tier; S.shown = 100; document.querySelectorAll('#fTier button').forEach(b => b.classList.toggle('on', b.dataset.tier === d.tier)); return renderResults(); }
  if (d.goto){ await load(d.goto); return; }
  if (d.del){
    const p = S.periods.find(x => x.key === d.del);
    showModal(`<h2>ลบงวด ${p.label} (${esc(p.company)})?</h2><p class="muted">ข้อมูลงวดนี้จะถูกลบออกจากเบราว์เซอร์ ถ้ายังไม่ได้สำรองไว้จะกู้คืนไม่ได้</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-act="closeModal">ยกเลิก</button><button class="btn pri" id="delOk">ลบงวดนี้</button></div>`);
    $('#delOk').onclick = async () => { await Store.del(p); closeModal(); await load(); toast('ลบงวด ' + p.label + ' แล้ว'); };
    return;
  }
  if (d.drill) return drill(d.drill, d.k);
  switch (d.act){
    case 'pick': if (Store.canWrite) $('#fileInput').click(); break;
    case 'adminLogin': e.preventDefault(); adminLoginModal(); break;
    case 'logout': await SB.client.auth.signOut(); Store.canWrite = false; Store.adminEmail = ''; await SB.refresh(); S.cur = null; await load(); toast('ออกจากระบบแล้ว'); break;
    case 'forgetPw': ls.set('viewerPw', ''); SB.pw = ''; Store.needPw = true; Store.metas = []; S.cur = null; await load(); break;
    case 'clear': Object.assign(S, {q: '', fLoc: '', fType: '', fTax: '', fTier: 'all', fLeased: false, card: '', shown: 100, fField: null}); render(); break;
    case 'more': S.shown += 200; renderResults(); break;
    case 'closeDrawer': closeDrawer(); break;
    case 'closeModal': closeModal(); break;
    case 'exportReport': exportReport(); break;
    case 'exportRaw': exportRaw(); break;
    case 'exportCsv': exportCsv(); break;
    case 'backup': backup(); break;
    case 'restore': if (Store.canWrite) $('#jsonInput').click(); break;
    case 'saveLoc': {
      const m = {}; $('#locMap').value.split('\n').forEach(l => { const [a, b] = l.split('=>').map(s => s && s.trim()); if (a && b) m[a] = b; });
      S.locMap = m; await Store.saveSettings(); recompute(); render(); toast('บันทึกตารางเทียบชื่อแล้ว'); break; }
    case 'resetLoc': S.locMap = {...DEFAULT_LOCMAP}; await Store.saveSettings(); recompute(); render(); break;
  }
});
document.addEventListener('submit', async e => {
  const id = e.target.id; if (!['pwForm', 'loginForm', 'setPwForm'].includes(id)) return;
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
  try {
    if (id === 'pwForm'){
      SB.pw = $('#viewerPw').value; await SB.refresh();
      if (Store.needPw){ Store.pwError = 'รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง หรือสอบถามผู้ดูแลระบบ'; render(); return; }
      Store.pwError = ''; ls.set('viewerPw', SB.pw); S.cur = null; await load();
    } else if (id === 'loginForm'){
      const {error} = await SB.client.auth.signInWithPassword({email: $('#adEmail').value.trim(), password: $('#adPw').value});
      if (error){ $('#loginErr').textContent = 'เข้าสู่ระบบไม่สำเร็จ: อีเมลหรือรหัสผ่านไม่ถูกต้อง'; return; }
      await SB.checkAdmin();
      if (!Store.canWrite){ await SB.client.auth.signOut(); $('#loginErr').textContent = 'บัญชีนี้ไม่ใช่ผู้ดูแลระบบ'; return; }
      closeModal(); await SB.refresh(); S.cur = null; await load(); toast('เข้าสู่ระบบผู้ดูแลแล้ว');
    } else if (id === 'setPwForm'){
      const v = $('#newViewerPw').value;
      if (v.length < 8){ toast('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'); return; }
      const {error} = await SB.client.rpc('fleet_set_viewer_password', {new_pw: v});
      if (error){ toast('ตั้งรหัสผ่านไม่สำเร็จ: ' + error.message, 4000); return; }
      $('#newViewerPw').value = ''; toast('ตั้งรหัสผ่านผู้ดูแล้ว แจกรหัสนี้ให้ทีมได้เลย', 4000);
    }
  } finally { btn.disabled = false; }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'taxWin'){ S.taxWindow = +e.target.value; ls.set('taxWindow', S.taxWindow); render(); }
  if (e.target.dataset.ref){ S.refOverride[e.target.dataset.ref] = e.target.value; await Store.saveSettings(); await load(S.cur.key); toast('ปรับวันที่อ้างอิงแล้ว'); }
});
$('#drawerBg').onclick = closeDrawer;
$('#modalBg').onclick = e => { if (e.target.id === 'modalBg') closeModal(); };
$('#selPeriod').onchange = e => load(e.target.value);
$('#selCompany').onchange = e => { const p = S.periods.filter(x => x.company === e.target.value).pop(); if (p) load(p.key); };
$('#fileInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleFile(f); };
$('#jsonInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'fleet-status' || !Array.isArray(data.periods)) throw new Error('ไม่ใช่ไฟล์สำรองของแอปนี้');
    for (const p of data.periods){ toast('กำลังกู้คืน ' + p.label + '…', 60000); await Store.put(p); }
    if (data.locMap) S.locMap = data.locMap;
    if (data.refOverride) S.refOverride = {...S.refOverride, ...data.refOverride};
    await Store.saveSettings();
    await load(); toast(`กู้คืน ${data.periods.length} งวดแล้ว`);
  } catch (err){ toast('กู้คืนไม่สำเร็จ: ' + err.message, 4000); }
};
document.addEventListener('dragover', e => { e.preventDefault(); const d = $('#drop'); if (d) d.classList.add('over'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget){ const d = $('#drop'); if (d) d.classList.remove('over'); } });
document.addEventListener('drop', e => { e.preventDefault(); const d = $('#drop'); if (d) d.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f && Store.canWrite) handleFile(f); });

// คีย์ลัด
document.addEventListener('keydown', e => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape'){
    if ($('#modalBg').style.display === 'flex') return closeModal();
    if ($('#drawer').classList.contains('open')) return closeDrawer();
    if (S.tab === 'search' && S.q){ S.q = ''; $('#q').value = ''; renderResults(); }
    return;
  }
  if (e.key === '/' && !inField){ e.preventDefault(); if (S.tab !== 'search') setTab('search'); $('#q') && $('#q').focus(); return; }
  if (S.tab !== 'search' || !$('#results')) return;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!inField || document.activeElement.id === 'q')){
    e.preventDefault();
    const n = Math.min(S.shown, (S.lastFiltered || []).length);
    S.selIdx = Math.max(0, Math.min(n - 1, S.selIdx + (e.key === 'ArrowDown' ? 1 : -1)));
    document.querySelectorAll('#results tbody tr').forEach((tr, i) => tr.classList.toggle('sel', i === S.selIdx));
    const tr = document.querySelector(`#results tbody tr[data-i="${S.selIdx}"]`); tr && tr.scrollIntoView({block: 'nearest'});
  }
  if (e.key === 'Enter' && S.selIdx >= 0 && (!inField || document.activeElement.id === 'q')){
    const r = (S.lastFiltered || [])[S.selIdx]; if (r) openDrawer(recKey(r));
  }
});

Store.init(() => load());
