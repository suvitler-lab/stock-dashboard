// stock-dashboard Worker — serves the static site (env.ASSETS) + two same-origin proxies:
//   /api/ics    — Google Calendar iCal feed (lobby ปฏิทิน)
//   /api/stocks — Yahoo Finance proxy (แทน n8n เดิม ดึงราคา/closes/pre-post quote)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const YHOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// แสดงจำนวนหุ้น — เต็มจำนวนไม่โชว์ทศนิยม แต่หุ้นเศษส่วน (fractional shares) โชว์ 2-4 ตำแหน่ง กัน "ถือ 0 หุ้น"
function qtyFmt(x) {
  if (x == null || isNaN(x)) return '—';
  return Number.isInteger(x) ? x.toLocaleString('en-US') : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// format ทศนิยม (ใช้ใน surprise/telegram) — d ตำแหน่ง (default 2)
function f2(x, d = 2) { return (x == null || isNaN(x)) ? '—' : (+x).toFixed(d); }

// request-burst memo (TTL สั้น) — dedupe การดึงซ้ำตอนโหลด dashboard · หลาย endpoint ใช้ portfolio/regime/watchlist
// ชุดเดียวกัน → computePortfolio เคยถูกดึง ~3-5 ครั้ง/โหลด · ปลอดภัยเพราะเป็นข้อมูลตลาด/พอร์ตผู้ใช้คนเดียว
// (ไม่ใช่ข้อมูลเฉพาะ request) · TTL 20s = สดพอ + ลด Yahoo subrequest มาก
const _memo = new Map();
// cache "promise" ไม่ใช่ value → callers ที่ยิงพร้อมกัน (Promise.all ใน /api/dashboard) ได้ promise เดียวกัน = dedupe จริง
function memo(key, ttlMs, fn) {
  const now = Date.now();
  const h = _memo.get(key);
  if (h && h.exp > now) return h.value;
  const p = Promise.resolve().then(fn);
  _memo.set(key, { value: p, exp: now + ttlMs });
  p.catch(() => _memo.delete(key));   // error -> ไม่ cache (ลองใหม่ได้)
  if (_memo.size > 50) for (const [k, v] of _memo) if (v.exp <= now) _memo.delete(k);
  return p;
}

async function yahooDailyRaw(symbol, range, interval) {
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, {
        headers: { 'User-Agent': UA },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) continue;
      const m = r.meta || {};
      const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
      const oArr = q.open || [], hArr = q.high || [], lArr = q.low || [], cArr = q.close || [], vArr = q.volume || [];
      const ts = r.timestamp || [];
      // เก็บเฉพาะแท่งที่มีราคาปิด (กัน null) — closes (ปิดอย่างเดียว) ไว้คำนวณ indicator
      // ohlc (เปิด/สูง/ต่ำ/ปิด + เวลา) ไว้วาดกราฟแท่งเทียน · field ที่ขาดใช้ราคาปิดแทน
      const closes = [], ohlc = [], volumes = [], timestamps = [];
      let hi52 = null, lo52 = null;
      for (let i = 0; i < cArr.length; i++) {
        const c = cArr[i];
        if (c == null) continue;
        const o = oArr[i] != null ? oArr[i] : c;
        const hi = hArr[i] != null ? hArr[i] : Math.max(o, c);
        const lo = lArr[i] != null ? lArr[i] : Math.min(o, c);
        closes.push(c);
        timestamps.push(ts[i] != null ? ts[i] : null);   // กรอง sync กับ closes — ไม่งั้น length ไม่ตรง → date-align (beta/corr) fallback เป็น tail-align เพี้ยน
        ohlc.push({ t: ts[i] != null ? ts[i] : null, o, h: hi, l: lo, c });
        volumes.push(vArr[i] != null ? vArr[i] : null);
        if (hi52 == null || hi > hi52) hi52 = hi;
        if (lo52 == null || lo < lo52) lo52 = lo;
      }
      return {
        symbol: m.symbol || symbol,
        name: m.longName || m.shortName || m.symbol || symbol,
        price: m.regularMarketPrice,
        prevClose: m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose,
        currency: m.currency || 'USD',
        exchange: m.exchangeName || '',
        closes,
        ohlc,
        volumes,
        timestamps,
        week52High: m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh : hi52,
        week52Low: m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow : lo52,
        ok: true, via: 'yahoo',
      };
    } catch (e) {}
  }
  return { symbol, ok: false, error: 'fetch_failed' };
}

// ===== Twelve Data fallback (กัน Yahoo SPOF) — คนละผู้ให้บริการ (อิสระจาก Yahoo) · free 800 req/วัน, 8/นาที =====
// gate ด้วย secret TWELVEDATA_API_KEY · ไม่ตั้ง = ไม่มี fallback (graceful: ระบบยังพึ่ง Yahoo, heartbeat เตือนถ้า Yahoo ดับ)
// ⚠️ rate limit 8/นาที: Yahoo "ดับทั้งหมดพร้อมกัน" → 22 symbol ยิงพร้อมกันบางตัวอาจโดน 429 (ได้ข้อมูลบางส่วน) · กรณีปกติ Yahoo flaky บางตัว = ทำงานเต็มที่
// ดัชนี map เป็น symbol ดัชนีจริง (^GSPC→SPX) ไม่ใช้ ETF proxy — กัน scale เพี้ยนทำ benchmark ใน journal พัง · free tier ไม่ครอบคลุมดัชนี = fail graceful (spx null)
function toTwelveSymbol(sym) {
  const s = String(sym).toUpperCase();
  const idx = { '^GSPC': 'SPX', '^IXIC': 'IXIC', '^DJI': 'DJI', '^VIX': 'VIX', '^NDX': 'NDX' };
  return idx[s] || s;   // หุ้น/ETF ใช้ ticker ตรงๆ
}
async function twelveDailyFallback(symbol, range) {
  const key = _env && _env.TWELVEDATA_API_KEY;
  if (!key) return { symbol, ok: false, error: 'no_fallback_key' };
  const outputsize = range === '5d' ? 12 : range === '1y' ? 300 : 800;
  const ts = toTwelveSymbol(symbol);
  try {
    const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ts)}&interval=1day&outputsize=${outputsize}&apikey=${key}`, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!res.ok) return { symbol, ok: false, error: 'td_http_' + res.status };
    const j = await res.json();
    if (!j || j.status === 'error' || !Array.isArray(j.values) || !j.values.length) {
      return { symbol, ok: false, error: 'td_' + String((j && j.message) || 'no_data').slice(0, 50) };
    }
    const vals = j.values.slice().reverse();   // Twelve Data = ใหม่→เก่า · reverse ให้ เก่า→ใหม่ ตรงกับ yahoo
    const closes = [], ohlc = [], volumes = [], timestamps = [];
    let hi52 = null, lo52 = null;
    for (const b of vals) {
      const c = +b.close; if (!isFinite(c)) continue;
      const o = +b.open, h = +b.high, l = +b.low, v = b.volume != null ? +b.volume : NaN;
      const hh = isFinite(h) ? h : c, ll = isFinite(l) ? l : c;
      const t = Math.floor(Date.parse(b.datetime + 'T00:00:00Z') / 1000);
      closes.push(c); volumes.push(isFinite(v) ? v : null); timestamps.push(t);
      ohlc.push({ t, o: isFinite(o) ? o : c, h: hh, l: ll, c });
      if (hi52 == null || hh > hi52) hi52 = hh;
      if (lo52 == null || ll < lo52) lo52 = ll;
    }
    if (!closes.length) return { symbol, ok: false, error: 'td_empty' };
    return {
      symbol, name: symbol, price: closes[closes.length - 1],
      prevClose: closes.length >= 2 ? closes[closes.length - 2] : null,
      currency: 'USD', exchange: 'TwelveData', closes, ohlc, volumes, timestamps,
      week52High: hi52, week52Low: lo52, ok: true, via: 'twelvedata',
    };
  } catch (e) { return { symbol, ok: false, error: 'td_' + (e && e.message) }; }
}
// yahooDaily — หน้าด่าน: Yahoo เป็นหลัก, ล้ม → Twelve Data fallback · ทุก caller ได้ resilience อัตโนมัติ (กัน Yahoo ดับทั้งระบบ)
async function yahooDaily(symbol, range, interval) {
  const y = await yahooDailyRaw(symbol, range, interval).catch(() => ({ symbol, ok: false }));
  if (y && y.ok) return y;
  if (interval && interval !== '1d') return y;   // intraday/อื่น — fallback (EOD) ช่วยไม่ได้
  return twelveDailyFallback(symbol, range);
}

async function yahooIntraday(symbol) {
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`, {
        headers: { 'User-Agent': UA },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) return null;
      const ts = r.timestamp || [];
      const cl = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const ctp = (r.meta && r.meta.currentTradingPeriod) || {};
      const regStart = ctp.regular ? ctp.regular.start : null;
      const regEnd = ctp.regular ? ctp.regular.end : null;
      let lastT = null, lastC = null;
      for (let k = ts.length - 1; k >= 0; k--) {
        if (cl[k] != null) { lastT = ts[k]; lastC = cl[k]; break; }
      }
      if (lastT != null && regEnd != null && lastT >= regEnd) return { type: 'post', price: +lastC.toFixed(2), time: lastT };
      if (lastT != null && regStart != null && lastT < regStart) return { type: 'pre', price: +lastC.toFixed(2), time: lastT };
      return null;
    } catch (e) {}
  }
  return null;
}

async function handleStocks(url) {
  const raw = (url.searchParams.get('symbols') || '').toString();
  const symbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const range = (url.searchParams.get('range') || '1y').toString();
  const interval = (url.searchParams.get('interval') || '1d').toString();
  const prepost = (url.searchParams.get('prepost') || '0').toString() === '1';
  if (symbols.length === 0) {
    return new Response(JSON.stringify({ error: 'missing symbols' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const rows = await Promise.all(symbols.map(async sym => {
    const base = await yahooDaily(sym, range, interval);
    if (!base.ok || !prepost) return base;
    const extra = await yahooIntraday(sym);
    if (extra) base.extra = extra;
    return base;
  }));
  return new Response(JSON.stringify(rows), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Generic KV-backed JSON store — ใช้กับทุก state ที่ต้องซิงค์ข้ามเครื่อง (watchlist/positions/alertCfg)
async function handleKvJson(request, env, kvKey, validator) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method === 'GET') {
    const raw = await env.WATCHLIST.get(kvKey);
    return new Response(raw || 'null', {
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await request.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (validator && !validator(parsed)) {
      return new Response(JSON.stringify({ error: 'invalid shape' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    await env.WATCHLIST.put(kvKey, body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  return new Response('method not allowed', { status: 405, headers: CORS });
}

async function handleIcs(request, url) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  let target = url.searchParams.get('url') || '';
  target = target.replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(target)) {
    return new Response('bad or missing url', { status: 400, headers: CORS });
  }
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/calendar, text/plain, */*' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const body = await r.text();
    return new Response(body, {
      status: r.ok ? 200 : r.status,
      headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8' },
    });
  } catch (e) {
    return new Response('upstream error: ' + (e && e.message ? e.message : 'fetch failed'), { status: 502, headers: CORS });
  }
}

// ---------- indicators (close-only, ตรงกับ dashboard.html + stock-alerts เป๊ะ) ----------
function ema(a, p) { if (!a || a.length < p) return null; const k = 2 / (p + 1); let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p; for (let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function emaSeries(a, p) { if (!a || a.length < p) return []; const k = 2 / (p + 1); let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p; const o = [e]; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); } return o; }
function sma(a, p) { if (!a || a.length < p) return null; const s = a.slice(-p); return s.reduce((x, y) => x + y, 0) / p; }
function stdev(a, p) { if (!a || a.length < p) return null; const s = a.slice(-p); const m = s.reduce((x, y) => x + y, 0) / p; const v = s.reduce((x, y) => x + (y - m) * (y - m), 0) / p; return Math.sqrt(v); }
function bollinger(a, p = 20, mult = 2) { if (!a || a.length < p) return null; const mid = sma(a, p); const sd = stdev(a, p); if (mid == null || sd == null) return null; return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd }; }
function roc(a, p = 10) { if (!a || a.length < p + 1) return null; const cur = a[a.length - 1]; const prv = a[a.length - 1 - p]; if (prv == null || prv === 0) return null; return (cur - prv) / prv * 100; }
function rsi(a, p = 14) { if (!a || a.length < p + 1) return null; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; for (let i = p + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0; ag = (ag * (p - 1) + up) / p; al = (al * (p - 1) + dn) / p; } if (al === 0) return 100; return 100 - 100 / (1 + ag / al); }
function macd(a) { if (!a || a.length < 35) return null; const e12 = emaSeries(a, 12), e26 = emaSeries(a, 26); const off = e12.length - e26.length; const line = e26.map((v, i) => e12[i + off] - v); const sig = emaSeries(line, 9); return { hist: line[line.length - 1] - sig[sig.length - 1] }; }
// resample daily ohlc → weekly closes (เอาราคาปิดตัวสุดท้ายของแต่ละสัปดาห์) สำหรับ Weekly RSI โดยไม่ต้อง fetch เพิ่ม
function weeklyCloses(ohlc) {
  if (!ohlc || !ohlc.length) return [];
  const buckets = new Map();  // weekIndex → close ล่าสุด
  for (const bar of ohlc) {
    if (bar.t == null || bar.c == null) continue;
    const wk = Math.floor((bar.t + 4 * 86400) / (7 * 86400));  // shift ให้ตัดสัปดาห์วันเสาร์
    buckets.set(wk, bar.c);  // Map รักษาลำดับ insert — bar เรียงตามเวลาอยู่แล้ว
  }
  return Array.from(buckets.values());
}
// CMF (Chaikin Money Flow) — เงินสถาบันไหลเข้า/ออก จาก ohlc + volume (ค่า > 0 = เข้า, < 0 = ออก)
function cmf(ohlc, volumes, period = 20) {
  if (!ohlc || !volumes || ohlc.length < period) return null;
  let mfvSum = 0, volSum = 0;
  for (let i = ohlc.length - period; i < ohlc.length; i++) {
    const b = ohlc[i], v = volumes[i];
    if (b == null || v == null || v <= 0) continue;
    const range = b.h - b.l;
    if (range <= 0) continue;
    const mfm = ((b.c - b.l) - (b.h - b.c)) / range;  // money flow multiplier [-1,1]
    mfvSum += mfm * v;
    volSum += v;
  }
  return volSum > 0 ? mfvSum / volSum : null;
}
// ATR14 — ค่าความผันผวนเฉลี่ย 14 วัน ใช้ตั้ง stop loss แบบ ATR-based (SL = price - 2×ATR)
function atr(ohlc, period = 14) {
  if (!ohlc || ohlc.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < ohlc.length; i++) {
    const b = ohlc[i], pc = ohlc[i - 1].c;
    if (b == null || pc == null) continue;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}
// Beta vs ตลาด (252 วัน) — beta > 1 ผันผวนกว่า S&P500
// จับคู่ daily returns ตาม "วันที่" (timestamp) ไม่ใช่ตำแหน่งท้าย — กัน beta/corr เพี้ยนเมื่อ 2 series วันไม่ตรงกัน
// (เคสจริง: GEV/SMH/LLY ได้ beta ติดลบเพราะ tail-align ผิดวัน) · ถ้าไม่มี ts → fallback tail-align แบบเดิม
function alignedReturns(closesA, tsA, closesB, tsB, period) {
  let a, b;
  if (tsA && tsB && tsA.length === closesA.length && tsB.length === closesB.length) {
    const mapB = new Map();
    for (let i = 0; i < tsB.length; i++) if (closesB[i] != null) mapB.set(Math.floor(tsB[i] / 86400), closesB[i]);
    const ca = [], cb = [];
    for (let i = 0; i < tsA.length; i++) {
      const m = mapB.get(Math.floor(tsA[i] / 86400));   // bucket เป็นวัน (UTC) → จับคู่เฉพาะวันที่มีทั้งคู่
      if (m != null && closesA[i] != null) { ca.push(closesA[i]); cb.push(m); }
    }
    a = dailyReturns(ca); b = dailyReturns(cb);
  } else {
    a = dailyReturns(closesA); b = dailyReturns(closesB);
  }
  const n = Math.min(a.length, b.length, period || Infinity);
  return n > 0 ? { a: a.slice(-n), b: b.slice(-n) } : { a: [], b: [] };
}
function betaVsSpx(stockCloses, spxCloses, period = 252, stockTs, spxTs) {
  const { a: sr, b: mr } = alignedReturns(stockCloses, stockTs, spxCloses, spxTs, period);
  const n = sr.length;
  if (n < 30) return null;
  const ms = sr.reduce((x, y) => x + y, 0) / n, mm = mr.reduce((x, y) => x + y, 0) / n;
  let cov = 0, varM = 0;
  for (let i = 0; i < n; i++) { cov += (sr[i] - ms) * (mr[i] - mm); varM += (mr[i] - mm) ** 2; }
  return varM > 0 ? +(cov / varM).toFixed(2) : null;
}
// Correlation ระหว่าง 2 ชุด closes ในช่วง period วัน (date-aligned)
function corrBetween(aCloses, bCloses, period, aTs, bTs) {
  const { a: ar, b: br } = alignedReturns(aCloses, aTs, bCloses, bTs, period);
  const n = ar.length;
  if (n < 10) return null;
  const ma = ar.reduce((x, y) => x + y, 0) / n, mb = br.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ar[i] - ma) * (br[i] - mb); da += (ar[i] - ma) ** 2; db += (br[i] - mb) ** 2; }
  return (da > 0 && db > 0) ? +(num / Math.sqrt(da * db)).toFixed(2) : null;
}
// เกราะกัน beta เพี้ยน: หุ้น/ETF ในพอร์ตควร beta บวกเสมอ (~0.2–3.5) · ติดลบ/ใกล้ 0 / สูงเว่อร์ = ข้อมูลเพี้ยน
// (เคส GEV −0.49 จาก data fallback) → ในการคิดความเสี่ยงแทนด้วย 1.0 (market beta) กัน VaR/scenario ต่ำเกินจริง
function betaReliable(b) { return b != null && b >= 0.1 && b <= 4; }
function betaForRisk(b) { return betaReliable(b) ? b : 1.0; }
// RS vs S&P500 — ดึง %เปลี่ยนของดัชนี ^GSPC ครั้งเดียว เทียบกับหุ้นแต่ละตัว
async function spxChangePct() {
  const q = await yahooDaily('^GSPC', '5d', '1d').catch(() => null);
  if (!q || !q.ok || q.price == null) return null;
  const prev = q.prevClose != null ? q.prevClose : (q.closes && q.closes.length >= 2 ? q.closes[q.closes.length - 2] : null);
  return prev ? (q.price - prev) / prev * 100 : null;
}
// signalOf (ป้าย BUY/HOLD/SELL แบบนับคะแนนเทรนด์ซ้ำ) ถูกแทนด้วย labelFromConviction (derive จาก conviction 5 มิติ)
// ดู convictionScore + labelFromConviction ด้านล่าง — source เดียว เลิก double-count + เลิก copy 3 ไฟล์

// Yahoo บังคับ crumb+cookie สำหรับ v7/options แล้ว (ไม่งั้นตอบ "Invalid Crumb")
// flow: GET fc.yahoo.com → Set-Cookie · GET /v1/test/getcrumb (พร้อม cookie) → crumb
// cache ระดับ isolate (in-memory) · refresh ได้เมื่อหมดอายุ/โดน 401
let _yahooAuth = null; // { cookie, crumb }
let _env = null; // stash env ที่ entry (scheduled/fetch) → ให้ fallback (twelveDailyFallback) อ่าน secret โดยไม่ต้อง thread env ทุก call site
async function getYahooAuth(force = false) {
  if (_yahooAuth && !force) return _yahooAuth;
  try {
    const cRes = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const setCookies = (cRes.headers.getSetCookie && cRes.headers.getSetCookie()) || [];
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    if (!cookie) return null;
    for (const h of YHOSTS) {
      const crRes = await fetch(`${h}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, 'Cookie': cookie } });
      if (!crRes.ok) continue;
      const crumb = (await crRes.text()).trim();
      if (crumb && !crumb.includes('<') && crumb.length < 40) { _yahooAuth = { cookie, crumb }; return _yahooAuth; }
    }
  } catch (e) {}
  return null;
}

// Implied Move จาก ATM straddle (call+put) / ราคาปัจจุบัน — บอก options market คาดว่าจะเคลื่อนไหว ±กี่%
async function fetchImpliedMove(symbol, price, _retried = false) {
  if (!price || price <= 0) return null;
  const auth = await getYahooAuth();
  if (!auth) return null;
  const qs = `?crumb=${encodeURIComponent(auth.crumb)}`;
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v7/finance/options/${encodeURIComponent(symbol)}${qs}`, {
        headers: { 'User-Agent': UA, 'Cookie': auth.cookie },
        cf: { cacheTtl: 900, cacheEverything: true },
      });
      // crumb หมดอายุ/ไม่ถูกต้อง → refresh แล้วลองใหม่ครั้งเดียว
      if ((res.status === 401 || res.status === 403) && !_retried) {
        await getYahooAuth(true);
        return fetchImpliedMove(symbol, price, true);
      }
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.optionChain && j.optionChain.result && j.optionChain.result[0];
      if (!r) continue;
      const opts = r.options && r.options[0];
      if (!opts) continue;
      const calls = opts.calls || [], puts = opts.puts || [];
      if (!calls.length || !puts.length) return null;
      const atmCall = calls.reduce((a, b) => Math.abs(a.strike - price) <= Math.abs(b.strike - price) ? a : b);
      const atmPut = puts.reduce((a, b) => Math.abs(a.strike - price) <= Math.abs(b.strike - price) ? a : b);
      const callMid = ((atmCall.bid || 0) + (atmCall.ask || 0)) / 2;
      const putMid = ((atmPut.bid || 0) + (atmPut.ask || 0)) / 2;
      const straddle = callMid + putMid;
      if (straddle <= 0) return null;
      const pct = +(straddle / price * 100).toFixed(2);
      const expMs = (r.expirationDates && r.expirationDates[0] || 0) * 1000;
      const expDate = expMs ? new Date(expMs).toISOString().slice(0, 10) : null;
      return { pct, expDate, strike: atmCall.strike };
    } catch (e) {}
  }
  return null;
}

// Implied move เปลี่ยนช้า (options chain) → cache ลง KV รายวัน เลี่ยงดึง Yahoo ทุก request
// key: im:SYMBOL  ·  TTL 6 ชม.  ·  เก็บ {pct,expDate,strike} ที่คำนวณจากราคาตอน cache
async function fetchImpliedMoveCached(env, symbol, price) {
  if (!price || price <= 0) return null;
  const key = `im:${symbol}`;
  try {
    const raw = await env.WATCHLIST.get(key);
    if (raw) { const c = JSON.parse(raw); if (c && c.pct != null) return c; }
  } catch (e) {}
  const im = await fetchImpliedMove(symbol, price).catch(() => null);
  if (im && im.pct != null) {
    try { await env.WATCHLIST.put(key, JSON.stringify(im), { expirationTtl: 21600 }); } catch (e) {}
  }
  return im;
}

// CATALYST — วันประกาศงบถัดไป จาก Yahoo quoteSummary (ต้อง crumb เหมือน options) · ใช้ flag "อย่าเข้าก่อนงบ"
async function fetchEarnings(symbol, _retried = false) {
  const auth = await getYahooAuth();
  if (!auth) return null;
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`, {
        headers: { 'User-Agent': UA, 'Cookie': auth.cookie }, cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if ((res.status === 401 || res.status === 403) && !_retried) { await getYahooAuth(true); return fetchEarnings(symbol, true); }
      if (!res.ok) continue;
      const j = await res.json();
      const ce = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] && j.quoteSummary.result[0].calendarEvents;
      const ed = ce && ce.earnings && ce.earnings.earningsDate;
      if (!ed || !ed.length) return null;
      const now = Date.now() / 1000;
      const raws = ed.map(e => e.raw).filter(Boolean).sort((a, b) => a - b);
      const next = raws.find(r => r >= now - 86400) || raws[0];   // earningsDate อาจเป็น range — เอาตัวอนาคต
      if (!next) return null;
      return { date: new Date(next * 1000).toISOString().slice(0, 10) };
    } catch (e) {}
  }
  return null;
}
// คำนวณ daysUntil สดจาก date ที่ cache (อย่า cache daysUntil เพราะลดลงทุกวัน)
function earningsWithDays(date) {
  const t = new Date(date + 'T12:00:00Z').getTime() / 1000;
  return { date, daysUntil: Math.round((t - Date.now() / 1000) / 86400) };
}
// cache รายวัน (KV earn:SYM) — earnings date เปลี่ยนไม่บ่อย · เก็บ {none:true} ถ้าหาไม่เจอ กันดึงซ้ำ
async function fetchEarningsCached(env, symbol) {
  const key = `earn:${symbol}`;
  try {
    const raw = await env.WATCHLIST.get(key);
    if (raw) { const c = JSON.parse(raw); if (c && c.date) return earningsWithDays(c.date); if (c && c.none) return null; }
  } catch (e) {}
  const e = await fetchEarnings(symbol).catch(() => null);
  try { await env.WATCHLIST.put(key, JSON.stringify(e ? { date: e.date } : { none: true }), { expirationTtl: 86400 }); } catch (_) {}
  return e ? earningsWithDays(e.date) : null;
}
// อ่าน earnings จาก KV เท่านั้น (ไม่ fetch = ไม่เพิ่ม subrequest) ใช้ใน computeDecision · cache warm โดย cron
async function fetchEarningsReadOnly(env, symbol) {
  try { const raw = await env.WATCHLIST.get(`earn:${symbol}`); if (raw) { const c = JSON.parse(raw); if (c && c.date) return earningsWithDays(c.date); } } catch (e) {}
  return null;
}
// warm earnings cache ทุกตัว (เรียกจาก cron รายวัน + endpoint) — ดึง Yahoo ครั้งเดียว/วัน
async function warmEarnings(env, symbols) {
  for (const s of symbols) { await fetchEarningsCached(env, s).catch(() => null); }  // ทีละตัว เลี่ยง subrequest พุ่งพร้อมกัน
}

// FUNDAMENTALS — quality/valuation (flag-only) จาก Yahoo quoteSummary (ต้อง crumb เหมือน earnings/options)
async function fetchFundamentals(symbol, _retried = false) {
  const auth = await getYahooAuth();
  if (!auth) return null;
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,summaryDetail,defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`, {
        headers: { 'User-Agent': UA, 'Cookie': auth.cookie }, cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if ((res.status === 401 || res.status === 403) && !_retried) { await getYahooAuth(true); return fetchFundamentals(symbol, true); }
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (!r) continue;
      const fd = r.financialData || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {};
      const num = x => (x && typeof x === 'object' && x.raw != null) ? x.raw : (typeof x === 'number' ? x : null);
      return {
        trailingPE: num(sd.trailingPE), forwardPE: num(sd.forwardPE) != null ? num(sd.forwardPE) : num(ks.forwardPE),
        profitMargin: num(fd.profitMargins), debtToEquity: num(fd.debtToEquity),
        roe: num(fd.returnOnEquity), revGrowth: num(fd.revenueGrowth),
      };
    } catch (e) {}
  }
  return null;
}
async function fetchFundamentalsCached(env, symbol) {
  const key = `fund:${symbol}`;
  try { const raw = await env.WATCHLIST.get(key); if (raw) { const c = JSON.parse(raw); if (c) return c; } } catch (e) {}
  const f = await fetchFundamentals(symbol).catch(() => null);
  if (f) { try { await env.WATCHLIST.put(key, JSON.stringify(f), { expirationTtl: 86400 }); } catch (e) {} }   // เปลี่ยนช้า cache 24 ชม.
  return f;
}
async function fetchFundamentalsReadOnly(env, symbol) {
  try { const raw = await env.WATCHLIST.get(`fund:${symbol}`); if (raw) return JSON.parse(raw); } catch (e) {}
  return null;
}
async function warmFundamentals(env, symbols) {
  for (const s of symbols) { await fetchFundamentalsCached(env, s).catch(() => null); }
}
// fundamentals → flag เตือน (flag-only ไม่ block · เกณฑ์หยาบ กันของแย่ชัดๆ สำหรับการถือหลายสัปดาห์)
function fundamentalFlags(f) {
  if (!f) return [];
  const flags = [];
  if (f.profitMargin != null && f.profitMargin < 0) flags.push(`📉 ขาดทุน (net margin ${(f.profitMargin * 100).toFixed(0)}%)`);
  if (f.debtToEquity != null && f.debtToEquity > 200) flags.push(`🏦 หนี้สูง (D/E ${Math.round(f.debtToEquity)})`);
  const pe = (f.forwardPE != null && f.forwardPE > 0) ? f.forwardPE : f.trailingPE;
  if (pe != null && pe > 60) flags.push(`💸 แพงมาก (PE ${Math.round(pe)})`);
  return flags;
}

// คำนวณข้อมูล watchlist + indicator + signal (ใช้ร่วมทั้ง /api/data JSON และ /report HTML)
// opts.options=true → ดึง implied move (ช้า ~22 call Yahoo) · default ปิด ให้ endpoint หนักเร็วขึ้น
function computeWatchlistData(env, opts = {}) {
  return memo('wd:' + (opts.lite ? 1 : 0) + ':' + (opts.cached ? 1 : 0), 20000, () => _computeWatchlistDataRaw(env, opts));
}
async function _computeWatchlistDataRaw(env, opts = {}) {
  const wantOptions = !!opts.options;
  // cached: อ่าน fullData ที่ cron (*/15) เขียนไว้ ถ้าสด <20 นาที → คืนเลย (เลี่ยง recompute 44 fetch)
  if (opts.cached) {
    try {
      const raw = await env.WATCHLIST.get('fullData');
      if (raw) {
        const cd = JSON.parse(raw);
        if (cd && cd.updated && (Date.now() - new Date(cd.updated).getTime()) < 20 * 60 * 1000) return cd;
      }
    } catch (e) {}
  }
  let arr = [];
  try { const raw = await env.WATCHLIST.get('main'); if (raw) arr = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(arr) || arr.length === 0) return { updated: new Date().toISOString(), count: 0, stocks: [] };
  const lv = {};
  arr.forEach(w => { if (w && w.symbol) lv[String(w.symbol).toUpperCase()] = { entry: +w.entry || 0, sl: +w.sl || 0, tp: +w.tp || 0 }; });
  const symbols = Object.keys(lv);
  // ดึงรายวัน (closes/indicator) + intraday (ราคา pre/post สดๆ) ทุกตัว + %เปลี่ยนดัชนี S&P500 (สำหรับ RS) ขนานกันทั้งหมด
  const [spxFull, rows] = await Promise.all([
    yahooDaily('^GSPC', '1y', '1d').catch(() => null),
    Promise.all(symbols.map(async s => {
      const base = await yahooDaily(s, '1y', '1d').catch(() => ({ symbol: s, ok: false }));
      if (base && base.ok) {
        const [ext, im] = await Promise.all([
          opts.lite ? Promise.resolve(null) : yahooIntraday(s).catch(() => null),  // lite: ข้าม intraday ลด subrequest
          wantOptions ? fetchImpliedMoveCached(env, s, base.price).catch(() => null) : Promise.resolve(null),
        ]);
        base.livePrice = ext ? ext.price : base.price;
        base.phase = ext ? ext.type : 'regular';
        base.impliedMove = im;
      }
      return base;
    })),
  ]);
  const spxCloses = (spxFull && spxFull.ok) ? spxFull.closes : [];
  const spxTimestamps = (spxFull && spxFull.ok) ? spxFull.timestamps : null;
  // ⚠️ range=1y → prevClose (chartPreviousClose) = ราคา 1 ปีก่อน ห้ามใช้! ต้องใช้ closes[-2] (ปิดเมื่อวาน)
  // robust: ถ้าแท่งล่าสุด ≈ ราคาปัจจุบัน = วันนี้ปิดแล้ว → ฐาน = closes[-2] · ไม่งั้น (intraday) closes[-1] = เมื่อวาน
  let spxChg = null;
  if (spxFull && spxFull.ok && spxFull.price && spxCloses.length >= 2) {
    const slast = spxCloses[spxCloses.length - 1];
    const sIsToday = Math.abs(slast - spxFull.price) <= Math.max(spxFull.price * 0.001, 0.5);
    const spxPrev = sIsToday ? spxCloses[spxCloses.length - 2] : slast;
    spxChg = spxPrev ? (spxFull.price - spxPrev) / spxPrev * 100 : null;
  }
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  const stocks = rows.map(q => {
    if (!q || !q.ok || q.price == null || !q.closes || !q.closes.length) return { symbol: q && q.symbol, ok: false };
    const c = q.closes;
    const price = (q.livePrice != null ? q.livePrice : q.price);  // ราคาล่าสุดรวม pre/post — เปลี่ยนตามตลาดจริง
    const ind = { rsi: rsi(c, 14), ema20: ema(c, 20), ema50: ema(c, 50), ema100: ema(c, 100), ema200: ema(c, 200), sma200: sma(c, 200), macd: macd(c), boll: bollinger(c, 20, 2), roc: roc(c, 10), price };
    const last = c[c.length - 1];
    const lastIsToday = (last != null && Math.abs(last - q.price) <= Math.max(q.price * 0.001, 0.02));
    // pre/post market: ราคา livePrice เทียบกับ regularMarketPrice (ปิดเซสชันล่าสุด) ไม่ใช่ c[-2]
    const prev = (q.phase === 'pre' || q.phase === 'post')
      ? q.price
      : c.length >= 2 ? (lastIsToday ? c[c.length - 2] : last) : null;
    const L = lv[q.symbol] || {};
    // Weekly RSI (resample จาก daily) · Volume (ล่าสุด + เฉลี่ย 20 วัน) · 52-week high/low + ระยะห่าง
    const wkRsi = rsi(weeklyCloses(q.ohlc), 14);
    const vols = (q.volumes || []).filter(v => v != null);
    const volLast = vols.length ? vols[vols.length - 1] : null;
    const volAvg20 = vols.length >= 20 ? vols.slice(-20).reduce((x, y) => x + y, 0) / 20 : (vols.length ? vols.reduce((x, y) => x + y, 0) / vols.length : null);
    const w52h = q.week52High, w52l = q.week52Low;
    // CMF (เงินสถาบัน) + RS vs S&P500 (แข็ง/อ่อนเทียบตลาด) — ป้อนเข้า signalOf ก่อนตัดสินสัญญาณ
    const stockChg = prev ? (price - prev) / prev * 100 : null;
    ind.cmf = cmf(q.ohlc, q.volumes, 20);
    ind.rsVsSpx = (stockChg != null && spxChg != null) ? +(stockChg - spxChg).toFixed(2) : null;
    // ATR14 · Beta1y · Correlation vs SPX (30d / 60d)
    const atrVal = atr(q.ohlc, 14);
    const betaVal = betaVsSpx(c, spxCloses, 252, q.timestamps, spxTimestamps);
    const corr30 = corrBetween(c, spxCloses, 30, q.timestamps, spxTimestamps);
    const corr60 = corrBetween(c, spxCloses, 60, q.timestamps, spxTimestamps);
    // Relative Strength แบบ "เทรนด์ 3 เดือน" (≈63 วันทำการ) เทียบ S&P500 — RS จริงเป็นเทรนด์ ไม่ใช่ noise วันเดียว
    let rs3m = null;
    if (c.length >= 64 && spxCloses.length >= 64) {
      const sR = (c[c.length - 1] - c[c.length - 64]) / c[c.length - 64] * 100;
      const xR = (spxCloses[spxCloses.length - 1] - spxCloses[spxCloses.length - 64]) / spxCloses[spxCloses.length - 64] * 100;
      if (isFinite(sR) && isFinite(xR)) rs3m = +(sR - xR).toFixed(2);
    }
    const row = {
      symbol: q.symbol, name: q.name, signal: null,
      cmf: rnd(ind.cmf, 3), rsVsSpx: ind.rsVsSpx, rs3m,
      price: rnd(price), regularClose: rnd(q.price), phase: q.phase || 'regular',
      changePct: prev ? rnd((price - prev) / prev * 100) : null,
      rsi: rnd(ind.rsi, 1), rsiWeekly: rnd(wkRsi, 1),
      ema15: rnd(ema(c, 15)), ema30: rnd(ema(c, 30)), ema50: rnd(ind.ema50), ema100: rnd(ind.ema100), ema200: rnd(ind.ema200), sma200: rnd(ind.sma200),
      macdHist: ind.macd ? rnd(ind.macd.hist, 3) : null,
      bollUpper: ind.boll ? rnd(ind.boll.upper) : null, bollLower: ind.boll ? rnd(ind.boll.lower) : null,
      roc10: rnd(ind.roc, 2),
      volume: volLast != null ? Math.round(volLast) : null,
      volAvg20: volAvg20 != null ? Math.round(volAvg20) : null,
      volRatio: (volLast != null && volAvg20) ? rnd(volLast / volAvg20, 2) : null,
      week52High: rnd(w52h), week52Low: rnd(w52l),
      pctFrom52High: (w52h && price) ? rnd((price - w52h) / w52h * 100) : null,
      pctFrom52Low: (w52l && price) ? rnd((price - w52l) / w52l * 100) : null,
      atr14: rnd(atrVal), slAtr2x: (price && atrVal) ? rnd(price - 2 * atrVal) : null,
      beta1y: betaVal, corr30, corr60,
      impliedMove: q.impliedMove || null,
      entry: L.entry || 0, sl: L.sl || 0, tp: L.tp || 0, ok: true,
    };
    // ป้าย BUY/HOLD/SELL = derive จาก conviction (5 มิติ bucketed) — source เดียว เลิกนับปัจจัยเทรนด์ซ้ำแบบ signalOf เดิม
    // (ที่นี่ใช้ neutral weight = ค่า live สำหรับ /api/data + fallback · decide/snapshot จะคำนวณ regime-weighted แยก)
    const cv = convictionScore(row);
    row.conviction = cv.score;
    row.signal = labelFromConviction(cv.score);
    return row;
  });
  // Pairwise correlation 30d ระหว่างหุ้นใน watchlist (เฉพาะคู่ที่ |corr| >= 0.70)
  const okRaws = rows.filter(q => q && q.ok && q.closes && q.closes.length >= 31);
  const pairCorr30 = [];
  for (let i = 0; i < okRaws.length; i++) {
    for (let j = i + 1; j < okRaws.length; j++) {
      const c30 = corrBetween(okRaws[i].closes, okRaws[j].closes, 30, okRaws[i].timestamps, okRaws[j].timestamps);
      if (c30 != null && Math.abs(c30) >= 0.70) pairCorr30.push({ a: okRaws[i].symbol, b: okRaws[j].symbol, corr30: c30 });
    }
  }
  pairCorr30.sort((a, b) => Math.abs(b.corr30) - Math.abs(a.corr30));
  // spxLastBarTs = unix(s) ของแท่ง SPX รายวันล่าสุด → ใช้เช็ค "ตลาด US เทรดวันนี้จริงไหม" (กัน snapshot วันหยุด/ข้อมูลค้าง)
  const spxLastBarTs = (spxFull && spxFull.ok && spxFull.timestamps && spxFull.timestamps.length) ? spxFull.timestamps[spxFull.timestamps.length - 1] : null;
  // dataVia = แหล่งข้อมูลที่ใช้จริง — มี non-yahoo โผล่ = Yahoo ล้ม กำลังวิ่ง fallback (สังเกตได้ผ่าน heartbeat/Telegram)
  const viaSet = new Set();
  if (spxFull && spxFull.via) viaSet.add(spxFull.via);
  rows.forEach(q => { if (q && q.via) viaSet.add(q.via); });
  const dataVia = (viaSet.size === 1 && viaSet.has('yahoo')) ? 'yahoo' : (viaSet.size ? [...viaSet].sort().join('+') : 'none');
  return { updated: new Date().toISOString(), count: stocks.filter(s => s.ok).length, source: 'Yahoo Finance via Cloudflare Worker', dataVia, spxChangePct: rnd(spxChg, 2), spxPrice: rnd(spxFull && spxFull.ok ? spxFull.price : null), spxLastBarTs, note: 'signal = rule-based score (RSI/EMA/MACD/Bollinger/ROC/CMF/RS vs S&P500), ไม่ใช่คำแนะนำการลงทุน', stocks, pairCorr30 };
}

// MARKET bar — ดัชนีตลาดรวม (S&P500 / Nasdaq / Dow + VIX) สำหรับหัวรายงาน
async function fetchMarketBar() {
  const idx = [
    { sym: '^GSPC', label: 'S&P 500' },
    { sym: '^IXIC', label: 'Nasdaq' },
    { sym: '^DJI', label: 'Dow Jones' },
    { sym: '^VIX', label: 'VIX' },
  ];
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  const rows = await Promise.all(idx.map(async it => {
    const q = await yahooDaily(it.sym, '5d', '1d').catch(() => null);
    if (!q || !q.ok || q.price == null) return { label: it.label, ok: false };
    const prev = q.prevClose != null ? q.prevClose : (q.closes && q.closes.length >= 2 ? q.closes[q.closes.length - 2] : null);
    const chgPct = prev ? (q.price - prev) / prev * 100 : null;
    return { label: it.label, price: rnd(q.price), chgPct: rnd(chgPct), ok: true };
  }));
  return rows;
}

// /api/data — JSON (ให้ Claude/โปรแกรมอ่าน)
async function handleData(env, wantOptions = false) {
  // ไม่ขอ options → อ่าน cache เร็ว (cron เขียนทุก 15 นาที) · ขอ options → สดเต็ม
  const d = await computeWatchlistData(env, { options: wantOptions, cached: !wantOptions });
  return new Response(JSON.stringify(d, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// /text — ข้อความล้วน (plain text) ก๊อปวางใน Gemini/AI ใดก็ได้ ชัวร์สุด
async function handleText(env) {
  const [d, market, port] = await Promise.all([
    computeWatchlistData(env, { options: true }),
    fetchMarketBar().catch(() => []),
    computePortfolio(env).catch(() => null),
  ]);
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const vfmt = v => v == null ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const ok = d.stocks.filter(s => s.ok);
  let out = `ข้อมูลหุ้น Watchlist (${d.count} ตัว) — อัปเดต ${tm} เวลาไทย · แหล่ง Yahoo Finance\n`;
  out += `(signal = คะแนนกฎเทคนิคอล RSI/EMA/MACD/Bollinger/ROC/CMF/RS ไม่ใช่คำแนะนำลงทุน)\n`;
  // MARKET bar
  const mk = (market || []).filter(m => m.ok);
  if (mk.length) {
    out += `\nตลาดรวม: ` + mk.map(m => `${m.label} ${f(m.price, m.label === 'VIX' ? 2 : 0)} (${m.chgPct >= 0 ? '+' : ''}${f(m.chgPct)}%)`).join(' · ') + `\n`;
  }
  out += `\n`;
  ok.forEach(s => {
    const ph = s.phase === 'pre' ? ` [พรีมาร์เก็ต · ปิดเมื่อวาน $${f(s.regularClose)}]`
             : s.phase === 'post' ? ` [หลังปิดตลาด · ปิดวันนี้ $${f(s.regularClose)}]` : '';
    out += `${s.symbol} — ${s.name}\n`;
    out += `  ราคา $${f(s.price)}${ph} (${s.changePct >= 0 ? '+' : ''}${f(s.changePct)}%) · สัญญาณ ${s.signal}\n`;
    out += `  RSI(วัน) ${f(s.rsi, 1)} · RSI(สัปดาห์) ${f(s.rsiWeekly, 1)} · MACD hist ${f(s.macdHist, 3)} · ROC10 ${f(s.roc10)}%\n`;
    out += `  EMA15 ${f(s.ema15)} · EMA50 ${f(s.ema50)} · EMA200 ${f(s.ema200)} · SMA200 ${f(s.sma200)}\n`;
    out += `  Volume ${vfmt(s.volume)} (เฉลี่ย20 ${vfmt(s.volAvg20)}${s.volRatio != null ? ' · ' + f(s.volRatio) + 'x' : ''})\n`;
    out += `  CMF20 ${f(s.cmf, 3)} (${s.cmf > 0.05 ? 'เงินสถาบันไหลเข้า' : s.cmf < -0.05 ? 'เงินสถาบันไหลออก' : 'เงินนิ่ง'}) · RS vs S&P500 ${s.rsVsSpx >= 0 ? '+' : ''}${f(s.rsVsSpx)}% (${s.rsVsSpx >= 0 ? 'แข็งกว่าตลาด' : 'อ่อนกว่าตลาด'})\n`;
    out += `  52สัปดาห์ ${f(s.week52Low)}–${f(s.week52High)} (ห่างจุดสูงสุด ${f(s.pctFrom52High)}% · เหนือจุดต่ำสุด ${s.pctFrom52Low >= 0 ? '+' : ''}${f(s.pctFrom52Low)}%)\n`;
    out += `  Bollinger ${f(s.bollLower)}–${f(s.bollUpper)} · Entry ${f(s.entry)} / SL ${f(s.sl)} / TP ${f(s.tp)}\n`;
    out += `  ATR14 $${f(s.atr14)} · SL(2×ATR) $${f(s.slAtr2x)} · Beta(1y) ${f(s.beta1y, 2)}\n`;
    out += `  Corr vs SPX 30d ${f(s.corr30, 2)} · 60d ${f(s.corr60, 2)}`;
    if (s.impliedMove && s.impliedMove.pct) out += ` · Implied±${f(s.impliedMove.pct)}% (exp ${s.impliedMove.expDate || '—'} strike ${s.impliedMove.strike})`;
    out += `\n\n`;
  });
  // Pairwise correlation สูง (≥0.70) ใน watchlist
  if (d.pairCorr30 && d.pairCorr30.length) {
    out += `— สหสัมพันธ์สูง 30 วัน (|corr| ≥ 0.70) —\n`;
    d.pairCorr30.forEach(p => { out += `  ${p.a} ↔ ${p.b}: ${f(p.corr30, 2)}\n`; });
    out += `\n`;
  }
  // P/L พอร์ต
  if (port && port.count > 0) {
    const ps = port.summary;
    out += `— สรุปพอร์ตที่ถืออยู่ (${port.count} ตัว) —\n`;
    out += `มูลค่า $${f(ps.value, 0)} · ต้นทุน $${f(ps.cost, 0)} · กำไร/ขาดทุนรวม ${ps.pl >= 0 ? '+' : ''}$${f(ps.pl, 0)} (${ps.plPct >= 0 ? '+' : ''}${f(ps.plPct)}%) · วันนี้ ${ps.dayPL >= 0 ? '+' : ''}$${f(ps.dayPL, 0)}\n`;
    port.positions.filter(p => p.ok).forEach(p => {
      out += `  ${p.symbol}: ถือ ${qtyFmt(p.qty)} หุ้น @ ทุน ${f(p.avgCost)} · ราคา ${f(p.price)} · P/L ${p.pl >= 0 ? '+' : ''}$${f(p.pl, 0)} (${p.plPct >= 0 ? '+' : ''}${f(p.plPct)}%) · สัดส่วน ${f(p.weight)}%\n`;
    });
    out += `\n`;
  }
  return new Response(out, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// คำนวณพอร์ต — ดึง positions จาก KV + ราคาสด → สรุปมูลค่า/กำไรขาดทุน (รวม + รายตัว)
function computePortfolio(env) {
  return memo('portfolio', 20000, () => _computePortfolioRaw(env));
}
async function _computePortfolioRaw(env) {
  let arr = [];
  try { const raw = await env.WATCHLIST.get('positions'); if (raw) arr = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(arr)) arr = [];
  // รวมจำนวน/ต้นทุนของหุ้นตัวเดียวกัน (ผู้ใช้อาจซื้อหลายครั้ง → หาทุนเฉลี่ยถ่วงน้ำหนัก)
  const agg = {};
  arr.forEach(p => {
    if (!p || !p.symbol) return;
    const sym = String(p.symbol).toUpperCase();
    const qty = +p.qty || 0;
    const cost = +p.cost || 0;
    if (qty <= 0) return;
    if (!agg[sym]) agg[sym] = { symbol: sym, qty: 0, costTotal: 0 };
    agg[sym].qty += qty;
    agg[sym].costTotal += cost * qty;
  });
  const symbols = Object.keys(agg);
  if (symbols.length === 0) return { updated: new Date().toISOString(), count: 0, positions: [], summary: { cost: 0, value: 0, pl: 0, plPct: 0, dayPL: 0 } };
  const rows = await Promise.all(symbols.map(async s => {
    const base = await yahooDaily(s, '5d', '1d').catch(() => ({ symbol: s, ok: false }));
    if (base && base.ok) {
      const ext = await yahooIntraday(s).catch(() => null);
      base.livePrice = ext ? ext.price : base.price;
      base.phase = ext ? ext.type : 'regular';
    }
    return base;
  }));
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  let sumCost = 0, sumVal = 0, sumDay = 0;
  const positions = rows.map(q => {
    const a = agg[q.symbol] || {};
    const avgCost = a.qty ? a.costTotal / a.qty : 0;
    if (!q || !q.ok || q.price == null) {
      sumCost += a.costTotal || 0;
      return { symbol: q && q.symbol, name: '', qty: a.qty || 0, avgCost: rnd(avgCost), costTotal: rnd(a.costTotal), ok: false };
    }
    const price = q.livePrice != null ? q.livePrice : q.price;
    const value = price * a.qty;
    const pl = value - a.costTotal;
    const plPct = a.costTotal > 0 ? (pl / a.costTotal * 100) : 0;
    // เปลี่ยนวันนี้: ใช้ราคาล่าสุด vs prevClose (regularClose) ของวันก่อน
    const prev = q.prevClose != null ? q.prevClose : (q.closes && q.closes.length >= 2 ? q.closes[q.closes.length - 2] : null);
    const dayChgPct = prev ? ((price - prev) / prev * 100) : null;
    const dayPL = prev ? (price - prev) * a.qty : 0;
    sumCost += a.costTotal;
    sumVal += value;
    sumDay += dayPL;
    return {
      symbol: q.symbol, name: q.name || q.symbol, qty: a.qty,
      avgCost: rnd(avgCost), costTotal: rnd(a.costTotal),
      price: rnd(price), phase: q.phase || 'regular',
      value: rnd(value), pl: rnd(pl), plPct: rnd(plPct),
      dayChgPct: rnd(dayChgPct), dayPL: rnd(dayPL),
      weight: 0,  // เติมหลังรู้ sumVal
      ok: true,
    };
  });
  positions.forEach(p => { if (p.ok && sumVal > 0) p.weight = +(p.value / sumVal * 100).toFixed(2); });
  positions.sort((a, b) => (b.value || 0) - (a.value || 0));
  return {
    updated: new Date().toISOString(),
    count: positions.filter(p => p.ok).length,
    source: 'Yahoo Finance via Cloudflare Worker',
    summary: {
      cost: rnd(sumCost), value: rnd(sumVal),
      pl: rnd(sumVal - sumCost),
      plPct: sumCost > 0 ? rnd((sumVal - sumCost) / sumCost * 100) : 0,
      dayPL: rnd(sumDay),
    },
    positions,
  };
}

// /api/portfolio — JSON
async function handlePortfolioJson(env) {
  const d = await computePortfolio(env);
  return new Response(JSON.stringify(d, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// /api/catalysts — รายการ catalyst ใกล้: งบรายตัว (จาก KV earnings ที่ cron warm ทุกตัว) + FOMC/econ events
// ให้ Apps Script ดึงไปเขียน Sheet → ปฏิทิน catalyst อัปเดตเองไม่ต้องแก้มือ
async function handleCatalysts(env, horizon = 180) {
  let watch = [];
  try { const raw = await env.WATCHLIST.get('main'); if (raw) watch = JSON.parse(raw); } catch (e) {}
  const events = [];
  await Promise.all((watch || []).filter(w => w && w.symbol).map(async w => {
    const sym = String(w.symbol).toUpperCase();
    const e = await fetchEarningsReadOnly(env, sym).catch(() => null);
    if (e && e.date && e.daysUntil != null && e.daysUntil >= 0 && e.daysUntil <= horizon)
      events.push({ type: 'earnings', symbol: sym, name: w.name || sym, date: e.date, daysUntil: e.daysUntil, impact: 'med' });
  }));
  econEventsSoon(horizon).forEach(ev => events.push({ type: 'fomc', symbol: '', name: ev.name, date: ev.date, daysUntil: ev.daysUntil, impact: ev.impact }));
  events.sort((a, b) => a.daysUntil - b.daysUntil);
  return new Response(JSON.stringify({ updated: new Date().toISOString(), horizonDays: horizon, count: events.length, events }, null, 2),
    { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// /portfolio — หน้า HTML สรุปพอร์ต (ดู/ก๊อปได้ในเบราว์เซอร์ + ให้ AI browse)
async function handlePortfolio(env) {
  const d = await computePortfolio(env);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const s = d.summary;
  const plCol = (s.pl || 0) >= 0 ? '#16a34a' : '#dc2626';
  const dayCol = (s.dayPL || 0) >= 0 ? '#16a34a' : '#dc2626';
  const rowsHtml = d.positions.map(p => {
    if (!p.ok) {
      return `<tr><td><b>${esc(p.symbol)}</b></td><td class=num>${qtyFmt(p.qty)}</td><td class=num>${f(p.avgCost)}</td>
        <td class=num colspan=6 style="color:#999">— ดึงราคาไม่ได้ —</td></tr>`;
    }
    const c1 = (p.pl || 0) >= 0 ? '#16a34a' : '#dc2626';
    const c2 = (p.dayChgPct || 0) >= 0 ? '#16a34a' : '#dc2626';
    const ph = p.phase === 'pre' ? ' [ก่อนเปิด]' : p.phase === 'post' ? ' [หลังปิด]' : '';
    return `<tr><td><b>${esc(p.symbol)}</b><br><span class=n>${esc(p.name)}</span></td>
      <td class=num>${qtyFmt(p.qty)}</td>
      <td class=num>${f(p.avgCost)}</td>
      <td class=num>$${f(p.price)}<span class=n>${esc(ph)}</span></td>
      <td class=num>$${f(p.value, 0)}</td>
      <td class=num style="color:${c2}">${p.dayChgPct >= 0 ? '+' : ''}${f(p.dayChgPct)}%</td>
      <td class=num style="color:${c2}">${p.dayPL >= 0 ? '+' : ''}$${f(p.dayPL, 0)}</td>
      <td class=num style="color:${c1}"><b>${p.pl >= 0 ? '+' : ''}$${f(p.pl, 0)}</b></td>
      <td class=num style="color:${c1}">${p.plPct >= 0 ? '+' : ''}${f(p.plPct)}%</td>
      <td class=num>${f(p.weight)}%</td></tr>`;
  }).join('');
  const lines = d.positions.filter(p => p.ok).map(p =>
    `${p.symbol} (${p.name}): ถือ ${qtyFmt(p.qty)} หุ้น @ ต้นทุน ${f(p.avgCost)} · ราคา ${f(p.price)} · มูลค่า ${f(p.value, 0)} · กำไร/ขาดทุน ${p.pl >= 0 ? '+' : ''}${f(p.pl, 0)} (${p.plPct >= 0 ? '+' : ''}${f(p.plPct)}%) · วันนี้ ${p.dayPL >= 0 ? '+' : ''}${f(p.dayPL, 0)} (${p.dayChgPct >= 0 ? '+' : ''}${f(p.dayChgPct)}%) · สัดส่วน ${f(p.weight)}%`
  );
  const summaryLine = `รวม: มูลค่าพอร์ต $${f(s.value, 0)} · ต้นทุน $${f(s.cost, 0)} · กำไร/ขาดทุน ${s.pl >= 0 ? '+' : ''}$${f(s.pl, 0)} (${s.plPct >= 0 ? '+' : ''}${f(s.plPct)}%) · วันนี้ ${s.dayPL >= 0 ? '+' : ''}$${f(s.dayPL, 0)}`;
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Portfolio Summary — ${esc(d.count)} หุ้น</title>
<meta name=description content="สรุปพอร์ตหุ้น มูลค่า ต้นทุน กำไรขาดทุน รายตัว + รวม อัปเดต ${esc(tm)}">
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:1100px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:10px 0 16px}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;background:#fafafa}
.kpi .lab{font-size:12px;color:#666}.kpi .val{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#888;font-size:11px}
.note{color:#777;font-size:12px;margin-top:14px}.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:18px;border-top:1px solid #eee;padding-top:10px}</style></head>
<body>
<h1>💼 Portfolio Summary</h1>
<div class=sub>${esc(d.count)} หุ้น · อัปเดต ${esc(tm)} (เวลาไทย) · แหล่งข้อมูล Yahoo Finance</div>
<div class=kpis>
  <div class=kpi><div class=lab>มูลค่าพอร์ต</div><div class=val>$${f(s.value, 0)}</div></div>
  <div class=kpi><div class=lab>ต้นทุนรวม</div><div class=val>$${f(s.cost, 0)}</div></div>
  <div class=kpi><div class=lab>กำไร/ขาดทุน</div><div class=val style="color:${plCol}">${s.pl >= 0 ? '+' : ''}$${f(s.pl, 0)} (${s.plPct >= 0 ? '+' : ''}${f(s.plPct)}%)</div></div>
  <div class=kpi><div class=lab>วันนี้</div><div class=val style="color:${dayCol}">${s.dayPL >= 0 ? '+' : ''}$${f(s.dayPL, 0)}</div></div>
</div>
<table><thead><tr><th>หุ้น</th><th class=num>จำนวน</th><th class=num>ต้นทุนเฉลี่ย</th><th class=num>ราคาล่าสุด</th><th class=num>มูลค่า</th><th class=num>เปลี่ยนวันนี้</th><th class=num>P/L วันนี้</th><th class=num>P/L รวม</th><th class=num>P/L%</th><th class=num>สัดส่วน</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan=10 style="text-align:center;color:#888;padding:18px">ยังไม่มีหุ้นในพอร์ต — เพิ่มในหน้า Dashboard</td></tr>'}</tbody></table>
<div class=note>⚠️ ตัวเลขคำนวณจากราคา Yahoo Finance ที่ดึงสด ณ เวลาที่แสดง · ไม่ใช่คำแนะนำการลงทุน</div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(summaryLine)}

${esc(lines.join('\n'))}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// ---------- analytics helpers (สำหรับ /risk, /correlation) ----------
function dailyReturns(arr) {
  const r = [];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1] > 0 && arr[i] != null) r.push((arr[i] - arr[i - 1]) / arr[i - 1]);
  }
  return r;
}
function annualVol(closes, days = 90) {
  if (!closes || closes.length < 11) return null;
  const r = dailyReturns(closes.slice(-Math.min(days, closes.length)));
  if (r.length < 10) return null;
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  const v = r.reduce((x, y) => x + (y - m) * (y - m), 0) / r.length;
  return Math.sqrt(v) * Math.sqrt(252) * 100;  // % annualized
}
function maxDrawdown(closes) {
  if (!closes || closes.length < 2) return 0;
  let peak = closes[0], dd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const cur = (c - peak) / peak;
    if (cur < dd) dd = cur;
  }
  return dd * 100;  // negative %
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return null;
  const xs = x.slice(-n), ys = y.slice(-n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? null : num / denom;
}

// ดึง positions + closes/price พร้อมกัน (ใช้ร่วม /risk, /correlation)
async function getPortfolioBase(env) {
  let arr = [];
  try { const raw = await env.WATCHLIST.get('positions'); if (raw) arr = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(arr)) arr = [];
  const agg = {};
  arr.forEach(p => {
    if (!p || !p.symbol) return;
    const sym = String(p.symbol).toUpperCase();
    const qty = +p.qty || 0, cost = +p.cost || 0;
    if (qty <= 0) return;
    if (!agg[sym]) agg[sym] = { qty: 0, costTotal: 0 };
    agg[sym].qty += qty; agg[sym].costTotal += cost * qty;
  });
  const symbols = Object.keys(agg);
  if (symbols.length === 0) return { symbols: [], holdings: [], byName: {} };
  const rows = await Promise.all(symbols.map(s => yahooDaily(s, '1y', '1d').catch(() => null)));
  const holdings = [];
  const byName = {};
  symbols.forEach((s, i) => {
    const q = rows[i];
    const a = agg[s];
    if (q && q.ok) {
      const value = q.price * a.qty;
      holdings.push({ symbol: s, name: q.name || s, qty: a.qty, costTotal: a.costTotal, price: q.price, value, closes: q.closes || [], ok: true });
      byName[s] = q.name || s;
    } else {
      holdings.push({ symbol: s, name: s, qty: a.qty, costTotal: a.costTotal, ok: false });
    }
  });
  return { symbols, holdings, byName };
}

// ---------- /risk ----------
async function computeRisk(env) {
  const base = await getPortfolioBase(env);
  const ok = base.holdings.filter(h => h.ok);
  if (ok.length === 0) return { updated: new Date().toISOString(), count: 0, holdings: [], summary: {} };
  const totalVal = ok.reduce((s, h) => s + h.value, 0);
  const items = ok.map(h => {
    const vol = annualVol(h.closes, 90);
    const dd = maxDrawdown(h.closes);
    const weight = totalVal > 0 ? (h.value / totalVal * 100) : 0;
    return { symbol: h.symbol, name: h.name, value: h.value, weight, vol90d: vol, maxDD1y: dd };
  });
  items.sort((a, b) => b.weight - a.weight);
  // concentration
  const top = items[0] ? items[0].weight : 0;
  const top3 = items.slice(0, 3).reduce((s, x) => s + x.weight, 0);
  const top5 = items.slice(0, 5).reduce((s, x) => s + x.weight, 0);
  const hhi = items.reduce((s, x) => s + Math.pow(x.weight / 100, 2), 0);  // 0-1
  // portfolio volatility (ประมาณ: zero-correlation upper bound vs equal-cor 0.5 estimate)
  let sumW2V2 = 0, sumWV = 0;
  items.forEach(x => { if (x.vol90d != null) { const w = x.weight / 100; sumW2V2 += w * w * x.vol90d * x.vol90d; sumWV += w * x.vol90d; } });
  const volLow = Math.sqrt(sumW2V2);             // assume cor = 0
  const volMid = Math.sqrt(0.5 * sumWV * sumWV + 0.5 * sumW2V2);  // assume cor ≈ 0.5
  const volHigh = sumWV;                          // assume cor = 1
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  return {
    updated: new Date().toISOString(),
    count: items.length,
    summary: {
      totalValue: rnd(totalVal),
      topWeight: rnd(top), top3Weight: rnd(top3), top5Weight: rnd(top5),
      hhi: rnd(hhi, 4),
      concentrationLevel: top > 40 ? 'สูงมาก' : top > 25 ? 'สูง' : top > 15 ? 'ปานกลาง' : 'ต่ำ',
      portfolioVolLow: rnd(volLow), portfolioVolMid: rnd(volMid), portfolioVolHigh: rnd(volHigh),
    },
    holdings: items.map(x => ({ ...x, value: rnd(x.value), weight: rnd(x.weight), vol90d: rnd(x.vol90d), maxDD1y: rnd(x.maxDD1y) })),
  };
}
async function handleRiskJson(env) {
  const d = await computeRisk(env);
  return new Response(JSON.stringify(d, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function handleRisk(env) {
  const d = await computeRisk(env);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const s = d.summary || {};
  const concCol = s.topWeight > 40 ? '#dc2626' : s.topWeight > 25 ? '#ea580c' : s.topWeight > 15 ? '#ca8a04' : '#16a34a';
  const rowsHtml = (d.holdings || []).map(h => {
    const volCol = (h.vol90d || 0) > 40 ? '#dc2626' : (h.vol90d || 0) > 25 ? '#ea580c' : '#16a34a';
    return `<tr><td><b>${esc(h.symbol)}</b><br><span class=n>${esc(h.name)}</span></td>
      <td class=num>$${f(h.value, 0)}</td>
      <td class=num>${f(h.weight)}%</td>
      <td class=num style="color:${volCol}">${f(h.vol90d)}%</td>
      <td class=num style="color:#dc2626">${f(h.maxDD1y)}%</td></tr>`;
  }).join('');
  const txt = `รวม: มูลค่า $${f(s.totalValue, 0)} · กระจุกตัวที่หุ้นใหญ่สุด ${f(s.topWeight)}% (${esc(s.concentrationLevel)}) · Top3 ${f(s.top3Weight)}% · Top5 ${f(s.top5Weight)}% · HHI ${f(s.hhi, 4)}\nความผันผวนพอร์ตประมาณ ${f(s.portfolioVolLow)}–${f(s.portfolioVolHigh)}% ต่อปี (กรณีกลาง ${f(s.portfolioVolMid)}%) · ขึ้นกับ correlation จริงระหว่างหุ้น (ดู /correlation)`;
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Risk Analysis — Portfolio</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:1000px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:10px 0 16px}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;background:#fafafa}
.kpi .lab{font-size:12px;color:#666}.kpi .val{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#888;font-size:11px}
.note{color:#777;font-size:12px;margin-top:14px}.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:18px;border-top:1px solid #eee;padding-top:10px}</style></head>
<body>
<h1>⚠️ Risk Analysis</h1>
<div class=sub>${esc(d.count)} หุ้น · อัปเดต ${esc(tm)} (เวลาไทย) · ความเสี่ยงพอร์ต = กระจุกตัว + ความผันผวน + ขาดทุนสูงสุด</div>
<div class=kpis>
  <div class=kpi><div class=lab>กระจุกตัวสูงสุด</div><div class=val style="color:${concCol}">${f(s.topWeight)}% (${esc(s.concentrationLevel || '')})</div></div>
  <div class=kpi><div class=lab>Top 3 รวม</div><div class=val>${f(s.top3Weight)}%</div></div>
  <div class=kpi><div class=lab>Top 5 รวม</div><div class=val>${f(s.top5Weight)}%</div></div>
  <div class=kpi><div class=lab>HHI</div><div class=val>${f(s.hhi, 4)}</div></div>
  <div class=kpi><div class=lab>ความผันผวนพอร์ต/ปี</div><div class=val>${f(s.portfolioVolLow)}–${f(s.portfolioVolHigh)}%</div></div>
</div>
<table><thead><tr><th>หุ้น</th><th class=num>มูลค่า</th><th class=num>สัดส่วน</th><th class=num>Vol 90d (ปีลิซ)</th><th class=num>Max DD 1y</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan=5 style="text-align:center;color:#888;padding:18px">ยังไม่มีหุ้นในพอร์ต</td></tr>'}</tbody></table>
<div class=note>⚠️ ความผันผวนคำนวณจาก daily returns 90 วันล่าสุด (annualized) · Max DD คือ peak-to-trough สูงสุดในรอบ 1 ปี · HHI &gt; 0.25 = กระจุกตัวสูง · ไม่ใช่คำแนะนำการลงทุน</div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(txt)}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------- /correlation ----------
async function computeCorrelation(env) {
  const base = await getPortfolioBase(env);
  const ok = base.holdings.filter(h => h.ok && h.closes && h.closes.length >= 30);
  if (ok.length < 2) return { updated: new Date().toISOString(), count: ok.length, matrix: [], pairs: [], avg: null, note: ok.length < 2 ? 'ต้องมีหุ้นอย่างน้อย 2 ตัวที่มีข้อมูลพอ' : null };
  // returns array ของแต่ละหุ้น (60 วันล่าสุด)
  const rets = ok.map(h => dailyReturns(h.closes.slice(-61)));
  const n = ok.length;
  const matrix = [];
  const pairs = [];
  let sumCor = 0, cntCor = 0;
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (i === j) { row.push(1); continue; }
      const c = pearson(rets[i], rets[j]);
      row.push(c);
      if (j > i && c != null) { pairs.push({ a: ok[i].symbol, b: ok[j].symbol, cor: c }); sumCor += c; cntCor++; }
    }
    matrix.push({ symbol: ok[i].symbol, row });
  }
  pairs.sort((a, b) => Math.abs(b.cor) - Math.abs(a.cor));
  const avg = cntCor > 0 ? sumCor / cntCor : null;
  const rnd = (x, d = 3) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  return {
    updated: new Date().toISOString(),
    count: n,
    period: 'last 60 trading days',
    avg: rnd(avg),
    diversification: avg == null ? null : avg > 0.7 ? 'กระจายต่ำ (correlated หนัก)' : avg > 0.4 ? 'กระจายปานกลาง' : avg > 0.1 ? 'กระจายดี' : 'กระจายดีมาก',
    pairs: pairs.map(p => ({ a: p.a, b: p.b, cor: rnd(p.cor) })),
    matrix: matrix.map(r => ({ symbol: r.symbol, row: r.row.map(v => rnd(v)) })),
  };
}
async function handleCorrelationJson(env) {
  const d = await computeCorrelation(env);
  return new Response(JSON.stringify(d, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function handleCorrelation(env) {
  const d = await computeCorrelation(env);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  // matrix HTML with color heatmap
  const syms = (d.matrix || []).map(r => r.symbol);
  const cellCol = v => {
    if (v == null) return '#f3f4f6';
    if (v >= 0.7) return '#fca5a5';
    if (v >= 0.4) return '#fed7aa';
    if (v >= 0.1) return '#fef3c7';
    if (v >= -0.1) return '#f3f4f6';
    if (v >= -0.4) return '#bfdbfe';
    return '#93c5fd';
  };
  const head = `<tr><th></th>${syms.map(s => `<th>${esc(s)}</th>`).join('')}</tr>`;
  const rows = (d.matrix || []).map(r =>
    `<tr><th>${esc(r.symbol)}</th>${r.row.map(v => `<td class=num style="background:${cellCol(v)}">${v == null ? '—' : f(v, 2)}</td>`).join('')}</tr>`
  ).join('');
  const pairsTop = (d.pairs || []).slice(0, 15);
  const pairsHtml = pairsTop.map(p => `<tr><td>${esc(p.a)} ↔ ${esc(p.b)}</td><td class=num style="background:${cellCol(p.cor)}">${f(p.cor, 3)}</td></tr>`).join('');
  const txt = `เฉลี่ย correlation ${f(d.avg, 3)} · ${esc(d.diversification || '—')}\n` +
    'คู่ที่สัมพันธ์สูงสุด:\n' + pairsTop.slice(0, 5).map(p => `  ${p.a} ↔ ${p.b}: ${f(p.cor, 3)}`).join('\n');
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Correlation Matrix — Portfolio</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:1100px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:10px 0 16px}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;background:#fafafa}
.kpi .lab{font-size:12px;color:#666}.kpi .val{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:auto;font-size:12.5px;margin-bottom:18px}th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:center}
th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}
h3{font-size:15px;margin:20px 0 6px}
.legend{font-size:12px;color:#666;margin:6px 0 14px}.legend span{display:inline-block;padding:2px 8px;margin-right:4px;border:1px solid #e5e7eb}
.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:18px;border-top:1px solid #eee;padding-top:10px}
.note{color:#777;font-size:12px;margin-top:6px}</style></head>
<body>
<h1>🔗 Correlation Matrix</h1>
<div class=sub>${esc(d.count)} หุ้น · ${esc(d.period || '')} · อัปเดต ${esc(tm)}</div>
<div class=kpis>
  <div class=kpi><div class=lab>เฉลี่ย correlation</div><div class=val>${f(d.avg, 3)}</div></div>
  <div class=kpi><div class=lab>การกระจายความเสี่ยง</div><div class=val>${esc(d.diversification || '—')}</div></div>
</div>
<div class=legend><b>โทนสี:</b>
  <span style="background:#93c5fd">≤ -0.4</span>
  <span style="background:#bfdbfe">-0.4 ถึง -0.1</span>
  <span style="background:#f3f4f6">-0.1 ถึง 0.1</span>
  <span style="background:#fef3c7">0.1 ถึง 0.4</span>
  <span style="background:#fed7aa">0.4 ถึง 0.7</span>
  <span style="background:#fca5a5">≥ 0.7 (correlated สูง)</span>
</div>
<h3>Matrix</h3>
<div style="overflow-x:auto"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>
<h3>คู่หุ้นที่สัมพันธ์สูงสุด (Top 15)</h3>
<table style="width:100%"><thead><tr><th style="text-align:left">คู่</th><th class=num>Correlation</th></tr></thead>
<tbody>${pairsHtml || '<tr><td colspan=2 style="color:#888">ไม่มีข้อมูลพอ</td></tr>'}</tbody></table>
<div class=note>⚠️ คำนวณ Pearson correlation จาก daily returns 60 วันล่าสุด · ค่าสูง = ขึ้น/ลงพร้อมกัน (กระจายความเสี่ยงได้น้อย) · ค่าติดลบ = วิ่งสวนทาง (hedge กัน) · ไม่ใช่คำแนะนำการลงทุน</div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(txt)}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------- /dividend ----------
async function yahooDividend(symbol) {
  for (const h of YHOSTS) {
    try {
      const res = await fetch(`${h}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div`, {
        headers: { 'User-Agent': UA },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) continue;
      const divs = (r.events && r.events.dividends) || {};
      const list = Object.values(divs).map(d => ({ amount: +d.amount || 0, date: +d.date || 0 })).sort((a, b) => a.date - b.date);
      const m = r.meta || {};
      const price = m.regularMarketPrice;
      const cutoff = Date.now() / 1000 - 365 * 86400;
      const ttm = list.filter(d => d.date >= cutoff);
      const ttmAmount = ttm.reduce((s, d) => s + d.amount, 0);
      const yldPct = price && ttmAmount > 0 ? (ttmAmount / price * 100) : 0;
      const last = list[list.length - 1] || null;
      const freq = ttm.length >= 10 ? 'monthly' : ttm.length >= 3 ? 'quarterly' : ttm.length >= 2 ? 'semi-annual' : ttm.length === 1 ? 'annual' : 'none';
      return { symbol, price, name: m.longName || m.shortName || symbol, ttmAmount, yieldPct: yldPct, lastDate: last ? last.date : null, lastAmount: last ? last.amount : null, frequency: freq, ttmCount: ttm.length };
    } catch (e) {}
  }
  return { symbol, ttmAmount: 0, yieldPct: 0, frequency: 'none', ttmCount: 0 };
}
async function computeDividend(env) {
  let arr = [];
  try { const raw = await env.WATCHLIST.get('positions'); if (raw) arr = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(arr)) arr = [];
  const agg = {};
  arr.forEach(p => {
    if (!p || !p.symbol) return;
    const sym = String(p.symbol).toUpperCase();
    const qty = +p.qty || 0;
    if (qty <= 0) return;
    if (!agg[sym]) agg[sym] = 0;
    agg[sym] += qty;
  });
  const symbols = Object.keys(agg);
  if (symbols.length === 0) return { updated: new Date().toISOString(), count: 0, holdings: [], summary: { annualIncome: 0, portfolioYield: 0, monthlyAvg: 0 } };
  const rows = await Promise.all(symbols.map(s => yahooDividend(s)));
  let totalIncome = 0, totalValue = 0, payerCount = 0;
  const items = rows.map(r => {
    const qty = agg[r.symbol] || 0;
    const annualIncome = (r.ttmAmount || 0) * qty;
    const value = (r.price || 0) * qty;
    totalIncome += annualIncome;
    totalValue += value;
    if ((r.ttmAmount || 0) > 0) payerCount++;
    return {
      symbol: r.symbol, name: r.name || r.symbol,
      qty, price: r.price, value,
      divPerShare: r.ttmAmount, yieldPct: r.yieldPct,
      annualIncome,
      frequency: r.frequency,
      lastDate: r.lastDate, lastAmount: r.lastAmount,
      payer: (r.ttmAmount || 0) > 0,
    };
  });
  items.sort((a, b) => b.annualIncome - a.annualIncome);
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  return {
    updated: new Date().toISOString(),
    count: items.length,
    summary: {
      annualIncome: rnd(totalIncome),
      monthlyAvg: rnd(totalIncome / 12),
      portfolioYield: totalValue > 0 ? rnd(totalIncome / totalValue * 100) : 0,
      payerCount, nonPayerCount: items.length - payerCount,
      totalValue: rnd(totalValue),
    },
    holdings: items.map(x => ({
      ...x,
      price: rnd(x.price), value: rnd(x.value),
      divPerShare: rnd(x.divPerShare, 4),
      yieldPct: rnd(x.yieldPct),
      annualIncome: rnd(x.annualIncome),
      lastAmount: rnd(x.lastAmount, 4),
      lastDateISO: x.lastDate ? new Date(x.lastDate * 1000).toISOString().slice(0, 10) : null,
    })),
  };
}
async function handleDividendJson(env) {
  const d = await computeDividend(env);
  return new Response(JSON.stringify(d, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function handleDividend(env) {
  const d = await computeDividend(env);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const s = d.summary || {};
  const freqTH = { monthly: 'ทุกเดือน', quarterly: 'รายไตรมาส', 'semi-annual': 'ครึ่งปี', annual: 'รายปี', none: '—' };
  const rowsHtml = (d.holdings || []).map(h => {
    const lastDateStr = h.lastDateISO || '—';
    return `<tr><td><b>${esc(h.symbol)}</b><br><span class=n>${esc(h.name)}</span></td>
      <td class=num>${qtyFmt(h.qty)}</td>
      <td class=num>$${f(h.divPerShare, 4)}/ปี</td>
      <td class=num>${f(h.yieldPct)}%</td>
      <td>${esc(freqTH[h.frequency] || h.frequency || '—')}</td>
      <td class=num>${esc(lastDateStr)} · $${f(h.lastAmount, 4)}</td>
      <td class=num style="font-weight:600">$${f(h.annualIncome, 2)}</td></tr>`;
  }).join('');
  const txt = `รายได้ปันผลต่อปีโดยประมาณ $${f(s.annualIncome, 2)} · เฉลี่ยเดือนละ $${f(s.monthlyAvg, 2)} · Yield พอร์ต ${f(s.portfolioYield)}%\nหุ้นจ่ายปันผล ${s.payerCount}/${d.count} ตัว`;
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Dividend Income — Portfolio</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:1050px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:10px 0 16px}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;background:#fafafa}
.kpi .lab{font-size:12px;color:#666}.kpi .val{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#888;font-size:11px}
.note{color:#777;font-size:12px;margin-top:14px}.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:18px;border-top:1px solid #eee;padding-top:10px}</style></head>
<body>
<h1>💰 Dividend Income</h1>
<div class=sub>${esc(d.count)} หุ้น · อัปเดต ${esc(tm)} (เวลาไทย) · คำนวณจากปันผลที่จ่ายจริงในรอบ 12 เดือน</div>
<div class=kpis>
  <div class=kpi><div class=lab>รายได้ปันผล/ปี</div><div class=val style="color:#16a34a">$${f(s.annualIncome, 2)}</div></div>
  <div class=kpi><div class=lab>เฉลี่ย/เดือน</div><div class=val>$${f(s.monthlyAvg, 2)}</div></div>
  <div class=kpi><div class=lab>Yield พอร์ต</div><div class=val>${f(s.portfolioYield)}%</div></div>
  <div class=kpi><div class=lab>หุ้นจ่ายปันผล</div><div class=val>${esc(s.payerCount)}/${esc(d.count)}</div></div>
</div>
<table><thead><tr><th>หุ้น</th><th class=num>จำนวน</th><th class=num>ปันผล/หุ้น (TTM)</th><th class=num>Yield</th><th>ความถี่</th><th class=num>จ่ายล่าสุด</th><th class=num>รายได้/ปี</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan=7 style="text-align:center;color:#888;padding:18px">ยังไม่มีหุ้นในพอร์ต</td></tr>'}</tbody></table>
<div class=note>⚠️ ตัวเลขปันผลคำนวณจากเงินสดที่จ่ายจริงในรอบ 12 เดือน (TTM) ไม่ใช่ forward yield · บริษัทอาจปรับ/ยกเลิกปันผลในอนาคต · ไม่ใช่คำแนะนำการลงทุน</div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(txt)}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// /report — หน้า HTML อ่านง่าย (server-rendered) ให้ Gemini/เบราว์เซอร์ browse ได้ (Gemini ดึง JSON ดิบไม่ค่อยได้)
async function handleReport(env) {
  const [d, market, port] = await Promise.all([
    computeWatchlistData(env),
    fetchMarketBar().catch(() => []),
    computePortfolio(env).catch(() => null),
  ]);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const vfmt = v => v == null ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const ok = d.stocks.filter(s => s.ok);
  // MARKET bar HTML
  const mk = (market || []).filter(m => m.ok);
  const marketHtml = mk.length ? `<div class=market>${mk.map(m => {
    const c = (m.chgPct || 0) >= 0 ? '#16a34a' : '#dc2626';
    return `<span class=mi><b>${esc(m.label)}</b> ${f(m.price, m.label === 'VIX' ? 2 : 0)} <span style="color:${c}">${m.chgPct >= 0 ? '+' : ''}${f(m.chgPct)}%</span></span>`;
  }).join('')}</div>` : '';
  // P/L พอร์ต HTML
  let portHtml = '';
  if (port && port.count > 0) {
    const ps = port.summary;
    const plC = (ps.pl || 0) >= 0 ? '#16a34a' : '#dc2626';
    const dayC = (ps.dayPL || 0) >= 0 ? '#16a34a' : '#dc2626';
    portHtml = `<div class=port><b>💼 พอร์ตที่ถือ (${esc(port.count)} ตัว):</b>
      มูลค่า $${f(ps.value, 0)} · ต้นทุน $${f(ps.cost, 0)} ·
      <span style="color:${plC}">รวม ${ps.pl >= 0 ? '+' : ''}$${f(ps.pl, 0)} (${ps.plPct >= 0 ? '+' : ''}${f(ps.plPct)}%)</span> ·
      <span style="color:${dayC}">วันนี้ ${ps.dayPL >= 0 ? '+' : ''}$${f(ps.dayPL, 0)}</span></div>`;
  }
  // บรรทัดสรุปข้อความ (อ่านเป็น text ได้ดี — เผื่อ AI สรุปจากเนื้อหา)
  const lines = ok.map(s => `${s.symbol} (${esc(s.name)}): ราคา $${f(s.price)} เปลี่ยน ${s.changePct >= 0 ? '+' : ''}${f(s.changePct)}% · RSI วัน ${f(s.rsi, 1)}/สัปดาห์ ${f(s.rsiWeekly, 1)} · MACD ${f(s.macdHist, 3)} · EMA50 ${f(s.ema50)} EMA200 ${f(s.ema200)} · Vol ${vfmt(s.volume)}${s.volRatio != null ? ' (' + f(s.volRatio) + 'x)' : ''} · CMF ${f(s.cmf, 3)} · RS ${s.rsVsSpx >= 0 ? '+' : ''}${f(s.rsVsSpx)}% · 52W ${f(s.week52Low)}–${f(s.week52High)} (จากสูงสุด ${f(s.pctFrom52High)}%) · สัญญาณ ${s.signal} · Entry ${f(s.entry)}/SL ${f(s.sl)}/TP ${f(s.tp)}`);
  const portLine = (port && port.count > 0) ? `\nพอร์ต: มูลค่า $${f(port.summary.value, 0)} ต้นทุน $${f(port.summary.cost, 0)} กำไร/ขาดทุน ${port.summary.pl >= 0 ? '+' : ''}$${f(port.summary.pl, 0)} (${port.summary.plPct >= 0 ? '+' : ''}${f(port.summary.plPct)}%) วันนี้ ${port.summary.dayPL >= 0 ? '+' : ''}$${f(port.summary.dayPL, 0)}` : '';
  const rowsHtml = ok.map(s => {
    const col = s.signal === 'BUY' ? '#16a34a' : s.signal === 'SELL' ? '#dc2626' : '#9ca3af';
    const chgCol = (s.changePct || 0) >= 0 ? '#16a34a' : '#dc2626';
    const volCol = (s.volRatio || 0) >= 1.5 ? '#ea580c' : '#111';
    const hiCol = (s.pctFrom52High || 0) >= -3 ? '#16a34a' : '#111';
    return `<tr><td><b>${esc(s.symbol)}</b><br><span class=n>${esc(s.name)}</span></td>
      <td class=num>$${f(s.price)}</td>
      <td class=num style="color:${chgCol}">${s.changePct >= 0 ? '+' : ''}${f(s.changePct)}%</td>
      <td class=num>${f(s.rsi, 1)}</td>
      <td class="num hide-sm">${f(s.rsiWeekly, 1)}</td>
      <td class=num>${f(s.macdHist, 3)}</td>
      <td class=num>${f(s.ema50)}</td>
      <td class="num hide-sm">${f(s.ema200)}</td>
      <td class="num hide-sm" style="color:${volCol}">${vfmt(s.volume)}${s.volRatio != null ? '<br><span class=n>' + f(s.volRatio) + 'x</span>' : ''}</td>
      <td class="num hide-sm">${f(s.week52Low)}–${f(s.week52High)}<br><span class=n style="color:${hiCol}">${f(s.pctFrom52High)}%</span></td>
      <td><b style="color:${col}">${s.signal}</b></td>
      <td class=num>${f(s.entry)} / ${f(s.sl)} / ${f(s.tp)}</td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Stock Watchlist Report — ${esc(d.count)} หุ้น</title>
<meta name=description content="ข้อมูลหุ้น watchlist + อินดิเคเตอร์ (RSI วัน/สัปดาห์, EMA/MACD/Bollinger, Volume, 52สัปดาห์) + สัญญาณ + P/L พอร์ต + ตลาดรวม อัปเดต ${esc(tm)}">
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:1100px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:10px}
.market{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;padding:8px 10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:10px}
.port{font-size:13px;padding:8px 10px;background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;margin-bottom:14px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#888;font-size:11px}
.note{color:#777;font-size:12px;margin-top:14px}.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:18px;border-top:1px solid #eee;padding-top:10px}
@media(max-width:720px){.hide-sm{display:none}}</style></head>
<body>
<h1>📊 Stock Watchlist Report</h1>
<div class=sub>เฝ้า ${esc(d.count)} หุ้น · อัปเดต ${esc(tm)} (เวลาไทย) · แหล่งข้อมูล Yahoo Finance</div>
${marketHtml}
${portHtml}
<table><thead><tr><th>หุ้น</th><th class=num>ราคา</th><th class=num>เปลี่ยน</th><th class=num>RSI</th><th class="num hide-sm">RSI สัปดาห์</th><th class=num>MACD</th><th class=num>EMA50</th><th class="num hide-sm">EMA200</th><th class="num hide-sm">Volume</th><th class="num hide-sm">52 สัปดาห์</th><th>สัญญาณ</th><th class=num>Entry/SL/TP</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
<div class=note>⚠️ "สัญญาณ" เป็นคะแนนกฎเทคนิคอล (RSI/EMA/MACD/Bollinger/ROC) — ไม่ใช่คำแนะนำการลงทุน · RSI สัปดาห์ resample จากราคารายวัน · Volume แสดงค่าล่าสุด + เท่าของค่าเฉลี่ย 20 วัน</div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(lines.join('\n'))}${esc(portLine)}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// /csv — ออกทุกค่าอินดิเคเตอร์เป็น CSV ให้ Google Sheet ดึงด้วย =IMPORTDATA("...") + Gemini อ่านง่าย
// /csv — ตารางครบชุดเท่าระบบ thesis จริง (1 แถว/หุ้น) สำหรับ Google Sheet → Gemini Gem
// merge: indicator เต็ม (computeWatchlistData) + conviction/stance/reason/earnings (computeDecision) + จำนวนถือ (computePortfolio)
async function handleCsv(env) {
  const [d, dec, port] = await Promise.all([
    computeWatchlistData(env, { cached: true }),
    computeDecision(env).catch(() => null),
    computePortfolio(env).catch(() => null),
  ]);
  // map ข้อมูลจาก decision ต่อ symbol (conviction/stance/reason/signal/earnings)
  const decMap = {};
  if (dec) [...(dec.candidates || []), ...(dec.core || [])].forEach(c => { if (c && c.symbol) decMap[String(c.symbol).toUpperCase()] = c; });
  // map จำนวนหุ้นที่ถืออยู่จริง
  const heldMap = {};
  if (port && Array.isArray(port.positions)) port.positions.forEach(p => { if (p && p.symbol) heldMap[String(p.symbol).toUpperCase()] = p; });
  const rg = dec && dec.regime ? dec.regime : null;

  const cols = [
    'symbol','name','stance','conviction','signal','reason',
    'held_qty','held_avgCost','held_plPct',
    'price','regularClose','phase','changePct',
    'rsi','rsiWeekly','macdHist','roc10',
    'cmf','rsVsSpx','rs3m','volRatio','volume','volAvg20',
    'ema15','ema30','ema50','ema100','ema200','sma200','bollUpper','bollLower',
    'atr14','slAtr2x','beta1y','corr30','corr60',
    'week52High','week52Low','pctFrom52High','pctFrom52Low',
    'entry','sl','tp','impliedMovePct','earningsInDays','earningsDate',
    'regime','buyThresh',
  ];
  const esc = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = cols.join(',');
  const rows = d.stocks.filter(s => s.ok).map(s => {
    const dc = decMap[String(s.symbol).toUpperCase()] || {};
    const hd = heldMap[String(s.symbol).toUpperCase()] || {};
    const earn = dc.earnings || null;
    const row = {
      ...s,
      stance: dc.stance, conviction: dc.conviction, signal: dc.signal != null ? dc.signal : s.signal, reason: dc.reason,
      held_qty: hd.qty, held_avgCost: hd.avgCost, held_plPct: hd.plPct,
      impliedMovePct: s.impliedMove && s.impliedMove.pct,
      earningsInDays: earn && earn.daysUntil, earningsDate: earn && earn.date,
      regime: rg ? rg.regime : '', buyThresh: dec ? dec.buyThresh : '',
    };
    return cols.map(c => esc(row[c])).join(',');
  });
  const csv = [head, ...rows].join('\n');
  return new Response(csv, { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}

// เขียนสัญญาณล่าสุดลง KV ('signals') ให้ stock-alerts อ่านใช้ร่วมเป็น single source
// เลี่ยง worker-fetch-worker บน workers.dev เดียวกัน (CF error 1042) — ใช้ KV เป็นสะพานแทน
async function writeSignalsToKV(env) {
  const d = await computeWatchlistData(env);   // สดเต็ม (มี intraday/livePrice)
  // ป้ายต้อง regime-weighted ให้ตรงกับ /api/decide (alerts อ่าน KV นี้ = single source เดียวกับที่หน้าจอแสดง)
  const regime = await getRegime(env).catch(() => null);
  const rg = regime && regime.regime;
  const signals = {};
  for (const s of d.stocks) if (s && s.ok && s.symbol) signals[s.symbol] = labelFromConviction(convictionScore(s, rg).score, rg);
  await env.WATCHLIST.put('signals', JSON.stringify({ updated: d.updated, signals }));
  // cache full data ให้ /decide /api/data อ่านเร็ว (เลี่ยง recompute 44 fetch ทุก request)
  try { await env.WATCHLIST.put('fullData', JSON.stringify(d)); } catch (e) {}
  return signals;
}

// Phase 0.5 — snapshot รายวันลง D1 (เก็บราคา raw + indicator กัน lookahead bias)
// idempotent: UNIQUE(ts_date, symbol) + INSERT OR IGNORE → cron รันซ้ำไม่สร้างแถวซ้ำ
// holiday guard: ข้ามถ้าตลาด US ไม่ได้เทรดวันนี้ (วันหยุด) หรือ Yahoo คืนข้อมูลค้าง — กันแถวราคาซ้ำปน journal
//   ทำให้ computePerformance นับ horizon 5/10/20 "วันทำการ" เพี้ยน + เพิ่ม observation ไม่อิสระ (lookahead-by-holiday)
//   วิธี: เทียบวันที่ของแท่ง SPX ล่าสุด (เวลา ET) กับวันนี้ (ET) — ไม่ตรง = ตลาดไม่ได้เทรดวันนี้ → skip · force=true ข้ามการเช็ค (manual)
async function logDailySnapshot(env, force = false) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1 binding' };
  const d = await computeWatchlistData(env);
  const ok = d.stocks.filter(s => s && s.ok && s.symbol);
  if (!ok.length) return { ok: false, error: 'no stocks' };
  if (!force && d.spxLastBarTs) {
    const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const etLastBar = new Date(d.spxLastBarTs * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (etLastBar !== etToday) {
      // แยก "ตลาดปิดจริง (เสาร์/อาทิตย์/วันหยุด)" จาก "วันธรรมดาแต่ Yahoo ส่งแท่งช้า" — อันหลังคือ false skip ที่ทำ snapshot หาย
      const etDow = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
      const weekday = !['Sat', 'Sun'].includes(etDow);
      return { ok: true, skipped: true, weekday, etToday, etLastBar,
        reason: weekday ? 'stale-on-weekday (Yahoo lag?) — catch-up cron 01:00 UTC จะ retry' : 'market-closed' };
    }
  }
  const tsDate = new Date(d.updated).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD เวลาไทย
  const spxChg = d.spxChangePct != null ? d.spxChangePct : null;
  const spxPrice = d.spxPrice != null ? d.spxPrice : null;
  // regime ณ วันนั้น — ไว้ slice ผลวัด beatRate ตามตลาด (แยก "ชนะตอนขึ้น" จาก "ชนะตอน risk-off") · เก็บไปข้างหน้า
  const regimeInfo = await getRegime(env).catch(() => null);
  const regimeVal = (regimeInfo && regimeInfo.regime) ? regimeInfo.regime : null;
  const stmt = env.JOURNAL.prepare(
    `INSERT OR IGNORE INTO signal_history
     (ts_date, ts_iso, symbol, signal, price, regular_close, rsi, rsi_weekly, macd_hist, cmf, rs_vs_spx, atr14, beta1y, ema50, ema200, sma200, change_pct, spx_change, spx_price, conviction, regime, snapshot_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch = ok.map(s => {
    const cvScore = convictionScore(s, regimeVal).score;   // regime-weighted — สอดคล้องกับ snapshot regime + ป้าย
    return stmt.bind(
      tsDate, d.updated, s.symbol, labelFromConviction(cvScore, regimeVal), s.price, s.regularClose, s.rsi, s.rsiWeekly, s.macdHist,
      s.cmf, s.rsVsSpx, s.atr14, s.beta1y, s.ema50, s.ema200, s.sma200, s.changePct, spxChg, spxPrice,
      cvScore, regimeVal, JSON.stringify(s)
    );
  });
  await env.JOURNAL.batch(batch);
  return { ok: true, date: tsDate, rows: batch.length, via: d.dataVia };
}

// Phase 1 — วัดผลย้อนหลัง: เทียบ snapshot กับ snapshot ในอนาคต H วันทำการ (5/10/20)
// benchmark-relative: excess = ผลตอบแทนหุ้น − ผลตอบแทน S&P500 ช่วงเดียวกัน (ชนะตลาดไหม)
// snapshot-to-snapshot กัน lookahead bias (ใช้ราคา raw ที่เก็บ ณ เวลานั้น ไม่ดึง history ใหม่)
async function computePerformance(env) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  const { results } = await env.JOURNAL.prepare(
    `SELECT ts_date, symbol, signal, price, spx_price, conviction, regime FROM signal_history
     WHERE price IS NOT NULL AND spx_price IS NOT NULL ORDER BY symbol, ts_date`
  ).all();
  const rows = results || [];
  // group ตาม symbol → array เรียงตามวันที่ (snapshot รายวันทำการอยู่แล้ว → index = trading day)
  const bySym = {};
  for (const r of rows) (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
  const HZ = [3, 5, 10, 20];   // h=3 = "early read" (ดูว่า pipeline ทำงาน) · h=5/10/20 = ของจริง · ต้องมี snapshot h+1 วัน
  const COST = 0.1;   // ต้นทุน round-trip โดยประมาณ % (commission+spread+impact) — หักจาก excess เพื่อดู edge สุทธิ
  // ทุก datapoint: {h, sig, ret, exc, regime, conviction} — รวมไว้แล้วค่อย aggregate หลายแบบ
  const recs = [];
  let dataPoints = 0;
  for (const sym of Object.keys(bySym)) {
    const arr = bySym[sym];
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const sig = (a.signal || 'HOLD').toUpperCase();
      if (sig !== 'BUY' && sig !== 'HOLD' && sig !== 'SELL') continue;  // ข้าม signal แปลก
      for (const h of HZ) {
        const b = arr[i + h];
        if (!b || !a.price || !a.spx_price) continue;
        const stockRet = (b.price - a.price) / a.price * 100;
        const spxRet = (b.spx_price - a.spx_price) / a.spx_price * 100;
        recs.push({ h, sig, ret: stockRet, exc: stockRet - spxRet, regime: a.regime || null, conviction: a.conviction });
        dataPoints++;
      }
    }
  }
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // สถิติจากชุด record ที่ filter มาแล้ว
  function stat(set) {
    const n = set.length;
    if (!n) return { n: 0 };
    const rets = set.map(r => r.ret), exc = set.map(r => r.exc), excNet = exc.map(x => x - COST);
    const sd = stdev(exc);
    return {
      n,
      winRate: rnd(rets.filter(x => x > 0).length / n * 100, 1),       // หุ้นบวกกี่%
      beatRate: rnd(exc.filter(x => x > 0).length / n * 100, 1),       // ชนะ SPX กี่% (ก่อนต้นทุน)
      beatRateNet: rnd(excNet.filter(x => x > 0).length / n * 100, 1), // ชนะ SPX หลังหักต้นทุน
      avgReturn: rnd(mean(rets)),
      avgExcess: rnd(mean(exc)),
      avgExcessNet: rnd(mean(excNet)),
      medianExcess: rnd(median(exc)),                  // median ทน outlier กว่า mean (โดยเฉพาะ sample เล็ก)
      medianExcessNet: rnd(median(excNet)),
      infoRatio: sd ? rnd(mean(exc) / sd, 2) : null,   // ส่วนเกินเฉลี่ย / ความผันผวนของส่วนเกิน (risk-adjusted)
    };
  }
  // horizons[h][sig] — backward-compatible (Edge card อ่าน beatRate/avgExcess/n อยู่)
  const horizons = {};
  HZ.forEach(h => { horizons[h] = {}; ['BUY', 'HOLD', 'SELL'].forEach(sig => { horizons[h][sig] = stat(recs.filter(r => r.h === h && r.sig === sig)); }); });
  // byRegime — BUY แยกตาม regime: คำถามหลัก "edge จริง หรือแค่ long beta ตอนตลาดขึ้น"
  const byRegime = {};
  ['risk-on', 'neutral', 'risk-off'].forEach(rg => {
    byRegime[rg] = {};
    HZ.forEach(h => { byRegime[rg][h] = stat(recs.filter(r => r.h === h && r.sig === 'BUY' && r.regime === rg)); });
  });
  // byConviction — BUY แยก tier (สูง ≥67 vs กลาง <67): conviction สูงให้ผลดีกว่าจริงไหม
  const convTier = c => c == null ? null : (c >= 67 ? 'high' : 'mid');
  const byConviction = { high: {}, mid: {} };
  HZ.forEach(h => {
    byConviction.high[h] = stat(recs.filter(r => r.h === h && r.sig === 'BUY' && convTier(r.conviction) === 'high'));
    byConviction.mid[h] = stat(recs.filter(r => r.h === h && r.sig === 'BUY' && convTier(r.conviction) === 'mid'));
  });
  const dates = rows.map(r => r.ts_date);
  const distinctDays = new Set(dates).size;   // วันทำการที่เก็บได้จริง (กัน overlap หลอกว่าข้อมูลเยอะ)
  return {
    ok: true, updated: new Date().toISOString(),
    dataPoints, snapshots: rows.length, symbols: Object.keys(bySym).length, distinctDays,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    costPctAssumed: COST,
    horizons, byRegime, byConviction,
    note: 'benchmark-relative (excess=ชนะ S&P500) · snapshot-to-snapshot กัน lookahead · *Net = หักต้นทุน ' + COST + '% · infoRatio = ส่วนเกิน/ความผันผวน · regime/conviction slice เก็บไปข้างหน้า (แถวเก่า regime=NULL) · ต้องรอข้อมูลหลายเดือนจึงมีนัยสำคัญ',
  };
}

// ============ Phase 2 — DECISION ENGINE (โค้ดล้วน deterministic) ============

// ETF/ดัชนี = core (ถือยาว ไม่ trade ตาม signal) · ที่เหลือ = tactical (เข้า engine เต็ม)
const CORE_SYMBOLS = new Set(['VOO', 'QQQI', 'SMH', 'QQQ', 'SPY', 'VTI', 'SPYI', 'SCHD', 'JEPI', 'JEPQ', 'IVV', 'VUG', 'DIA']);
function isCore(symbol, watchItem) {
  if (watchItem && watchItem.type) return watchItem.type === 'core';
  return CORE_SYMBOLS.has(String(symbol).toUpperCase());
}

// 1) MARKET REGIME — risk-on/neutral/risk-off จาก SPX vs EMA200 + VIX (ข้อมูลที่ดึงได้จริง ไม่ใช้ breadth)
async function computeRegimeRaw() {
  const [spx, vixBar, ndx, hyg, rsp] = await Promise.all([
    yahooDaily('^GSPC', '1y', '1d').catch(() => null),
    yahooDaily('^VIX', '5d', '1d').catch(() => null),
    yahooDaily('^NDX', '1y', '1d').catch(() => null),   // Nasdaq 100
    yahooDaily('HYG', '1y', '1d').catch(() => null),    // high-yield credit — เครดิตเครียด = risk-off นำตลาด
    yahooDaily('RSP', '1y', '1d').catch(() => null),    // S&P equal-weight — breadth proxy (เทียบ ^GSPC cap-weight)
  ]);
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  if (!spx || !spx.ok || !spx.closes || spx.closes.length < 200) return { ok: false };
  const ema200 = ema(spx.closes, 200);
  const price = spx.price;
  const vix = (vixBar && vixBar.ok) ? vixBar.price : null;
  const ndxPrice = (ndx && ndx.ok) ? ndx.price : null;
  const ndxEma200 = (ndx && ndx.ok && ndx.closes && ndx.closes.length >= 200) ? ema(ndx.closes, 200) : null;
  const ndxAbove = (ndxPrice != null && ndxEma200 != null) ? (ndxPrice - ndxEma200) / ndxEma200 * 100 : null;
  const aboveEma = (price != null && ema200 != null) ? (price - ema200) / ema200 * 100 : null;  // % เหนือ/ใต้ EMA200
  // INTERNALS — credit + breadth (ยืนยันว่าตลาด "แข็งจริงข้างใน" ไม่ใช่แค่ดัชนีขึ้นเพราะหุ้นใหญ่ไม่กี่ตัว)
  // credit: HYG เหนือ EMA50 = นักลงทุนยังกล้าเสี่ยง · breadth: RSP/SPX ratio เหนือ EMA50 = หุ้นขึ้นเป็นวงกว้าง
  let creditOk = null, breadthOk = null;
  if (hyg && hyg.ok && hyg.closes && hyg.closes.length >= 50) { const e = ema(hyg.closes, 50); if (e != null) creditOk = hyg.price > e; }
  if (rsp && rsp.ok && rsp.closes && rsp.closes.length >= 50 && spx.closes.length >= 50) {
    const n = Math.min(rsp.closes.length, spx.closes.length);
    const ratio = rsp.closes.slice(-n).map((v, i) => v / spx.closes.slice(-n)[i]);   // RSP/SPX series
    const re = ema(ratio, 50);
    if (re != null) breadthOk = ratio[ratio.length - 1] > re;
  }
  const internalsWeak = (creditOk === false ? 1 : 0) + (breadthOk === false ? 1 : 0);
  // raw regime — buffer band ±1% กัน flip รอบเส้น
  let raw;
  if (aboveEma != null && aboveEma > 1 && (vix == null || vix < 20)) raw = 'risk-on';
  else if ((aboveEma != null && aboveEma < -1) || (vix != null && vix > 27)) raw = 'risk-off';
  else raw = 'neutral';
  // modifier (ไม่ override core): ดัชนีขึ้นแต่ internals อ่อน ≥1 → cap risk-on เป็น neutral (ระวัง rally แคบ/เครดิตเครียด)
  let internalsNote = null;
  if (raw === 'risk-on' && internalsWeak >= 1) {
    raw = 'neutral';
    internalsNote = (creditOk === false ? 'เครดิต (HYG) อ่อน' : '') + (creditOk === false && breadthOk === false ? ' + ' : '') + (breadthOk === false ? 'breadth (RSP) อ่อน' : '');
  }
  return { ok: true, raw, spxPrice: rnd(price), ema200: rnd(ema200), aboveEma200Pct: rnd(aboveEma), vix: rnd(vix), ndxPrice: rnd(ndxPrice), ndxAboveEma200Pct: rnd(ndxAbove), creditOk, breadthOk, internalsNote };
}

// hysteresis — ต้องเห็น raw ใหม่ใน ≥2 วันต่างกันก่อน commit (กัน whipsaw) · เก็บ state ใน KV
function getRegime(env) {
  return memo('regime', 20000, () => _getRegimeRaw(env));
}
async function _getRegimeRaw(env) {
  const cur = await computeRegimeRaw();
  if (!cur.ok) return { regime: 'unknown', ...cur };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  let st = null;
  try { const raw = await env.WATCHLIST.get('regimeState'); if (raw) st = JSON.parse(raw); } catch (e) {}
  if (!st || !st.committed) {
    st = { committed: cur.raw, committedSince: today, pendRegime: null, pendDays: [] };
  } else if (cur.raw === st.committed) {
    st.pendRegime = null; st.pendDays = [];   // กลับมาเหมือนเดิม → ล้าง pending
  } else {
    if (st.pendRegime === cur.raw) {
      if (!st.pendDays.includes(today)) st.pendDays.push(today);
    } else {
      st.pendRegime = cur.raw; st.pendDays = [today];
    }
    if (st.pendDays.length >= 2) {           // เห็น raw ใหม่ ≥2 วันต่างกัน → commit
      st.committed = cur.raw; st.committedSince = today; st.pendRegime = null; st.pendDays = [];
    }
  }
  try { await env.WATCHLIST.put('regimeState', JSON.stringify(st)); } catch (e) {}
  return {
    regime: st.committed, rawToday: cur.raw,
    pending: st.pendRegime, committedSince: st.committedSince,
    spxPrice: cur.spxPrice, ema200: cur.ema200, aboveEma200Pct: cur.aboveEma200Pct, vix: cur.vix,
    ndxPrice: cur.ndxPrice, ndxAboveEma200Pct: cur.ndxAboveEma200Pct,
    creditOk: cur.creditOk, breadthOk: cur.breadthOk, internalsNote: cur.internalsNote,
  };
}

// 2) CONVICTION SCORE 0-100 — 5 มิติ bucketed (trend/momentum/meanRev/moneyFlow/relStrength) · 50=กลาง
// weight ต่อมิติ "ปรับตาม regime": risk-on เน้น trend/momentum · risk-off/neutral เปิดให้ meanRev/moneyFlow มีน้ำหนัก
// (ปรับมือเท่านั้น ตาม ARCHITECTURE — ห้าม auto-tune ที่ sample เล็ก = overfit noise)
const CONV_WEIGHTS = {
  'risk-on':  { trend: 1.3, momentum: 1.2, relStrength: 1.1, moneyFlow: 1.0, meanRev: 0.5 },
  'neutral':  { trend: 1.0, momentum: 1.0, relStrength: 1.0, moneyFlow: 1.0, meanRev: 1.0 },
  'risk-off': { trend: 1.1, momentum: 0.8, relStrength: 1.2, moneyFlow: 1.1, meanRev: 1.2 },
};
function convictionScore(s, regime) {
  const dims = {};
  // trend: ราคาเทียบ EMA50/200/SMA200
  const tr = [];
  if (s.ema50 != null) tr.push(s.price > s.ema50 ? 1 : -1);
  if (s.ema200 != null) tr.push(s.price > s.ema200 ? 1 : -1);
  if (s.sma200 != null) tr.push(s.price > s.sma200 ? 1 : -1);
  if (tr.length) dims.trend = tr.reduce((a, b) => a + b, 0) / tr.length;
  // momentum: MACD hist + ROC10
  const mo = [];
  if (s.macdHist != null) mo.push(s.macdHist > 0 ? 1 : -1);
  if (s.roc10 != null) mo.push(s.roc10 > 0 ? 1 : -1);
  if (mo.length) dims.momentum = mo.reduce((a, b) => a + b, 0) / mo.length;
  // mean-reversion: RSI (oversold ดีต่อ buy) + Bollinger
  const mr = [];
  if (s.rsi != null) mr.push(s.rsi < 35 ? 1 : s.rsi > 70 ? -1 : 0);
  if (s.bollLower != null && s.bollUpper != null) mr.push(s.price <= s.bollLower ? 1 : s.price >= s.bollUpper ? -1 : 0);
  if (mr.length) dims.meanRev = mr.reduce((a, b) => a + b, 0) / mr.length;
  // money-flow: CMF
  if (s.cmf != null) dims.moneyFlow = s.cmf > 0.05 ? 1 : s.cmf < -0.05 ? -1 : 0;
  // relative-strength: ใช้ RS 3 เดือน (เทรนด์จริง) ถ้ามี ไม่งั้น fallback RS วันเดียว
  const rs = (s.rs3m != null) ? s.rs3m : s.rsVsSpx;
  if (rs != null) dims.relStrength = rs > 0 ? 1 : -1;
  const keys = Object.keys(dims);
  // ต้องมี ≥3 มิติจึงเชื่อถือได้ — หุ้นข้อมูลขาด (closes<200 วัน) ไม่ควรได้ conviction ปลอม (เช่น มี RS มิติเดียว→100)
  if (keys.length < 3) return { score: null, dims, insufficient: true };
  const W = CONV_WEIGHTS[regime] || CONV_WEIGHTS['neutral'];
  let wsum = 0, vsum = 0;
  for (const k of keys) { const w = W[k] != null ? W[k] : 1; wsum += w; vsum += w * dims[k]; }
  const avg = wsum ? vsum / wsum : 0;                          // -1..+1
  return { score: Math.round((avg + 1) / 2 * 100), dims, regime: regime || 'neutral' };  // 0..100
}
// เกณฑ์ซื้อตาม regime (risk-off เข้มขึ้น) — ใช้ทั้งป้ายและ stance ให้ตรงกัน
function buyThreshFor(regime) { return regime === 'risk-on' ? 60 : regime === 'risk-off' ? 75 : 67; }
// ป้าย BUY/HOLD/SELL = derive จาก conviction (source เดียว แทน signalOf เดิมที่นับปัจจัยซ้ำ)
// BUY ผูกกับ buyThresh ของ regime → ป้ายตรงกับ "ระบบจะซื้อไหม" (stance) · SELL ≤35 = โซน avoid
function labelFromConviction(score, regime) {
  if (score == null) return 'HOLD';
  if (score >= buyThreshFor(regime)) return 'BUY';
  if (score <= 35) return 'SELL';
  return 'HOLD';
}
// A1 — ป้าย BUY/HOLD/SELL พลิกเมื่อ conviction ข้ามเกณฑ์ (buyThresh / 35) · ใกล้เส้น = พลิกง่ายจาก noise รายวัน
// ไม่แตะ labelFromConviction (กัน INVARIANT พัง) — แค่บอกว่าป้ายนี้ "ก้ำกึ่ง รอยืนยัน" หรือ "มั่นคง"
const SIGNAL_BORDERLINE_BAND = 4;
function signalStability(score, regime) {
  if (score == null) return { borderline: false, distToFlip: null, nearBoundary: null };
  const buy = buyThreshFor(regime);
  const dBuy = Math.abs(score - buy), dSell = Math.abs(score - 35);
  const dist = Math.min(dBuy, dSell);
  return { borderline: dist <= SIGNAL_BORDERLINE_BAND, distToFlip: dist, nearBoundary: dBuy <= dSell ? buy : 35 };
}

// 3) POSITION SIZING — risk-based จาก ATR + riskConfig · ปรับขนาดตาม conviction (Kelly-lite)
// extraFactor = ตัวคูณรวม (correlation penalty × kill-switch) — ลดไม้เมื่อเสี่ยงซ้ำ/แพ้ติด
function positionSize(s, riskConfig, conviction, extraFactor) {
  const atr = s.atr14;
  if (!atr || atr <= 0 || !s.price) return null;
  const stopDist = (s.sl && s.sl > 0 && s.sl < s.price) ? (s.price - s.sl) : 2 * atr;  // ใช้ SL ที่ตั้งถ้ามี ไม่งั้น 2×ATR
  const out = { stopDist: +stopDist.toFixed(2), stopType: (s.sl && s.sl > 0 && s.sl < s.price) ? 'SL ที่ตั้ง' : '2×ATR' };
  if (riskConfig && riskConfig.capital > 0 && riskConfig.riskPctPerTrade > 0) {
    // conviction-weighted: conviction 60 (เกณฑ์ buy) = 1.0x · สูงกว่า=ไม้ใหญ่ขึ้น · cap 0.5–1.5x กันเว่อร์
    const convFactor = conviction != null ? Math.max(0.5, Math.min(1.5, conviction / 60)) : 1;
    const ef = (extraFactor != null && extraFactor > 0) ? extraFactor : 1;
    const riskAmount = riskConfig.capital * riskConfig.riskPctPerTrade / 100 * convFactor * ef;
    const shares = riskAmount / stopDist;
    const value = shares * s.price;
    out.convFactor = +convFactor.toFixed(2);
    if (ef !== 1) out.sizeFactor = +ef.toFixed(2);    // <1 = ถูกลดไม้ (correlation/kill-switch)
    out.riskAmount = +riskAmount.toFixed(2);
    out.shares = +shares.toFixed(2);
    out.positionValue = +value.toFixed(2);
    out.pctOfPort = +(value / riskConfig.capital * 100).toFixed(1);
  }
  return out;
}
// correlation penalty: ลดไม้ครึ่งถ้า candidate correlate สูง (≥0.75) กับหุ้นที่ถืออยู่ (risk-parity-lite — กันเดิมพันซ้ำ)
function corrPenaltyFor(symbolObj, holdings, pairCorr) {
  const heldSyms = new Set((holdings || []).map(h => h.symbol));
  for (const pc of (pairCorr || [])) {
    const hit = (pc.a === symbolObj.symbol && heldSyms.has(pc.b)) || (pc.b === symbolObj.symbol && heldSyms.has(pc.a));
    if (hit && pc.corr30 >= 0.75) return 0.5;
  }
  return 1;
}
// kill-switch: นับ "แพ้ติดกัน" จาก trade_log (ล่าสุด→เก่า) — ใช้คุมอารมณ์รีบแก้มือ
async function recentLossStreak(env) {
  if (!env.JOURNAL) return 0;
  try {
    const { results } = await env.JOURNAL.prepare(`SELECT pnl FROM trade_log ORDER BY id DESC LIMIT 12`).all();
    let streak = 0;
    for (const r of (results || [])) { if (r.pnl != null && r.pnl <= 0) streak++; else break; }
    return streak;
  } catch (e) { return 0; }
}
// theme/sector ของแต่ละหุ้น — ใช้เตือน concentration (เดิมพันปัจจัยเดียวซ้ำ)
const STOCK_THEMES = {
  NVDA: 'AI/Semi', AMD: 'AI/Semi', AVGO: 'AI/Semi', MRVL: 'AI/Semi', MU: 'AI/Semi', TSM: 'AI/Semi', SMH: 'AI/Semi', QCOM: 'AI/Semi', ASML: 'AI/Semi',
  NBIS: 'AI/Cloud', CRWV: 'AI/Cloud', SPCX: 'Space',
  MSFT: 'MegaTech', GOOGL: 'MegaTech', META: 'MegaTech', AMZN: 'MegaTech', AAPL: 'MegaTech', NOW: 'Software',
  TSLA: 'EV/Auto', GEV: 'Energy/Power', ETN: 'Energy/Power', LLY: 'Pharma',
};
function themeOf(sym) { return STOCK_THEMES[String(sym).toUpperCase()] || null; }

// 4) RISK GATE — flags เตือน (ไม่ block): ถืออยู่แล้ว / correlate ซ้ำกับ holding / กระจุก
function riskGate(s, holdings, pairCorr, sizing) {
  const flags = [];
  const held = holdings.find(h => h.symbol === s.symbol);
  if (held) flags.push(`ถืออยู่แล้ว (${qtyFmt(held.qty)} หุ้น)`);
  // correlate สูงกับหุ้นที่ถือ → เพิ่ม exposure ซ้ำ
  const heldSyms = new Set(holdings.map(h => h.symbol));
  for (const pc of (pairCorr || [])) {
    let other = null;
    if (pc.a === s.symbol && heldSyms.has(pc.b)) other = pc.b;
    else if (pc.b === s.symbol && heldSyms.has(pc.a)) other = pc.a;
    if (other && pc.corr30 >= 0.75) flags.push(`สัมพันธ์สูงกับ ${other} ที่ถืออยู่ (${pc.corr30}) = เพิ่มความเสี่ยงซ้ำ`);
  }
  if (sizing && sizing.pctOfPort != null && sizing.pctOfPort > 25) flags.push(`ขนาดไม้ ${sizing.pctOfPort}% ของพอร์ต = กระจุกเกิน`);
  return flags;
}

// ECONOMIC CALENDAR — FOMC 2026 (Fed ประกาศ schedule ล่วงหน้า) · กระทบทั้งพอร์ตพร้อมกัน · ปรับ array รายปี
const ECON_EVENTS = [
  { date: '2026-01-28', name: 'FOMC — ประชุมดอกเบี้ย', impact: 'high' },
  { date: '2026-03-18', name: 'FOMC + dot plot (คาดการณ์ดอกเบี้ย)', impact: 'high' },
  { date: '2026-04-29', name: 'FOMC — ประชุมดอกเบี้ย', impact: 'high' },
  { date: '2026-06-17', name: 'FOMC + dot plot', impact: 'high' },
  { date: '2026-07-29', name: 'FOMC — ประชุมดอกเบี้ย', impact: 'high' },
  { date: '2026-09-16', name: 'FOMC + dot plot', impact: 'high' },
  { date: '2026-10-28', name: 'FOMC — ประชุมดอกเบี้ย', impact: 'high' },
  { date: '2026-12-09', name: 'FOMC + dot plot', impact: 'high' },
];
function econEventsSoon(maxDays = 10) {
  const now = Date.now();
  return ECON_EVENTS.map(e => {
    const t = new Date(e.date + 'T18:00:00Z').getTime();  // FOMC แถลง ~14:00 ET = 18:00–19:00 UTC
    return { ...e, daysUntil: Math.round((t - now) / 86400000) };
  }).filter(e => e.daysUntil >= 0 && e.daysUntil <= maxDays).sort((a, b) => a.daysUntil - b.daysUntil);
}

// MAIN — รวม pipeline → รายงานตัดสินใจ
async function computeDecision(env, opts = {}) {
  let watch = [];
  try { const raw = await env.WATCHLIST.get('main'); if (raw) watch = JSON.parse(raw); } catch (e) {}
  const watchMap = {}; watch.forEach(w => { if (w && w.symbol) watchMap[String(w.symbol).toUpperCase()] = w; });
  let riskConfig = null;
  try { const raw = await env.WATCHLIST.get('riskConfig'); if (raw) riskConfig = JSON.parse(raw); } catch (e) {}
  // cached: อ่าน fullData จาก KV (cron เขียนทุก 15 นาที) → เร็ว · lite (thesis): ตัด intraday+portfolio fallback ถ้า cache miss
  const [d, regime, port] = await Promise.all([
    computeWatchlistData(env, { lite: !!opts.lite, cached: true }),
    getRegime(env),
    opts.lite ? Promise.resolve(null) : computePortfolio(env).catch(() => null),
  ]);
  const holdings = (port && port.positions) ? port.positions.filter(h => h.ok) : [];
  // kill-switch: แพ้ติดกัน ≥3 ไม้ → ยกเกณฑ์ซื้อ +8 และลดขนาดไม้ครึ่ง (คุมอารมณ์รีบแก้มือ)
  const lossStreak = await recentLossStreak(env);
  const killSwitch = lossStreak >= 3;
  // threshold BUY ปรับตาม regime (risk-off → เข้มขึ้น) — ใช้ helper ตัวเดียวกับป้าย · + kill-switch
  const buyThresh = buyThreshFor(regime.regime) + (killSwitch ? 8 : 0);
  const stocks = d.stocks.filter(s => s && s.ok);
  // CATALYST + FUNDAMENTALS — ดึงจาก cache (read-only, ไม่เพิ่ม subrequest · warm โดย cron) เฉพาะ tactical
  const earnMap = {}, fundMap = {};
  await Promise.all(stocks.filter(s => !isCore(s.symbol, watchMap[s.symbol])).map(async s => {
    earnMap[s.symbol] = await fetchEarningsReadOnly(env, s.symbol);
    fundMap[s.symbol] = await fetchFundamentalsReadOnly(env, s.symbol);
  }));
  const fomcSoon = econEventsSoon(2).length > 0;   // FOMC ใน 2 วัน → ทั้งตลาดผันผวน ลดไซส์รวม
  const evaluated = stocks.map(s => {
    const core = isCore(s.symbol, watchMap[s.symbol]);
    const cv = convictionScore(s, regime.regime);   // regime-weighted (risk-on เน้น trend/momentum)
    const earn = core ? null : earnMap[s.symbol];
    const fund = core ? null : fundMap[s.symbol];
    // event blackout: งบใกล้ (4-7 วัน) ลดไม้ 40% · FOMC ≤2 วัน ลดไม้รวม 30% (ลด exposure ก่อน binary event)
    const evFactor = (earn && earn.daysUntil != null && earn.daysUntil > 3 && earn.daysUntil <= 7 ? 0.6 : 1) * (fomcSoon ? 0.7 : 1);
    // ตัวคูณลดไม้ = correlation penalty × kill-switch × event blackout
    const sizeFactor = corrPenaltyFor(s, holdings, d.pairCorr30) * (killSwitch ? 0.5 : 1) * evFactor;
    const sizing = core ? null : positionSize(s, riskConfig, cv.score, sizeFactor);
    const flags = core ? [] : riskGate(s, holdings, d.pairCorr30, sizing);
    const earnSoon = earn && earn.daysUntil != null && earn.daysUntil >= 0 && earn.daysUntil <= 7;
    if (earnSoon) flags.unshift(`📅 งบออกอีก ${earn.daysUntil} วัน (${earn.date}) — เสี่ยง gap อย่าเข้าเต็มไม้`);
    if (!core) for (const ff of fundamentalFlags(fund)) flags.push(ff);   // fundamentals (flag-only ไม่ block)
    // hard screen: risk-off ห้ามสวนเทรนด์ใหญ่ (ต้อง price > sma200)
    let stance = 'wait', reason = '';
    if (core) { stance = 'core'; reason = 'ถือยาว ไม่ trade ตาม signal'; }
    else if (cv.score == null) { stance = 'n/a'; reason = 'ข้อมูลไม่พอ'; }
    else {
      const trendOk = !(regime.regime === 'risk-off' && s.sma200 != null && s.price < s.sma200);
      if (cv.score >= buyThresh && trendOk) { stance = 'buy'; reason = `conviction ${cv.score} ≥ เกณฑ์ ${buyThresh}`; }
      else if (cv.score >= buyThresh && !trendOk) { stance = 'wait'; reason = `conviction ถึงเกณฑ์ แต่ risk-off + ต่ำกว่า SMA200 → ห้ามสวนเทรนด์`; }
      else if (cv.score <= 35) { stance = 'avoid'; reason = `conviction ต่ำ ${cv.score}`; }
      else { stance = 'wait'; reason = `conviction ${cv.score} < เกณฑ์ ${buyThresh}`; }
    }
    // CATALYST gate — งบใกล้มาก (≤3 วัน) + จะซื้อ → ดาวน์เกรดเป็น wait (กันโดน gap ข้ามคืน)
    if (stance === 'buy' && earn && earn.daysUntil != null && earn.daysUntil >= 0 && earn.daysUntil <= 3) {
      stance = 'wait'; reason = `งบออกอีก ${earn.daysUntil} วัน — รอผ่านงบก่อน (กัน gap)`;
    }
    const stab = signalStability(cv.score, regime.regime);
    return { symbol: s.symbol, name: s.name, core, price: s.price, signal: labelFromConviction(cv.score, regime.regime),
      borderline: stab.borderline, distToFlip: stab.distToFlip,
      conviction: cv.score, dims: cv.dims, stance, reason, sizing, flags, earnings: earn, fund, fundFlags: fundamentalFlags(fund),
      rsi: s.rsi, rsiWeekly: s.rsiWeekly, macdHist: s.macdHist, roc10: s.roc10, cmf: s.cmf, rsVsSpx: s.rsVsSpx, rs3m: s.rs3m,
      atr14: s.atr14, beta1y: s.beta1y, volRatio: s.volRatio, changePct: s.changePct,
      ema50: s.ema50, ema200: s.ema200, sma200: s.sma200, bollUpper: s.bollUpper, bollLower: s.bollLower,
      week52High: s.week52High, week52Low: s.week52Low, pctFrom52High: s.pctFrom52High, pctFrom52Low: s.pctFrom52Low,
      impliedMove: s.impliedMove, entry: s.entry, sl: s.sl, tp: s.tp };
  });
  const tactical = evaluated.filter(e => !e.core).sort((a, b) => (b.conviction || 0) - (a.conviction || 0));
  const coreList = evaluated.filter(e => e.core);
  // PORTFOLIO HEAT — คุมความเสี่ยงรวม (ไม่ใช่แค่ต่อไม้) + เตือน cluster ที่ correlate กัน
  const buys = tactical.filter(c => c.stance === 'buy');
  const heat = { buyCount: buys.length };
  if (riskConfig && riskConfig.riskPctPerTrade > 0) {
    heat.grossRiskPct = +(buys.length * riskConfig.riskPctPerTrade).toFixed(1);   // ถ้าเปิดทุกไม้
    heat.maxSafePct = 6;   // เพดานความเสี่ยงรวมที่ปลอดภัย (rule of thumb)
    if (heat.grossRiskPct > heat.maxSafePct)
      heat.warn = `ถ้าเปิดครบ ${buys.length} ไม้ = เสี่ยงรวม ${heat.grossRiskPct}% เกินเพดาน ${heat.maxSafePct}% → เลือกเฉพาะ conviction สูงสุด ~${Math.floor(heat.maxSafePct / riskConfig.riskPctPerTrade)} ตัว`;
  }
  // correlated cluster ในกลุ่ม buy (ความเสี่ยงซ้ำซ้อน — จริง ๆ เหมือนไม้เดียว)
  const buySet = new Set(buys.map(c => c.symbol));
  const clusters = (d.pairCorr30 || []).filter(p => buySet.has(p.a) && buySet.has(p.b) && p.corr30 >= 0.75)
    .map(p => `${p.a}+${p.b} (${p.corr30})`);
  if (clusters.length) heat.correlatedClusters = clusters;
  // theme concentration — buy ซ้ำ theme เดียว (เดิมพันปัจจัยเดียว เช่น AI/Semi ทั้งพอร์ต)
  const themeCount = {};
  buys.forEach(c => { const th = themeOf(c.symbol); if (th) themeCount[th] = (themeCount[th] || 0) + 1; });
  const themeWarn = Object.entries(themeCount).filter(([, n]) => n >= 3).map(([th, n]) => `${th} ${n} ตัว`);
  if (themeWarn.length) heat.themeConcentration = themeWarn;
  // kill-switch — แพ้ติดกัน → ลดไม้ + ยกเกณฑ์
  heat.lossStreak = lossStreak;
  if (killSwitch) heat.killSwitch = `⛔ แพ้ติด ${lossStreak} ไม้ — ลดขนาดไม้ 50% + ยกเกณฑ์ซื้อเป็น ${buyThresh} (กันรีบแก้มือ)`;
  return {
    updated: new Date().toISOString(), regime, buyThresh,
    riskConfigSet: !!(riskConfig && riskConfig.capital > 0),
    candidates: tactical, core: coreList, heat, econEvents: econEventsSoon(10),
    note: 'Decision Engine (deterministic) — conviction = 5 มิติ regime-weighted · sizing หัก correlation/kill-switch · ไม่ใช่คำแนะนำการลงทุน',
  };
}

// invalidation breach ต้องมี "buffer" — กัน whipsaw ตอนราคาแกว่งรอบเส้นระหว่างวัน (เส้นนี้ไม่มี hysteresis เหมือน regime)
// ต่ำกว่าเส้น ≥ INVALIDATION_BUFFER_PCT = หลุดจริง (breached) · ต่ำกว่าเล็กน้อย = แค่ "แตะ" รอยืนยัน (near) ยังไม่ประกาศ thesis พัง
// เหตุ: ต่ำกว่า 0.2% (intraday) ไม่ใช่หลักฐานว่า thesis พัง โดยเฉพาะวันที่หุ้นเขียว — ต้องรอ "ปิดต่ำกว่าชัดเจน"
const INVALIDATION_BUFFER_PCT = 1.0;
function invalidationStatus(price, invPrice) {
  const r = (x, d = 2) => (x == null || isNaN(x)) ? null : +(+x).toFixed(d);
  if (!(invPrice > 0) || !(price > 0)) return { status: 'ok', alert: null };
  const belowPct = (invPrice - price) / invPrice * 100;            // >0 = ราคาอยู่ใต้เส้น
  if (belowPct >= INVALIDATION_BUFFER_PCT)
    return { status: 'breached', alert: `🛑 หลุด invalidation $${r(invPrice)} ชัดเจน (ต่ำกว่า −${r(belowPct, 1)}%) — thesis เสี่ยงพัง พิจารณาลด/ออก` };
  if (belowPct > 0)                                                // แตะ/ต่ำกว่าเล็กน้อย — ยังไม่ยืนยัน
    return { status: 'near', alert: `⚠️ แตะ invalidation $${r(invPrice)} (ต่ำกว่าแค่ −${r(belowPct, 1)}%) — รอ "ปิดต่ำกว่าชัดเจน" ก่อนสรุป thesis พัง · อย่าตัดสินจากราคาแกว่งระหว่างวัน` };
  const abovePct = (price - invPrice) / price * 100;
  if (abovePct <= 3)
    return { status: 'near', alert: `⚠️ ใกล้ invalidation $${r(invPrice)} (เหนือเส้น +${r(abovePct, 1)}%)` };
  return { status: 'ok', alert: null };
}

// POSITION TRACKING — เชื่อม position จริง (KV) กับ invalidation ล่าสุดจาก thesis (D1) → เตือนใกล้/หลุด
async function computePositionWatch(env) {
  const port = await computePortfolio(env).catch(() => null);
  const holdings = (port && port.positions) ? port.positions.filter(h => h.ok) : [];
  if (!holdings.length) return { ok: true, positions: [], note: 'ไม่มี position ที่ถืออยู่' };
  const invMap = {};
  if (env.JOURNAL) {
    try {
      const { results } = await env.JOURNAL.prepare(
        `SELECT symbol, invalidation_price, confidence, action, ts_iso FROM decision_journal WHERE id IN (SELECT MAX(id) FROM decision_journal GROUP BY symbol)`
      ).all();
      for (const r of results || []) invMap[r.symbol] = r;
    } catch (e) {}
  }
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +(+x).toFixed(d);
  const positions = holdings.map(h => {
    const avgCost = h.qty > 0 ? h.costTotal / h.qty : null;
    const plPct = avgCost ? (h.price - avgCost) / avgCost * 100 : null;
    const inv = invMap[h.symbol];
    const invPrice = inv && inv.invalidation_price;
    const { status, alert } = invalidationStatus(h.price, invPrice);
    return { symbol: h.symbol, name: h.name, qty: h.qty, price: rnd(h.price), avgCost: rnd(avgCost), plPct: rnd(plPct), invalidationPrice: rnd(invPrice), thesisDate: inv && inv.ts_iso ? String(inv.ts_iso).slice(0, 10) : null, status, alert };
  });
  return { ok: true, updated: new Date().toISOString(), positions };
}

// ============ TRADE LOG — บันทึกการเทรดจริง + สถิติ (win rate, R-multiple) ============
// บันทึก trade ที่ขายแล้ว (realized P/L) · R-multiple = กำไร ÷ ความเสี่ยงต่อหุ้น (ถ้ามี SL)
async function logTrade(env, t) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  const qty = +t.qty || 0, buy = +t.buyPrice || 0, sell = +t.sellPrice || 0;
  if (qty <= 0 || buy <= 0 || sell <= 0) return { ok: false, error: 'ต้องมี qty / ราคาซื้อ / ราคาขาย' };
  const pnl = (sell - buy) * qty, pnlPct = (sell - buy) / buy * 100;
  const sl = +t.sl || 0;
  const rMultiple = (sl > 0 && buy > sl) ? (sell - buy) / (buy - sl) : null;
  const ts = new Date().toISOString();
  await env.JOURNAL.prepare(`INSERT INTO trade_log (ts_iso,symbol,qty,buy_price,sell_price,pnl,pnl_pct,r_multiple,hold_days,note) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(ts, String(t.symbol || '').toUpperCase(), qty, buy, sell, +pnl.toFixed(2), +pnlPct.toFixed(2), rMultiple != null ? +rMultiple.toFixed(2) : null, t.holdDays != null ? +t.holdDays : null, t.note || null).run();
  return { ok: true, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2), rMultiple: rMultiple != null ? +rMultiple.toFixed(2) : null };
}

// สถิติการเทรด — win rate, R-multiple เฉลี่ย, กำไร/ขาดทุนเฉลี่ย, profit factor
async function computeTradeStats(env) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  const { results } = await env.JOURNAL.prepare(`SELECT * FROM trade_log ORDER BY id DESC`).all();
  const trades = results || [];
  if (!trades.length) return { ok: true, count: 0, trades: [], note: 'ยังไม่มีประวัติเทรด — กด "ขาย" ใน Positions เพื่อบันทึก' };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const sum = a => a.reduce((s, x) => s + x, 0);
  const grossWin = sum(wins.map(t => t.pnl)), grossLoss = Math.abs(sum(losses.map(t => t.pnl)));
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +(+x).toFixed(d);
  const rs = trades.map(t => t.r_multiple).filter(x => x != null);
  const best = trades.reduce((a, b) => (a.pnl >= b.pnl ? a : b), trades[0]);
  const worst = trades.reduce((a, b) => (a.pnl <= b.pnl ? a : b), trades[0]);
  return {
    ok: true, count: trades.length,
    summary: {
      winRate: rnd(wins.length / trades.length * 100, 1), wins: wins.length, losses: losses.length,
      totalPnl: rnd(sum(trades.map(t => t.pnl))),
      avgWin: wins.length ? rnd(grossWin / wins.length) : null,
      avgLoss: losses.length ? rnd(grossLoss / losses.length) : null,
      profitFactor: grossLoss > 0 ? rnd(grossWin / grossLoss) : (grossWin > 0 ? 999 : null),
      avgR: rs.length ? rnd(sum(rs) / rs.length) : null,
      best: { symbol: best.symbol, pnl: best.pnl, pnlPct: best.pnl_pct },
      worst: { symbol: worst.symbol, pnl: worst.pnl, pnlPct: worst.pnl_pct },
    },
    trades,
  };
}

// ============ Phase 3 — SURPRISE DETECTOR + PLAYBOOK + TELEGRAM ============

// ส่งข้อความ Telegram (อ่าน secret TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) — ถ้าไม่ตั้งก็ข้ามเงียบ ๆ
async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, error: 'no telegram secret' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: j.description || 'telegram error', chatLen: String(chat).length };
    return { ok: true };
  } catch (e) { return { ok: false, error: e && e.message }; }
}

// SURPRISE DETECTOR — เทียบ 2 snapshot ล่าสุดใน D1 ต่อหุ้น → เด้งเฉพาะ "เปลี่ยน regime จริง" (ไม่สแปม)
// + PLAYBOOK — ราคาแตะ entry/sl/tp ที่วางไว้ตอนหัวเย็น (กัน FOMO ไล่ราคา)
async function computeSurprise(env) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  const { results: dRows } = await env.JOURNAL.prepare(
    `SELECT DISTINCT ts_date FROM signal_history ORDER BY ts_date DESC LIMIT 2`
  ).all();
  const dates = (dRows || []).map(r => r.ts_date);
  if (dates.length < 2) return { ok: true, events: [], note: 'ต้องมี snapshot ≥2 วันจึงเทียบได้ (ตอนนี้ ' + dates.length + ' วัน)' };
  const [today, prev] = dates;
  const { results: rows } = await env.JOURNAL.prepare(
    `SELECT * FROM signal_history WHERE ts_date IN (?,?)`
  ).bind(today, prev).all();
  const bySym = {};
  for (const r of rows) { (bySym[r.symbol] = bySym[r.symbol] || {})[r.ts_date] = r; }
  // watchlist (entry/sl/tp) สำหรับ playbook
  let watch = [];
  try { const raw = await env.WATCHLIST.get('main'); if (raw) watch = JSON.parse(raw); } catch (e) {}
  const wm = {}; watch.forEach(w => { if (w && w.symbol) wm[String(w.symbol).toUpperCase()] = w; });
  // ระดับราคาที่ AI (thesis) ตั้งไว้ → เช็คราคาแตะ entry_target ที่ LLM แนะ (#4)
  let thLevels = {};
  try { const raw = await env.WATCHLIST.get('thesisLevels'); if (raw) { const c = JSON.parse(raw); thLevels = c.levels || {}; } } catch (e) {}
  // regime เปลี่ยนวันนี้?
  let regimeEvent = null, regimeName = '';
  try {
    const raw = await env.WATCHLIST.get('regimeState');
    if (raw) { const st = JSON.parse(raw); regimeName = st.committed || ''; if (st.committedSince === today) regimeEvent = `ตลาดเปลี่ยน regime → <b>${st.committed}</b>`; }
  } catch (e) {}
  const sign = x => x == null ? 0 : x > 0 ? 1 : x < 0 ? -1 : 0;
  const events = [];
  for (const sym of Object.keys(bySym)) {
    const t = bySym[sym][today], p = bySym[sym][prev];
    if (!t || !p) continue;
    const ch = [];
    // 1) signal เปลี่ยน
    if (t.signal && p.signal && t.signal !== p.signal) ch.push(`สัญญาณ ${p.signal} → <b>${t.signal}</b>`);
    // 2) CMF พลิกขั้ว (ข้าม dead zone ±0.05)
    if (p.cmf != null && t.cmf != null) {
      const pp = p.cmf > 0.05 ? 1 : p.cmf < -0.05 ? -1 : 0, tt = t.cmf > 0.05 ? 1 : t.cmf < -0.05 ? -1 : 0;
      if (pp !== tt && tt !== 0) ch.push(`เงินสถาบัน${tt > 0 ? 'ไหลเข้า' : 'ไหลออก'} (CMF ${f2(p.cmf)}→${f2(t.cmf)})`);
    }
    // 3) RS vs SPX เปลี่ยนข้าง
    if (sign(p.rs_vs_spx) !== sign(t.rs_vs_spx) && sign(t.rs_vs_spx) !== 0)
      ch.push(`${t.rs_vs_spx > 0 ? 'แข็งกว่า' : 'อ่อนกว่า'}ตลาด (RS ${f2(p.rs_vs_spx)}→${f2(t.rs_vs_spx)})`);
    // 4) conviction ข้ามเกณฑ์ 60
    if (p.conviction != null && t.conviction != null && (p.conviction < 60) !== (t.conviction < 60))
      ch.push(`conviction ${p.conviction}→<b>${t.conviction}</b> ${t.conviction >= 60 ? '(ผ่านเกณฑ์ซื้อ)' : '(หลุดเกณฑ์)'}`);
    // 5) การเคลื่อนไหวแรงผิดปกติวันนี้
    if (t.change_pct != null && Math.abs(t.change_pct) >= 5) ch.push(`ราคาขยับแรง ${t.change_pct > 0 ? '+' : ''}${f2(t.change_pct)}% วันนี้`);
    // 5a) RSI วัน เข้า/ออกเขต oversold(<30)/overbought(>70)
    if (p.rsi != null && t.rsi != null) {
      if (p.rsi >= 30 && t.rsi < 30) ch.push(`RSI เข้าเขต oversold (${f2(p.rsi, 0)}→${f2(t.rsi, 0)}) — โอกาสกลับตัว`);
      else if (p.rsi <= 70 && t.rsi > 70) ch.push(`RSI เข้าเขต overbought (${f2(p.rsi, 0)}→${f2(t.rsi, 0)}) — ระวังพักตัว`);
      else if (p.rsi < 50 && t.rsi >= 50) ch.push(`RSI ตัดขึ้นเหนือ 50 (${f2(p.rsi, 0)}→${f2(t.rsi, 0)}) — โมเมนตัมพลิกบวก`);
    }
    // 5b) RSI สัปดาห์ เข้าเขต oversold/overbought (สัญญาณหนักกว่ารายวัน)
    if (p.rsi_weekly != null && t.rsi_weekly != null) {
      if (p.rsi_weekly >= 30 && t.rsi_weekly < 30) ch.push(`RSI สัปดาห์เข้า oversold (${f2(t.rsi_weekly, 0)}) — สัญญาณระยะกลาง`);
      else if (p.rsi_weekly <= 70 && t.rsi_weekly > 70) ch.push(`RSI สัปดาห์ overbought (${f2(t.rsi_weekly, 0)}) — ระวังกลับตัวใหญ่`);
    }
    // 5c) MACD histogram พลิกขั้ว (โมเมนตัมเปลี่ยนทิศ)
    if (sign(p.macd_hist) !== sign(t.macd_hist) && sign(t.macd_hist) !== 0)
      ch.push(`MACD พลิกเป็น${t.macd_hist > 0 ? 'บวก' : 'ลบ'} (${f2(p.macd_hist)}→${f2(t.macd_hist)}) — โมเมนตัม${t.macd_hist > 0 ? 'กลับขึ้น' : 'อ่อนลง'}`);
    // 5d) ราคาตัดผ่าน EMA50 / EMA200 (เปลี่ยนแนวโน้ม)
    if (p.price != null && t.price != null) {
      if (p.ema50 != null && t.ema50 != null) {
        if (p.price < p.ema50 && t.price > t.ema50) ch.push(`ราคาตัดขึ้นเหนือ EMA50 ($${f2(t.ema50)}) — เทรนด์สั้นกลับขึ้น`);
        else if (p.price > p.ema50 && t.price < t.ema50) ch.push(`ราคาหลุดต่ำกว่า EMA50 ($${f2(t.ema50)}) — เทรนด์สั้นอ่อน`);
      }
      if (p.ema200 != null && t.ema200 != null) {
        if (p.price < p.ema200 && t.price > t.ema200) ch.push(`ราคาตัดขึ้นเหนือ EMA200 ($${f2(t.ema200)}) — เทรนด์ใหญ่กลับขึ้น 🟢`);
        else if (p.price > p.ema200 && t.price < t.ema200) ch.push(`ราคาหลุดต่ำกว่า EMA200 ($${f2(t.ema200)}) — เทรนด์ใหญ่เสีย 🔴`);
      }
    }
    // 5e) Volume spike + 52-week high/low (จาก snapshot_json)
    let tj = null, pj = null;
    try { tj = t.snapshot_json ? JSON.parse(t.snapshot_json) : null; } catch (e) {}
    try { pj = p.snapshot_json ? JSON.parse(p.snapshot_json) : null; } catch (e) {}
    if (tj && pj) {
      if (tj.volRatio != null && pj.volRatio != null && tj.volRatio >= 2 && pj.volRatio < 2)
        ch.push(`วอลุ่มพุ่ง ${f2(tj.volRatio)}x ของเฉลี่ย — มีแรงผิดปกติ`);
      if (tj.week52High != null && t.price != null && t.price >= tj.week52High * 0.999 && (pj.price == null || pj.price < pj.week52High * 0.999))
        ch.push(`🔼 ทำจุดสูงสุดใหม่ 52 สัปดาห์ ($${f2(tj.week52High)})`);
      if (tj.week52Low != null && t.price != null && t.price <= tj.week52Low * 1.001 && (pj.price == null || pj.price > pj.week52Low * 1.001))
        ch.push(`🔽 ทำจุดต่ำสุดใหม่ 52 สัปดาห์ ($${f2(tj.week52Low)})`);
    }
    // 6) PLAYBOOK — ราคาแตะ zone ที่วางไว้ (เพิ่งแตะ: วันนี้แตะ เมื่อวานยังไม่)
    const w = wm[sym];
    if (w && t.price != null && p.price != null) {
      const near = (px, lv) => lv > 0 && Math.abs(px - lv) / lv <= 0.015;
      if (w.entry > 0 && near(t.price, +w.entry) && !near(p.price, +w.entry)) ch.push(`📍 ถึงจุดเข้าที่วางไว้ $${f2(+w.entry)}`);
      if (w.sl > 0 && t.price <= +w.sl && p.price > +w.sl) ch.push(`🛑 หลุด Stop Loss $${f2(+w.sl)}`);
      if (w.tp > 0 && t.price >= +w.tp && p.price < +w.tp) ch.push(`🎯 ถึงเป้าทำกำไร $${f2(+w.tp)}`);
    }
    // #4 — ราคาแตะจุดเข้าที่ AI (thesis) แนะไว้
    const th = thLevels[sym];
    if (th && th.entry > 0 && t.price != null && p.price != null) {
      const near = (px, lv) => Math.abs(px - lv) / lv <= 0.015;
      if (near(t.price, th.entry) && !near(p.price, th.entry)) ch.push(`🤖 ราคาถึงจุดเข้าที่ AI แนะ $${f2(th.entry)}${th.stance ? ' (' + th.stance + ')' : ''}`);
    }
    if (ch.length) events.push({ symbol: sym, price: t.price, changes: ch });
  }
  return { ok: true, today, prev, regimeEvent, regime: { regime: regimeName }, events, note: 'surprise-only — เด้งเฉพาะของเปลี่ยนจริง ไม่ใช่รายงานทุกตัว' };
}

// วิเคราะห์ event ด้วย Gemini (framework wall-street-analyzer) → ความเห็นสั้น + คำแนะนำต่อตัว · 1 req/วัน
// optional: ถ้า quota หมด/ไม่มี key → คืน {} ส่ง raw ได้ปกติ
async function analyzeSurprise(env, items, regimeEvent, regimeName) {
  if (!items.length || !env.GEMINI_API_KEY) return {};
  const lines = items.map(it => `${it.symbol} ($${f2(it.price)}${it.held ? ', ถืออยู่' : ''}): ${it.changes.join(' · ')}`).join('\n');
  const prompt = `คุณคือนักวิเคราะห์หุ้นไทยสายตรงไปตรงมา ไม่อวย ยึดความจริง (framework wall-street-analyzer)
สภาวะตลาด: ${regimeName}${regimeEvent ? ' · ' + regimeEvent.replace(/<[^>]+>/g, '') : ''}
มีการเปลี่ยนแปลงสำคัญวันนี้:
${lines}

ให้ความเห็นสั้น 1-2 ประโยคต่อตัว: การเปลี่ยนนี้ "หมายความว่าอะไร" + "ควรทำอะไร" (เข้า/รอย่อ/ระวัง/ถือต่อ/ลด/ขาย) เจาะจง อ้างเหตุผล ไม่อวย · ตัวที่ถืออยู่เน้นถือต่อ/ลด/ขาย · ตอบไทยกระชับ`;
  const schema = { type: 'object', properties: { comments: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, comment: { type: 'string' } }, required: ['symbol', 'comment'] } } }, required: ['comments'] };
  const r = await callGemini(env, prompt, schema).catch(() => null);
  const map = {};
  if (r && r.ok && r.data && r.data.comments) for (const c of r.data.comments) if (c.symbol) map[c.symbol.toUpperCase()] = c.comment;
  return map;
}

// format ข้อความ Telegram + ส่ง (เรียกจาก cron หลัง snapshot)
async function runSurpriseAlert(env) {
  const [s, pw, rg] = await Promise.all([
    computeSurprise(env),
    computePositionWatch(env).catch(() => null),
    getRegime(env).catch(() => null),
  ]);
  // position ที่หลุด/ใกล้ invalidation (สำคัญสุด — เตือนแม้ไม่มี surprise อื่น)
  const posAlerts = (pw && pw.positions ? pw.positions : []).filter(p => p.alert);
  const hasSurprise = s.ok && (s.events.length || s.regimeEvent);
  if (!hasSurprise && !posAlerts.length) return { ok: true, sent: false, reason: 'ไม่มี surprise / position alert' };
  // รวม items (position + signal events) → วิเคราะห์ด้วย LLM ครั้งเดียว (framework skill)
  const heldSyms = new Set(posAlerts.map(p => p.symbol));
  const llmItems = [
    ...posAlerts.map(p => ({ symbol: p.symbol, price: p.price, held: true, changes: [p.alert.replace(/<[^>]+>/g, '')] })),
    ...(s.events || []).filter(e => !heldSyms.has(e.symbol)).map(e => ({ symbol: e.symbol, price: e.price, held: false, changes: e.changes.map(c => c.replace(/<[^>]+>/g, '')) })),
  ];
  const comments = await analyzeSurprise(env, llmItems, s.regimeEvent, (s.regime && s.regime.regime) || '').catch(() => ({}));
  const dateTh = new Date((s.today || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z').toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' });
  const HR = '━━━━━━━━━━━━━━━';
  let msg = `🔔 <b>แจ้งเตือนสำคัญประจำวัน</b>\n📅 ${dateTh}\n${HR}`;
  // ภาวะตลาดเสมอ (regime ปัจจุบัน + SPX + VIX) · เน้นถ้าเพิ่งเปลี่ยนวันนี้
  const rgTh = { 'risk-on': 'เปิดรับความเสี่ยง 🟢', 'risk-off': 'เลี่ยงความเสี่ยง 🔴', 'neutral': 'เป็นกลาง 🟡', 'unknown': 'ไม่ทราบ' };
  if (rg && rg.regime) {
    const emaTxt = rg.aboveEma200Pct != null ? `${rg.aboveEma200Pct >= 0 ? 'เหนือ' : 'ใต้'} EMA200 ${f2(Math.abs(rg.aboveEma200Pct))}%` : '';
    const ndxTxt = rg.ndxAboveEma200Pct != null ? `${rg.ndxAboveEma200Pct >= 0 ? 'เหนือ' : 'ใต้'} EMA200 ${f2(Math.abs(rg.ndxAboveEma200Pct))}%` : '';
    msg += `\n\n🌐 <b>ภาวะตลาด:</b> ${rgTh[rg.regime] || rg.regime}`;
    msg += `\n     S&P500 $${f2(rg.spxPrice)}${emaTxt ? ' · ' + emaTxt : ''}`;
    if (rg.ndxPrice != null) msg += `\n     Nasdaq 100 $${f2(rg.ndxPrice)}${ndxTxt ? ' · ' + ndxTxt : ''}`;
    msg += `\n     VIX ${f2(rg.vix)}`;
    if (s.regimeEvent) msg += `\n     ⚠️ <b>เพิ่งเปลี่ยน regime วันนี้</b>`;
    const econ = econEventsSoon(5);
    if (econ.length) msg += econ.map(e => `\n     🏛️ <b>${e.name.split(' —')[0].split(' +')[0]}</b> อีก ${e.daysUntil} วัน (${e.date}) — ระวังผันผวน`).join('');
  } else if (s.regimeEvent) {
    msg += `\n\n🌐 <b>ภาวะตลาด</b>\n     ${s.regimeEvent}`;
  }
  if (posAlerts.length) {
    msg += `\n\n📍 <b>หุ้นที่ถืออยู่ — ต้องดู</b>`;
    for (const p of posAlerts) {
      const plTxt = p.plPct >= 0 ? `กำไร +${f2(p.plPct)}%` : `ขาดทุน ${f2(p.plPct)}%`;
      msg += `\n\n▸ <b>${p.symbol}</b>  $${f2(p.price)}  <i>(${plTxt})</i>\n     ${p.alert}`;
      if (comments[p.symbol]) msg += `\n     💬 <i>${comments[p.symbol]}</i>`;
    }
  }
  if ((s.events || []).length) {
    msg += `\n\n🔄 <b>สัญญาณเปลี่ยน</b>`;
    for (const e of s.events) {
      msg += `\n\n▸ <b>${e.symbol}</b>  $${f2(e.price)}\n` + e.changes.map(c => `     • ${c}`).join('\n');
      if (comments[e.symbol]) msg += `\n     💬 <i>${comments[e.symbol]}</i>`;
    }
  }
  msg += `\n${HR}\n💬 = มุมมองจาก AI (framework wall-street-analyzer)\n📊 รายละเอียดเต็ม: stock-dashboard.suvit-ler.workers.dev/decide`;
  const r = await sendTelegram(env, msg);
  return { ok: true, sent: r.ok, events: (s.events || []).length, posAlerts: posAlerts.length, error: r.error };
}

// ============ Phase 4 — LLM JUDGMENT (Gemini schema-bound, enrichment ไม่ใช่ critical path) ============

// เรียก Gemini บังคับ JSON · 2.5-flash free = 20 req/วัน → ถ้าหมด (429) fallback ไป model ที่ quota แยก
// retry 503/500 (overload ชั่วคราว) · ลองหลาย model จนกว่าจะมี quota
async function callGemini(env, prompt, schema, _try = 0, _mi = 0) {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: 'no GEMINI_API_KEY' };
  // pro ก่อน (ฉลาดกว่า — ต้องเปิด billing ใน AI Studio) → ถ้า 429 (ไม่มี billing/quota หมด) fallback flash อัตโนมัติ
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  const model = models[_mi] || models[models.length - 1];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4, maxOutputTokens: 32768 },
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      // quota model นี้หมด (429) → ลอง model ถัดไป (quota แยกต่อ model)
      if (res.status === 429 && _mi < models.length - 1) return callGemini(env, prompt, schema, 0, _mi + 1);
      // overload ชั่วคราว (503/500) → รอแล้วลองใหม่ model เดิม
      if ((res.status === 503 || res.status === 500) && _try < 2) {
        await new Promise(r => setTimeout(r, 2000 * (_try + 1)));
        return callGemini(env, prompt, schema, _try + 1, _mi);
      }
      return { ok: false, status: res.status, error: (j.error && j.error.message) || 'gemini error' };
    }
    const txt = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
    if (!txt) return { ok: false, error: 'empty response' };
    return { ok: true, data: JSON.parse(txt), model };
  } catch (e) { return { ok: false, error: e && e.message }; }
}

// วิเคราะห์ 1 ชุด (chunk) ด้วย Gemini — framework อิง wall-street-analyzer (5 แกน + weak/bright + scenario + RR)
async function thesisBatch(env, cands, rg) {
  const n = (x, s = '') => (x == null ? '—' : x + s);
  const lines = cands.map(c => {
    const e = c.earnings;
    return `━━ ${c.symbol} (${c.name})${c.held ? ` [★ ถืออยู่ ${qtyFmt(c.heldQty)} หุ้น]` : ''} ━━
ราคา $${n(c.price)} · conviction(ระบบ) ${n(c.conviction)} · engine: ${c.stance} (${c.reason})
แนวโน้ม: EMA50 ${n(c.ema50)} / EMA200 ${n(c.ema200)} / SMA200 ${n(c.sma200)} · Bollinger ${n(c.bollLower)}–${n(c.bollUpper)}
โมเมนตัม: RSI วัน ${n(c.rsi)} / สัปดาห์ ${n(c.rsiWeekly)} · MACD hist ${n(c.macdHist)} · ROC10 ${n(c.roc10, '%')} · เปลี่ยนวันนี้ ${n(c.changePct, '%')}
เงินทุน/ความแข็ง: CMF ${n(c.cmf)} · RS vs SPX ${n(c.rsVsSpx, '%')} · Volume ${n(c.volRatio, 'x')} เทียบเฉลี่ย
ผันผวน: ATR ${n(c.atr14)} · Beta ${n(c.beta1y)}
52สัปดาห์: ห่างจุดสูงสุด ${n(c.pctFrom52High, '%')} · เหนือจุดต่ำสุด ${n(c.pctFrom52Low, '%')} (range ${n(c.week52Low)}–${n(c.week52High)})
ระดับที่วางไว้: entry ${n(c.entry)} / SL ${n(c.sl)} / TP ${n(c.tp)}${e && e.daysUntil != null ? `\nงบ: อีก ${e.daysUntil} วัน (${e.date})` : ''}${c.impliedMove && c.impliedMove.pct ? ` · options คาดเหวี่ยง ±${c.impliedMove.pct}%` : ''}`;
  }).join('\n\n');
  const prompt = `คุณคือนักวิเคราะห์หุ้นระดับ buy-side (กองทุน) สายตรงไปตรงมา ไม่อวย ยึดความจริง เขียนเหมือนรายงานส่ง portfolio manager — ทุกประโยคอ้างตัวเลขจริง ห้ามพูดกว้าง ๆ
สภาวะตลาด: ${rg.regime} (S&P500 ${rg.aboveEma200Pct}% เทียบ EMA200, VIX ${rg.vix})
ตัวที่มี [★ ถืออยู่] = ถือในพอร์ตแล้ว → ประเมิน "ถือต่อ/ลด/ขาย" · ตัวอื่น = พิจารณาเข้าซื้อใหม่

ข้อมูล:
${lines}

ให้คะแนนในใจ 5 แกน (แกนละ 0-20): (1)Technical: EMA stack+RSI zone+MACD (2)Momentum: RSI วัน/สัปดาห์สอดคล้อง+ROC+volume confirm (3)Money/Strength: CMF+RS vs SPX (4)Entry timing: ราคา vs entry zone+งบใกล้+structure (5)Risk-Reward: RR ratio จาก entry/SL/TP — รวมเป็น confidence 0-100 ที่ "มาจากแกนจริง ไม่ปั้น"

ตอบแต่ละตัว (เจาะลึก เฉพาะเจาะจง อ้างตัวเลข):
- setup: อยู่ช่วงไหนของเทรนด์ (เบรก/ไล่ขึ้นนานเกิน/ย่อพักฐาน/สะสม) อ้าง EMA, 52w range, Bollinger
- bull_case: เหตุซื้อเชิงตัวเลข (momentum วัน vs สัปดาห์, volume, CMF, RS)
- bear_case: ความเสี่ยงเฉพาะเจาะจง+ตัวเลข (ห่าง entry/52w-high กี่%, RSI สัปดาห์, Beta, งบใกล้)
- scenario: Bear/Base/Bull สั้น ๆ พร้อมราคาเป้าแต่ละกรณี (Bull ต้องมีเหตุจริง ห้ามเพ้อ)
- rr_ratio: RR ratio (number) จาก (TP-ราคา)/(ราคา-SL) ถ้ามี ไม่งั้นประเมินจาก key levels
- key_levels: แนวรับ/แนวต้าน/จุดเข้าที่ดี (ตัวเลขจริง)
- entry_target: ราคาที่ "ควรเข้าซื้อ" ที่ดีที่สุด เป็นตัวเลขราคาเดียว (number) — ถ้าควรรอย่อใส่ราคาย่อ, ถ้าเข้าได้เลยใส่ราคาปัจจุบัน, ถ้า avoid ใส่ 0
- action_plan: เป็นขั้นชัด ระบุราคาทุกจุด — (1)เข้า:เลย/รอย่อถึงเท่าไร (2)ขนาด:เต็ม/ครึ่ง/แบ่งไม้ (3)เพิ่ม:ที่ราคาไหน (4)ลด/ขายบางส่วน:ที่ราคาไหน (5)timeframe — ตัวที่ถืออยู่ให้บอกถือต่อ/ลด/ขาย
- weak_point: ปัจจัย "อ่อนสุด" ของตัวนี้ (แกนที่คะแนนต่ำสุด) + เหตุผล
- bright_point: จุด/เงื่อนไขที่จะทำให้ thesis "กลับมาน่าสนใจ" (เช่น ถ้าราคาลงถึง $X พร้อม volume กลับ)
- stance: buy/wait/avoid (ถ้าถืออยู่ใช้ hold/reduce/sell ได้)
- confidence: 0-100 (จาก 5 แกน)
- invalidation + invalidation_price: ราคาที่หลุดแล้ว thesis พัง
- missing_info: ข้อมูลที่ขาด

กฎ: อ้างตัวเลขจริงทุก field · ห้ามอวย ห้ามกว้าง · ข้อมูลไม่พอบอกตรง ๆ · งบ ≤7 วันเตือน gap · ตอบไทย`;
  const itemSchema = {
    type: 'object',
    properties: {
      symbol: { type: 'string' }, stance: { type: 'string' }, confidence: { type: 'integer' },
      setup: { type: 'string' }, bull_case: { type: 'string' }, bear_case: { type: 'string' },
      scenario: { type: 'string' }, rr_ratio: { type: 'number' }, entry_target: { type: 'number' },
      key_levels: { type: 'string' }, action_plan: { type: 'string' },
      weak_point: { type: 'string' }, bright_point: { type: 'string' },
      invalidation: { type: 'string' }, invalidation_price: { type: 'number' }, missing_info: { type: 'string' },
    },
    required: ['symbol', 'stance', 'confidence', 'setup', 'bull_case', 'bear_case', 'scenario', 'key_levels', 'action_plan', 'weak_point', 'bright_point', 'invalidation'],
  };
  const schema = { type: 'object', properties: { theses: { type: 'array', items: itemSchema } }, required: ['theses'] };
  const r = await callGemini(env, prompt, schema);
  if (!r.ok) return { error: r.error, theses: [] };
  const theses = (r.data && r.data.theses) || [];
  // journal
  if (env.JOURNAL && theses.length) {
    const ts = new Date().toISOString();
    const cmap = {}; cands.forEach(c => { cmap[c.symbol] = c; });
    const stmt = env.JOURNAL.prepare(`INSERT INTO decision_journal (ts_iso, symbol, action, conviction, thesis, invalidation_price, confidence) VALUES (?,?,?,?,?,?,?)`);
    const batch = theses.map(t => stmt.bind(
      ts, t.symbol, t.stance, cmap[t.symbol] ? cmap[t.symbol].conviction : null,
      JSON.stringify({ setup: t.setup, bull: t.bull_case, bear: t.bear_case, scenario: t.scenario, key_levels: t.key_levels, action_plan: t.action_plan, weak: t.weak_point, bright: t.bright_point, invalidation: t.invalidation, missing: t.missing_info }),
      t.invalidation_price != null ? t.invalidation_price : null, t.confidence != null ? t.confidence : null
    ));
    await env.JOURNAL.batch(batch).catch(() => {});
  }
  const bySym = {}; cands.forEach(c => { bySym[c.symbol] = c; });
  const enriched = theses.map(t => ({ ...t,
    engineConviction: bySym[t.symbol] ? bySym[t.symbol].conviction : null,
    engineStance: bySym[t.symbol] ? bySym[t.symbol].stance : null,
    held: bySym[t.symbol] ? !!bySym[t.symbol].held : false,
    heldQty: bySym[t.symbol] ? bySym[t.symbol].heldQty : 0 }));
  return { theses: enriched };
}

// สร้าง thesis ทุกตัวในหน้าเดียว · cache 6 ชม. (Gemini 2.5-flash free = 20 req/วัน ต้องประหยัด) · ?refresh=1 บังคับใหม่
async function generateThesis(env, opts = {}) {
  if (!opts.refresh) {
    try {
      const raw = await env.WATCHLIST.get('thesisCache');
      if (raw) { const c = JSON.parse(raw); if (c && c.ts && (Date.now() - c.ts) < 6 * 3600 * 1000 && c.data) return { ...c.data, cached: true, cachedAt: c.ts }; }
    } catch (e) {}
  }
  const dec = await computeDecision(env, { lite: true });
  const heldQty = {};
  try {
    const raw = await env.WATCHLIST.get('positions');
    (JSON.parse(raw || '[]') || []).forEach(p => { const s = String(p && p.symbol || '').toUpperCase(); if (s) heldQty[s] = (heldQty[s] || 0) + (+p.qty || 0); });
  } catch (e) {}
  const heldSet = new Set(Object.keys(heldQty).filter(s => heldQty[s] > 0));
  const byConv = (a, b) => (b.conviction || 0) - (a.conviction || 0);
  const pool = dec.candidates.filter(c => c.conviction != null);
  const held = pool.filter(c => heldSet.has(c.symbol)).sort(byConv);
  const watchInteresting = pool.filter(c => !heldSet.has(c.symbol) && (c.stance === 'buy' || (c.stance === 'wait' && (c.conviction || 0) >= 50))).sort(byConv);
  const all = [...held, ...watchInteresting];
  all.forEach(c => { c.held = heldSet.has(c.symbol); c.heldQty = heldQty[c.symbol] || 0; });
  if (!all.length) return { ok: true, theses: [], total: 0, heldCount: 0, note: 'ไม่มี candidate ให้วิเคราะห์' };
  const PER = 12;   // 1 request ต่อ generate (ประหยัด quota 20/วัน) · เกิน 12 ค่อยแตก batch
  let theses = [], err = null;
  for (let i = 0; i < all.length; i += PER) {
    const b = await thesisBatch(env, all.slice(i, i + PER), dec.regime);
    if (b.error && !theses.length) { err = b.error; break; }
    theses = theses.concat(b.theses || []);
  }
  if (!theses.length && err) return { ok: false, error: err };
  // เก็บ entry_target/invalidation ที่ LLM ตั้ง → surprise เช็คราคาแตะแล้วเตือน (#4)
  try {
    const levels = {};
    theses.forEach(t => { if (t.symbol && (t.entry_target > 0 || t.invalidation_price > 0)) levels[String(t.symbol).toUpperCase()] = { entry: +t.entry_target || 0, inv: +t.invalidation_price || 0, stance: t.stance }; });
    if (Object.keys(levels).length) await env.WATCHLIST.put('thesisLevels', JSON.stringify({ updated: Date.now(), levels }));
  } catch (e) {}
  const result = { ok: true, regime: dec.regime.regime, count: theses.length, total: all.length, heldCount: held.length, theses };
  try { await env.WATCHLIST.put('thesisCache', JSON.stringify({ ts: Date.now(), data: result })); } catch (e) {}
  return result;
}

// HEARTBEAT — dead-man's switch สำหรับ daily cron (ข้อมูล journal ย้อนเก็บไม่ได้ → cron ล้มเงียบ = หายนะ)
// ตั้ง secret HEARTBEAT_URL (เช่น https://hc-ping.com/<uuid> จาก healthchecks.io ฟรี):
//   สำเร็จ/วันหยุด → ping URL · ล้ม → ping URL/fail · ถ้า cron ไม่รันเลย บริการจะเตือนเอง (ครอบ Yahoo บล็อก/worker ตาย)
// ไม่ตั้ง HEARTBEAT_URL ก็ข้ามเงียบ ๆ — failure ยังเด้ง Telegram อยู่ดี (ดู runDailyCron)
async function pingHeartbeat(env, ok, detail) {
  if (!env.HEARTBEAT_URL) return;
  const url = ok ? env.HEARTBEAT_URL : env.HEARTBEAT_URL.replace(/\/$/, '') + '/fail';
  try { await fetch(url, { method: 'POST', body: String(detail || '').slice(0, 500) }); } catch (e) {}
}

// daily cron รวมศูนย์ — warm cache → snapshot (มี holiday guard) → surprise alert → heartbeat
// • snapshot skip (วันหยุด/ข้อมูลค้าง) = cron ทำงานถูกต้อง → ping success (กัน healthchecks false-alarm วันหยุด)
// • snapshot ล้ม = ข้อมูลที่ย้อนเก็บไม่ได้หาย → ping /fail + เด้ง Telegram (failure คือ surprise จริง ฝ่าหลัก surprise-only ได้)
// • surprise alert ล้ม (LLM/Telegram hiccup) ไม่ทำให้ทั้ง cron fail — snapshot คือของสำคัญ เก็บได้ก็พอ
async function runDailyCron(env) {
  let summary = '';
  try {
    const raw = await env.WATCHLIST.get('main');
    const syms = (JSON.parse(raw || '[]') || []).map(w => w && w.symbol).filter(Boolean);
    await warmEarnings(env, syms);
    await warmFundamentals(env, syms);
    const snap = await logDailySnapshot(env);
    if (snap.skipped) {
      await pingHeartbeat(env, true, `skip: ${snap.reason} (lastBar ${snap.etLastBar} ≠ today ${snap.etToday})`);
      return { ok: true, skipped: true, reason: snap.reason };
    }
    if (!snap.ok) throw new Error('snapshot: ' + (snap.error || 'unknown'));
    summary = `snapshot ${snap.rows} rows @ ${snap.date} (via ${snap.via})`;
    // Yahoo ล้ม → วิ่ง Stooq fallback · ระบบยังรอด แต่ควรรู้ว่า primary source มีปัญหา (heartbeat ยังเขียว)
    if (snap.via && snap.via !== 'yahoo') {
      await sendTelegram(env, `ℹ️ <b>Data fallback ทำงาน</b>\nYahoo ดึงไม่ได้ — snapshot วันนี้ใช้ <b>Stooq</b> (${snap.via}) แทน · ระบบยังทำงานปกติ แต่เช็ค Yahoo ด้วย`).catch(() => {});
    }
    const alert = await runSurpriseAlert(env).catch(e => ({ ok: false, error: e && e.message }));
    const reslog = await logResolutions(env).catch(e => ({ ok: false, error: e && e.message }));   // B — log verdict รายวัน → calibration
    await pingHeartbeat(env, true, summary + (alert && alert.sent ? ' · alert sent' : (alert && alert.error ? ' · alert ERR: ' + alert.error : '')) + (reslog && reslog.logged ? ` · resolution ${reslog.logged}` : ''));
    return { ok: true, ...snap, alert, reslog };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error('daily cron:', msg);
    await pingHeartbeat(env, false, msg);
    await sendTelegram(env, `⚠️ <b>Daily cron ล้มเหลว</b>\n${summary ? summary + '\n' : ''}<code>${msg.slice(0, 300)}</code>\nsnapshot วันนี้อาจหาย — ข้อมูล journal ย้อนเก็บไม่ได้`).catch(() => {});
    return { ok: false, error: msg };
  }
}

// CATCH-UP SNAPSHOT — รัน 01:00 UTC (≈2 ชม.หลัง daily cron 22:00) เผื่อตอน 22:00 Yahoo ส่งแท่งวันนี้ช้า → daily skip
// idempotent (INSERT OR IGNORE) → ถ้า daily ลงไปแล้ว = no-op · ถ้า daily skip เพราะ lag = อันนี้ backfill ให้ · ไม่ยิง alert/heartbeat ซ้ำ
async function runCatchupSnapshot(env) {
  const snap = await logDailySnapshot(env).catch(e => ({ ok: false, error: e && e.message }));
  // ลง snapshot สำเร็จ (ไม่ skip) → log resolution วันนั้นด้วย (idempotent) เผื่อ daily ก็ skip ไป
  if (snap && snap.ok && !snap.skipped) await logResolutions(env).catch(() => {});
  if (snap && snap.skipped && snap.weekday) await pingHeartbeat(env, true, `catch-up ยัง stale (${snap.etLastBar}≠${snap.etToday}) — Yahoo lag ยาว`).catch(() => {});
  return snap;
}

// CSV ของ signal_history — ใช้ทั้ง /api/journal-export และ backup รายสัปดาห์ (source เดียว กัน duplication ตาม [[signal-three-places]])
async function journalCsv(env, days = 3650) {
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const { results } = await env.JOURNAL.prepare(
    `SELECT * FROM signal_history WHERE ts_date >= ? ORDER BY ts_date, symbol`
  ).bind(since).all();
  const rows = results || [];
  const cols = ['ts_date','symbol','signal','price','regular_close','rsi','rsi_weekly','macd_hist','cmf','rs_vs_spx','atr14','beta1y','ema50','ema200','sma200','change_pct','spx_change','spx_price','conviction','regime'];
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(',')));
  return { csv: lines.join('\n'), count: rows.length };
}

// ส่งไฟล์เข้า Telegram (sendDocument, multipart) — ใช้ backup journal แบบ off-Cloudflare
async function sendTelegramDocument(env, filename, content, caption) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, error: 'no telegram secret' };
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chat));
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    fd.append('document', new Blob([content], { type: 'text/csv' }), filename);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: j.description || 'telegram error' };
    return { ok: true };
  } catch (e) { return { ok: false, error: e && e.message }; }
}

// BACKUP รายสัปดาห์ — ดัมป์ journal ทั้งหมดเป็น CSV ส่งเข้า Telegram (เก็บนอก Cloudflare กัน D1 ลบผิด/free-tier มีปัญหา)
// ข้อมูล signal_history ย้อนเก็บไม่ได้ → manual backup = ไม่เกิดจริง · cron เสาร์ทำให้อัตโนมัติ · ล้ม = เด้ง Telegram เตือน
async function runWeeklyBackup(env) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  try {
    const { csv, count } = await journalCsv(env);
    if (!count) return { ok: true, count: 0, note: 'journal ว่าง ยังไม่ backup' };
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const r = await sendTelegramDocument(env, `journal-${today}.csv`, csv, `🗄️ <b>สำรอง Decision Journal</b>\n${count} แถว · ${today}`);
    if (!r.ok) {
      await sendTelegram(env, `⚠️ <b>Backup journal ล้มเหลว</b>\n<code>${String(r.error || '').slice(0, 200)}</code>`).catch(() => {});
      return { ok: false, error: r.error };
    }
    return { ok: true, count };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error('weekly backup:', msg);
    await sendTelegram(env, `⚠️ <b>Backup journal ล้มเหลว</b>\n<code>${msg.slice(0, 200)}</code>`).catch(() => {});
    return { ok: false, error: msg };
  }
}

// AUTH gate — endpoint ที่เขียน state / debug / เปิดข้อมูลดิบ · กัน public .workers.dev URL โดน scan/abuse (เผา quota, เขียน D1, info leak)
// ตั้ง secret ADMIN_TOKEN → ส่งผ่าน header `X-Admin-Token` หรือ `?token=` · ไม่ตั้ง = ไม่ gate (backward-compatible — ตั้งแล้วค่อย active)
function requireAdmin(request, env, url) {
  if (!env.ADMIN_TOKEN) return null;
  const tok = request.headers.get('X-Admin-Token') || url.searchParams.get('token') || '';
  if (tok !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  return null;
}

// ============ Phase 5 — CIO LAYER (deterministic · ไม่ใช้ Gemini) ============
// M36 Portfolio Defense · M37 Capital Allocation · M38 Portfolio Scenario
// หลักการ: เลขมาจากสูตร/ข้อมูลจริง (regime, conviction, beta) ไม่ให้ LLM เดา → เลี่ยง false precision
// ตัวเลขที่อิงค่าประมาณ (beta, marketMove สมมติ) ต้องติด assumption ใน output เสมอ

// ---------- M36 — PORTFOLIO DEFENSE / KILL SWITCH ----------
// นับ trigger จาก market-regime indicators (ที่ getRegime คำนวณไว้แล้ว) → ระดับ 0-3
// แยกจาก kill-switch เดิมใน computeDecision (อันนั้นนับ "แพ้ติดกัน" จาก trade_log — คนละเรื่อง)
const DEFENSE_LEVELS = {
  0: { tag: 'ปกติ',            trimTacticalPct: 0,   action: 'ไม่มี trigger ตลาดเปิด — ลงทุนตามแผนปกติได้' },
  1: { tag: 'ระวัง (L1)',       trimTacticalPct: 20,  action: 'หยุด DCA/เปิดไม้ใหม่ · ลด tactical 20% · ขึ้น cash buffer · ตั้ง SL ให้แน่น' },
  2: { tag: 'ตั้งรับ (L2)',      trimTacticalPct: 50,  action: 'ลด tactical 50% (trim high-beta ก่อน) · เก็บ core/defensive · งดเปิดไม้ใหม่' },
  3: { tag: 'ป้องกันทุน (L3)',   trimTacticalPct: 100, action: 'ขาย tactical ออกทั้งหมด · ถือเงินสดให้มาก (~40%+) · เหลือเฉพาะ anchor (core) + defensive · งดเก็งกำไร' },
};
// PURE: ประเมินระดับ defense จาก regime object (จาก getRegime/computeRegimeRaw) — testable ไม่ต้อง network
function defenseAssess(regime) {
  const r = regime || {};
  const triggers = [];
  if (r.ndxAboveEma200Pct != null && r.ndxAboveEma200Pct < 0) triggers.push(`Nasdaq-100 ต่ำกว่า EMA200 (${r.ndxAboveEma200Pct}%)`);
  if (r.aboveEma200Pct != null && r.aboveEma200Pct < 0) triggers.push(`S&P500 ต่ำกว่า EMA200 (${r.aboveEma200Pct}%)`);
  const vix = r.vix;
  const vixPanic = vix != null && vix > 35;
  if (vixPanic) triggers.push(`VIX ${vix} > 35 (panic)`);
  else if (vix != null && vix > 25) triggers.push(`VIX ${vix} > 25 (ตลาดเริ่มกลัว)`);
  if (r.creditOk === false) triggers.push('เครดิต HYG อ่อน (ต่ำกว่า EMA50) — risk-off นำตลาด');
  if (r.breadthOk === false) triggers.push('breadth RSP อ่อน (ต่ำกว่า EMA50) — rally แคบ');
  let level = Math.min(3, triggers.length);
  if (vixPanic) level = 3;                 // VIX>35 บังคับ L3 แม้ trigger อื่นยังไม่ครบ
  return { level, triggers, ...DEFENSE_LEVELS[level] };
}
// "ห่างจาก trigger แค่ไหน" (เมื่อยังไม่เปิด) — บอกผู้ใช้ว่าใกล้โดนข้อไหน
function defenseHeadroom(regime) {
  const r = regime || {}, near = [];
  if (r.aboveEma200Pct != null && r.aboveEma200Pct >= 0) near.push(`S&P500 เหนือ EMA200 +${r.aboveEma200Pct}% (หลุด 0% = trigger)`);
  if (r.ndxAboveEma200Pct != null && r.ndxAboveEma200Pct >= 0) near.push(`Nasdaq-100 เหนือ EMA200 +${r.ndxAboveEma200Pct}%`);
  if (r.vix != null && r.vix <= 25) near.push(`VIX ${r.vix} (trigger ที่ 25 / panic 35)`);
  return near;
}
async function computeDefense(env) {
  let watch = [];
  try { const raw = await env.WATCHLIST.get('main'); if (raw) watch = JSON.parse(raw); } catch (e) {}
  const watchMap = {}; watch.forEach(w => { if (w && w.symbol) watchMap[String(w.symbol).toUpperCase()] = w; });
  const [regime, port, wd] = await Promise.all([
    getRegime(env),
    computePortfolio(env).catch(() => null),
    computeWatchlistData(env, { cached: true }).catch(() => null),
  ]);
  const betaMap = {};
  if (wd && wd.stocks) wd.stocks.forEach(s => { if (s && s.symbol && s.beta1y != null) betaMap[String(s.symbol).toUpperCase()] = s.beta1y; });
  const assess = defenseAssess(regime);
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  const holdings = (port && port.positions) ? port.positions.filter(h => h.ok) : [];
  const totalVal = holdings.reduce((s, h) => s + (h.value || 0), 0);
  // weighted beta — เกราะกันเลขเพี้ยน: beta ที่ไม่น่าเชื่อถือ (ติดลบ/ใกล้ 0) ใช้ 1.0 แทน กัน VaR ต่ำเกินจริง
  let wBetaNum = 0, betaCov = 0; const betaBad = [];
  holdings.forEach(h => {
    if (totalVal <= 0) return;
    const raw = betaMap[h.symbol];
    if (raw == null) return;                            // ไม่มี beta เลย → coverage ไม่นับ
    if (!betaReliable(raw)) betaBad.push(h.symbol);
    const w = h.value / totalVal;
    wBetaNum += w * betaForRisk(raw); betaCov += w;     // substitute 1.0 ถ้าเพี้ยน
  });
  const weightedBeta = betaCov > 0 ? wBetaNum / betaCov : null;
  // trim plan — tactical (non-core) เรียง beta สูง→ต่ำ trim ก่อน · core เก็บไว้ · beta เพี้ยน → ใช้ riskBeta จัดอันดับ
  const plan = holdings.map(h => {
    const core = isCore(h.symbol, watchMap[h.symbol]);
    const beta = betaMap[h.symbol] != null ? betaMap[h.symbol] : null;
    const betaOk = betaReliable(beta);
    const trimPct = core ? 0 : assess.trimTacticalPct;
    const sharesToSell = trimPct > 0 ? +(h.qty * trimPct / 100).toFixed(4) : 0;
    const valueFreed = trimPct > 0 ? +(sharesToSell * (h.price || 0)).toFixed(2) : 0;
    return { symbol: h.symbol, name: h.name, core, beta: rnd(beta), betaReliable: betaOk, weight: rnd(h.weight), price: rnd(h.price),
      qty: h.qty, trimPct, sharesToSell, valueFreed, keep: core || trimPct === 0 };
  }).sort((a, b) => (b.core === a.core) ? (betaForRisk(b.beta) - betaForRisk(a.beta)) : (a.core ? 1 : -1));  // tactical ก่อน, beta(เพื่อเสี่ยง)สูงก่อน
  const totalFreed = +plan.reduce((s, p) => s + (p.valueFreed || 0), 0).toFixed(2);
  return {
    updated: new Date().toISOString(),
    regime: { regime: regime.regime, vix: regime.vix, spxAboveEma200Pct: regime.aboveEma200Pct, ndxAboveEma200Pct: regime.ndxAboveEma200Pct, creditOk: regime.creditOk, breadthOk: regime.breadthOk },
    level: assess.level, levelTag: assess.tag, triggers: assess.triggers, action: assess.action,
    headroom: assess.level === 0 ? defenseHeadroom(regime) : [],
    portfolioValue: rnd(totalVal), weightedBeta: rnd(weightedBeta), betaCoveragePct: rnd(betaCov * 100),
    trimPlan: plan, totalFreed,
    betaUnreliable: betaBad,
    assumptions: [
      betaBad.length ? `⚠️ beta ของ ${betaBad.join('/')} เพี้ยน (ติดลบ/ใกล้ 0 — ข้อมูล fallback) → ใช้ 1.0 แทนในการคิดเสี่ยง · ค่าจริงน่าจะสูงกว่า (หุ้นพวกนี้เป็น high-beta) = ความเสี่ยงจริงอาจมากกว่าที่แสดง` : null,
      'trigger อิง market-regime indicators ที่คำนวณจากราคาจริง (SPX/NDX vs EMA200, VIX, HYG, RSP)',
      'weighted beta เป็นค่าประมาณ (beta 1y, ครอบคลุม ' + (rnd(betaCov * 100) ?? 0) + '% ของพอร์ต) — ใช้ชี้ขนาดความเสี่ยงสัมพัทธ์ ไม่ใช่พยากรณ์เป๊ะ',
      'cash level จริงไม่ได้ track ในระบบ → L3 บอกเป้าหมาย cash เชิงทิศทาง ไม่ใช่คำนวณจากเงินสดจริง',
    ].filter(Boolean),
    note: 'M36 Portfolio Defense (deterministic) — ไม่ใช้ LLM · ไม่ใช่คำแนะนำการลงทุน',
  };
}

// ---------- M37 — CAPITAL ALLOCATION RANKING ----------
// PURE: จัดอันดับ candidate (จาก computeDecision) ด้วย conviction จริง + ปรับ zone/earnings/overweight แล้วแบ่งงบ
function allocationRank(candidates, weightMap, opts = {}) {
  const maxW = opts.maxWeightPct != null ? opts.maxWeightPct : 15;   // เพดานน้ำหนัก: overweight กว่านี้ = ไม่รับเงินใหม่
  const budget = +opts.budget || 0;
  const wm = weightMap || {};
  const ranked = (candidates || []).filter(c => c && c.conviction != null).map(c => {
    const w = wm[c.symbol] || 0;
    const reasons = [];
    let eligible = true;
    if (c.stance === 'avoid') { eligible = false; reasons.push('engine = avoid'); }
    if (w >= maxW) { eligible = false; reasons.push(`overweight แล้ว ${(+w).toFixed(1)}% ≥ เพดาน ${maxW}% — ไม่เพิ่มแม้คะแนนดี`); }
    let zone = 'n/a';
    if (c.entry > 0 && c.price > 0) {
      const overPct = (c.price - c.entry) / c.entry * 100;
      if (c.price <= c.entry * 1.02) zone = 'in';
      else if (c.price <= c.entry * 1.05) zone = 'near';
      else { zone = 'above'; reasons.push(`เกิน entry zone +${overPct.toFixed(1)}% — รอย่อ`); }
    }
    const ed = c.earnings && c.earnings.daysUntil;
    const earnSoon = ed != null && ed >= 0 && ed <= 7;
    if (earnSoon && ed <= 3) { eligible = false; reasons.push(`งบ ≤${ed} วัน — รอผ่านงบก่อน`); }
    else if (earnSoon) reasons.push(`งบอีก ${ed} วัน — ลดน้ำหนัก`);
    let allocScore = c.conviction;
    if (zone === 'near') allocScore -= 5;
    if (zone === 'above') allocScore -= 15;
    if (earnSoon) allocScore -= 8;
    if (w > 0 && w < maxW) allocScore += Math.round((maxW - w) / maxW * 5);   // underweight bonus เล็กน้อย (สูงสุด +5)
    return { symbol: c.symbol, name: c.name, conviction: c.conviction, stance: c.stance, weight: +(+w).toFixed(2),
      zone, earnSoon, eligible, allocScore: Math.round(allocScore), reasons, price: c.price, entry: c.entry };
  }).sort((a, b) => b.allocScore - a.allocScore);
  // แบ่งงบ: เฉพาะ eligible + ไม่ above-zone · top 3 · สัดส่วนตาม allocScore · ที่เหลือเข้า cash
  const fundable = ranked.filter(r => r.eligible && r.zone !== 'above').slice(0, 3);
  const sumScore = fundable.reduce((s, r) => s + Math.max(0, r.allocScore), 0);
  let allocations = [], allocated = 0;
  if (budget > 0 && sumScore > 0) {
    allocations = fundable.map(r => {
      const usd = +(budget * Math.max(0, r.allocScore) / sumScore).toFixed(2);
      const shares = r.price > 0 ? +(usd / r.price).toFixed(4) : null;
      allocated += usd;
      return { symbol: r.symbol, usd, shares, zone: r.zone, allocScore: r.allocScore };
    });
  }
  const toCash = budget > 0 ? +(budget - allocated).toFixed(2) : 0;
  return { ranked, allocations, budget, allocated: +allocated.toFixed(2), toCash, maxWeightPct: maxW };
}
async function computeAllocation(env, budget) {
  const dec = await computeDecision(env).catch(() => null);
  if (!dec || dec.error) return { ok: false, error: (dec && dec.error) || 'decision engine error' };
  const port = await computePortfolio(env).catch(() => null);
  const weightMap = {};
  if (port && port.positions) port.positions.forEach(p => { if (p.ok) weightMap[p.symbol] = p.weight; });
  const r = allocationRank(dec.candidates, weightMap, { budget: +budget || 0 });
  return {
    ok: true, updated: new Date().toISOString(), regime: dec.regime.regime, buyThresh: dec.buyThresh,
    budget: r.budget, allocations: r.allocations, allocated: r.allocated, toCash: r.toCash, maxWeightPct: r.maxWeightPct,
    ranked: r.ranked,
    assumptions: [
      'อันดับใช้ conviction จริงจาก decision engine (5 มิติ regime-weighted) — ไม่ใช่ LLM เดา',
      'น้ำหนักปัจจุบันจากพอร์ตจริง · overweight ≥ ' + r.maxWeightPct + '% = ตัดออกจากการรับเงินใหม่',
      'การแบ่งงบเป็น "ลำดับความน่าสนใจ" ไม่ใช่คำสั่งซื้อ · เช็ค entry zone + งบ ก่อนเข้าจริงเสมอ',
    ],
    note: 'M37 Capital Allocation Ranking (deterministic) — ไม่ใช่คำแนะนำการลงทุน',
  };
}

// ---------- M38 — PORTFOLIO SCENARIO ----------
// PURE: ผลพอร์ตต่อฉาก = Σ(weight × beta × marketMove) · expected = Σ(prob × ผลฉาก)
function scenarioOutcome(holdings, betaMap, scenarios) {
  const ok = (holdings || []).filter(h => h && h.value > 0);
  const totalVal = ok.reduce((s, h) => s + h.value, 0);
  const rnd = (x, d = 2) => (x == null || isNaN(x)) ? null : +Number(x).toFixed(d);
  const out = (scenarios || []).map(sc => {
    let ret = 0, cov = 0;
    const moves = [];
    ok.forEach(h => {
      const b = betaMap[h.symbol];
      if (b == null || totalVal <= 0) return;
      const w = h.value / totalVal;
      const stockMove = b * sc.marketMove;        // ผลหุ้นตัวนั้น ≈ beta × ตลาด
      ret += w * stockMove;
      cov += w;
      moves.push({ symbol: h.symbol, movePct: rnd(stockMove), contribPct: rnd(w * stockMove) });
    });
    moves.sort((a, b) => (b.movePct || 0) - (a.movePct || 0));
    return { key: sc.key, label: sc.label, prob: sc.prob, marketMove: sc.marketMove,
      portReturnPct: rnd(ret), betaCoveragePct: rnd(cov * 100),
      bestStock: moves[0] || null, worstStock: moves[moves.length - 1] || null };
  });
  const probSum = (scenarios || []).reduce((s, x) => s + (x.prob || 0), 0);
  const expected = out.reduce((s, o, i) => s + ((scenarios[i].prob || 0) / 100) * (o.portReturnPct || 0), 0);
  return { scenarios: out, expectedReturnPct: rnd(expected), probSum };
}
// ความน่าจะเป็นเริ่มต้นตาม regime (subjective — ปรับได้ผ่าน query) · marketMove = สมมติฐานขนาดการเคลื่อนของตลาด
function defaultScenarios(regime) {
  const probByRegime = {
    'risk-on':  { dovish: 45, neutral: 35, hawkish: 20 },
    'neutral':  { dovish: 35, neutral: 40, hawkish: 25 },
    'risk-off': { dovish: 25, neutral: 35, hawkish: 40 },
  };
  const p = probByRegime[regime] || probByRegime['neutral'];
  return [
    { key: 'dovish',  label: 'Fed Dovish — ลดดอก / soft landing', prob: p.dovish,  marketMove: 8 },
    { key: 'neutral', label: 'Fed Neutral — คงดอก / sideways',     prob: p.neutral, marketMove: 2 },
    { key: 'hawkish', label: 'Fed Hawkish — คงดอกนาน / shock',     prob: p.hawkish, marketMove: -12 },
  ];
}
async function computeScenario(env, overrides = {}) {
  const [regime, port, wd] = await Promise.all([
    getRegime(env),
    computePortfolio(env).catch(() => null),
    computeWatchlistData(env, { cached: true }).catch(() => null),
  ]);
  // เกราะ beta: เพี้ยน (ติดลบ/ใกล้ 0) → ใช้ 1.0 แทน กัน scenario ต่ำเกินจริง
  const betaMap = {}; const betaBad = [];
  if (wd && wd.stocks) wd.stocks.forEach(s => { if (s && s.symbol && s.beta1y != null) { if (!betaReliable(s.beta1y)) betaBad.push(String(s.symbol).toUpperCase()); betaMap[String(s.symbol).toUpperCase()] = betaForRisk(s.beta1y); } });
  const holdings = (port && port.positions) ? port.positions.filter(h => h.ok) : [];
  let scenarios = defaultScenarios(regime.regime);
  // override prob ผ่าน query (?dovish=40&neutral=35&hawkish=25) — ผู้ใช้กำหนดเอง ไม่ให้ LLM ปั้น
  let custom = false;
  scenarios = scenarios.map(s => {
    if (overrides[s.key] != null && !isNaN(+overrides[s.key])) { custom = true; return { ...s, prob: +overrides[s.key] }; }
    return s;
  });
  const r = scenarioOutcome(holdings, betaMap, scenarios);
  return {
    ok: true, updated: new Date().toISOString(), regime: regime.regime,
    scenarios: r.scenarios, expectedReturnPct: r.expectedReturnPct, probSum: r.probSum, probCustom: custom,
    assumptions: [
      'ความน่าจะเป็นแต่ละฉากเป็นค่า subjective (default ตาม regime · ปรับเองได้ผ่าน ?dovish=&neutral=&hawkish=)',
      'ผลพอร์ต ≈ Σ(น้ำหนัก × beta × การเคลื่อนของตลาดสมมติ) · beta เป็นค่าประมาณ 1y',
      betaBad.length ? `⚠️ beta ของ ${betaBad.join('/')} เพี้ยน → ใช้ 1.0 แทน · ผลฉากจริงอาจแรงกว่า (หุ้นพวกนี้ high-beta)` : null,
      'marketMove สมมติ (dovish +8% / neutral +2% / hawkish −12%) เป็นฉากตัวอย่าง — ใช้ชี้ทิศทาง/ขนาดความเสี่ยงสัมพัทธ์ ไม่ใช่พยากรณ์ราคา',
      r.probSum !== 100 ? `⚠️ ผลรวมความน่าจะเป็น = ${r.probSum}% (ไม่ครบ 100%) → expected return จะเพี้ยน` : null,
    ].filter(Boolean),
    note: 'M38 Portfolio Scenario (deterministic math, subjective probabilities) — ไม่ใช่คำแนะนำการลงทุน',
  };
}

// ---------- A2 — CONSENSUS / CONFLICT DETECTOR ----------
// "Judge" ของ multi-agent แต่ทำ deterministic: เทียบ 4 สัญญาณต่อหุ้น (engine · thesis(LLM) · invalidation · defense)
// → จับ "ขัดกันเงียบ" (บทเรียน AVGO: engine HOLD แต่ invalidation บอกพัง) ก่อนผู้ใช้เห็นเอง
// PURE: รับ input แล้วบอก agree/review/conflict + เหตุผล
function reconcile(x) {
  const L = s => String(s || '').toLowerCase();
  const dir = s => { s = L(s); if (s === 'buy' || s === 'core') return 1; if (s === 'avoid' || s === 'reduce' || s === 'sell') return -1; return 0; };
  const bull = s => { s = L(s); return s === 'buy' || s === 'core'; };
  const hardBear = s => { s = L(s); return s === 'avoid' || s === 'sell'; };   // ขัดแรง: LLM บอก "อย่าถือ/ออก"
  const softBear = s => L(s) === 'reduce';                                      // ขัดอ่อน: LLM บอก "ลดน้ำหนัก" (ยังถือ)
  const eng = dir(x.engineStance);
  const flags = [];
  // engine vs thesis(LLM) — แยกความรุนแรง: avoid/sell = conflict · reduce = review (เพิ่ม vs ลด ไม่ใช่ขัดขั้ว)
  if (x.thesisStance) {
    if (bull(x.engineStance) && hardBear(x.thesisStance)) flags.push({ sev: 'conflict', msg: `engine=${x.engineStance} ขัดกับ thesis(AI)=${x.thesisStance}` });
    else if (bull(x.engineStance) && softBear(x.thesisStance)) flags.push({ sev: 'review', msg: `engine=ซื้อ แต่ thesis(AI)=reduce — เพิ่ม vs ลด เช็คน้ำหนัก` });
    else if (hardBear(x.engineStance) && bull(x.thesisStance)) flags.push({ sev: 'conflict', msg: `engine=${x.engineStance} ขัดกับ thesis(AI)=buy` });
  }
  if (x.invStatus === 'breached' && eng >= 0)
    flags.push({ sev: 'conflict', msg: `หลุด invalidation แล้ว แต่ engine ยัง ${x.engineSignal || x.engineStance || '—'}` });
  if (x.defenseLevel >= 2 && eng > 0)
    flags.push({ sev: 'review', msg: `โหมดตั้งรับ L${x.defenseLevel} แต่ engine = ซื้อ` });
  if (x.borderline && x.invStatus === 'near')
    flags.push({ sev: 'review', msg: 'conviction ก้ำกึ่ง + ใกล้ invalidation — สัญญาณเปราะ รอยืนยัน' });
  if (x.invTightPct != null && x.invTightPct < 2 && x.invStatus !== 'breached')
    flags.push({ sev: 'review', msg: `invalidation แคบผิดปกติ (ต่ำกว่าราคาแค่ ${x.invTightPct}%) — เช็คว่าตั้งชิดไป` });
  const status = flags.some(f => f.sev === 'conflict') ? 'conflict' : flags.length ? 'review' : 'agree';
  return { status, flags };
}

// ---------- CONFLICT RESOLUTION — verdict + size (เปลี่ยน "ขัดกัน" → "ตัดสินให้ + ขนาด") ----------
// 5 ชั้น 0-100 จาก signal จริง (M33-style) · fundamental = ชั้นอ่อนสุด (thesis+flags) → ถ่วงน้ำหนักน้อยใน risk-on
function resolveLayers(x) {
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
  const L = s => String(s || '').toLowerCase();
  const tech = x.conviction != null ? x.conviction : 50;                       // engine conviction = ของจริง แม่นสุด
  const fundBase = { buy: 75, core: 70, hold: 55, wait: 50, reduce: 42, avoid: 28, sell: 22 }[L(x.thesisStance)];
  let fund = (fundBase != null ? fundBase : 50) - (x.fundFlagsCount || 0) * 8;  // soft layer — ใส่ assumption
  const macro = { 'risk-on': 70, neutral: 55, 'risk-off': 35 }[x.regime] != null ? { 'risk-on': 70, neutral: 55, 'risk-off': 35 }[x.regime] : 55;
  const maxW = x.maxWeight || 15;
  let fit = x.weight != null ? clamp(100 - (x.weight / maxW) * 60) : 60;        // underweight=สูง · =เพดาน=40 · เกิน=ต่ำ
  if (x.themeConc) fit -= 15;                                                   // กระจุก theme เดียว = หักเพิ่ม (C)
  let risk = x.rr != null ? (x.rr >= 3 ? 85 : x.rr >= 2 ? 70 : x.rr >= 1.5 ? 55 : x.rr >= 1 ? 40 : 25) : 50;
  if (x.invStatus === 'breached') risk -= 25; else if (x.invStatus === 'near') risk -= 10;
  if (x.beta != null && x.beta > 2) risk -= 8;
  return { tech: clamp(tech), fund: clamp(fund), macro: clamp(macro), fit: clamp(fit), risk: clamp(risk) };
}
// E — ถ่วงน้ำหนักตาม regime (สืบทอดปรัชญา CONV_WEIGHTS · risk-off เน้น fundamental/risk · risk-on เน้น technical)
const RESOLVE_WEIGHTS = {
  'risk-on':  { tech: 1.3, fund: 0.8, macro: 1.0, fit: 1.0, risk: 0.9 },
  'neutral':  { tech: 1.0, fund: 1.0, macro: 1.0, fit: 1.0, risk: 1.0 },
  'risk-off': { tech: 0.9, fund: 1.2, macro: 1.1, fit: 1.0, risk: 1.3 },
};
function resolveScore(layers, regime) {
  const W = RESOLVE_WEIGHTS[regime] || RESOLVE_WEIGHTS.neutral;
  let ws = 0, vs = 0;
  for (const k of ['tech', 'fund', 'macro', 'fit', 'risk']) { ws += W[k]; vs += W[k] * layers[k]; }
  return Math.round(vs / ws);
}
// A — verdict + ขนาดไม้ จาก score + บริบท (held winner=reduce path · momentum ใหม่=avoid path)
function resolveVerdict(score, ctx) {
  const t = String((ctx && ctx.thesisStance) || '').toLowerCase();
  const soft = t === 'reduce', hard = t === 'avoid' || t === 'sell';
  if (ctx && ctx.held) {                                   // ถืออยู่ → ตัดสิน "ลด/คง" ไม่ใช่ "เข้าใหม่"
    if (hard) return score >= 60 ? { verdict: 'HOLD ระวัง', size: 'คงไว้ จับตาใกล้ชิด', tone: 'warn' } : { verdict: 'REDUCE', size: 'ลด/ทยอยออก', tone: 'danger' };
    if (soft) return score >= 60 ? { verdict: 'HOLD', size: 'คงไว้', tone: 'info' } : { verdict: 'TRIM', size: 'ลด ~30% เก็บ runner', tone: 'warn' };
  }
  if (score >= 70) return { verdict: 'BUY เล็ก', size: (ctx && ctx.borderline) ? '¼ ไม้' : '½ ไม้', tone: 'success' };
  if (score >= 55) return { verdict: 'WAIT', size: 'ยังไม่เข้า', tone: 'warn' };
  if (score >= 40) return { verdict: 'หลีกเลี่ยงเพิ่ม', size: 'ไม่เพิ่ม', tone: 'warn' };
  return { verdict: 'AVOID', size: 'ไม่เข้า', tone: 'danger' };
}

async function computeConsensus(env) {
  const [dec, posWatch, port] = await Promise.all([
    computeDecision(env).catch(() => null),
    computePositionWatch(env).catch(() => null),
    computePortfolio(env).catch(() => null),
  ]);
  if (!dec || dec.error) return { ok: false, error: (dec && dec.error) || 'decision engine error' };
  const regime = dec.regime.regime;
  const defense = defenseAssess(dec.regime);
  // thesis stance จาก cache (อ่านตรง ไม่ trigger Gemini → ไม่เผา quota)
  const thesisStance = {};
  try { const raw = await env.WATCHLIST.get('thesisCache'); if (raw) { const c = JSON.parse(raw); (((c.data && c.data.theses) || c.theses) || []).forEach(t => { if (t && t.symbol) thesisStance[String(t.symbol).toUpperCase()] = t.stance; }); } } catch (e) {}
  const invMap = {};
  ((posWatch && posWatch.positions) || []).forEach(p => {
    let tightPct = null;
    if (p.invalidationPrice > 0 && p.price > 0 && p.price > p.invalidationPrice)
      tightPct = +(((p.price - p.invalidationPrice) / p.price) * 100).toFixed(1);
    invMap[String(p.symbol).toUpperCase()] = { status: p.status, tightPct };
  });
  const weightMap = {}, heldSet = new Set();
  if (port && port.positions) port.positions.forEach(p => { if (p.ok) { weightMap[p.symbol] = p.weight; heldSet.add(p.symbol); } });
  const engineMap = {};
  [...(dec.candidates || []), ...(dec.core || [])].forEach(c => { engineMap[String(c.symbol).toUpperCase()] = c; });
  const symbols = new Set([...Object.keys(invMap), ...(dec.candidates || []).filter(c => c.stance === 'buy').map(c => String(c.symbol).toUpperCase())]);
  // C — นับ conflict ต่อ theme (รวมเดิมพันที่ correlate เป็นก้อนเดียว)
  const themeCount = {};
  symbols.forEach(sym => { const th = themeOf(sym); if (th) themeCount[th] = (themeCount[th] || 0) + 1; });
  const rr = c => (c && c.tp > 0 && c.sl > 0 && c.price > 0 && c.price > c.sl) ? +(((c.tp - c.price) / (c.price - c.sl))).toFixed(1) : null;
  const items = [];
  symbols.forEach(sym => {
    const c = engineMap[sym] || {};
    const inv = invMap[sym] || {};
    const th = thesisStance[sym] || null;
    const r = reconcile({
      engineStance: c.stance, engineSignal: c.signal, thesisStance: th,
      invStatus: inv.status, invTightPct: inv.tightPct, defenseLevel: defense.level, borderline: !!c.borderline,
    });
    if (r.status === 'agree') return;
    const theme = themeOf(sym);
    const themeConc = theme && themeCount[theme] >= 2;
    const rrv = rr(c);
    const layers = resolveLayers({
      conviction: c.conviction, thesisStance: th, fundFlagsCount: (c.fundFlags || []).length, regime,
      weight: weightMap[sym], maxWeight: 15, themeConc, rr: rrv, beta: c.beta1y, invStatus: inv.status,
    });
    const score = resolveScore(layers, regime);
    const v = resolveVerdict(score, { held: heldSet.has(sym), thesisStance: th, borderline: !!c.borderline });
    items.push({
      symbol: sym, status: r.status, flags: r.flags,
      engineSignal: c.signal || null, engineStance: c.stance || null, thesisStance: th, invStatus: inv.status || null,
      layers, score, verdict: v.verdict, size: v.size, tone: v.tone, rr: rrv, theme: theme || null, themeConc, price: c.price != null ? c.price : null,
    });
  });
  // priority: breached/conflict score ต่ำสุดก่อน (อันตรายสุด)
  const sev = i => (i.status === 'conflict' ? 0 : 1);
  items.sort((a, b) => sev(a) - sev(b) || a.score - b.score);
  // C — theme cluster summary: หุ้นที่ขัด ≥2 ตัวในธีมเดียว = เดิมพันก้อนเดียว
  const byTheme = {};
  items.forEach(i => { if (i.theme) byTheme[i.theme] = (byTheme[i.theme] || 0) + 1; });
  const clusters = Object.entries(byTheme).filter(([, n]) => n >= 2).map(([theme, count]) => ({ theme, count }));
  // F — วันนี้ทำอย่างเดียวพอ: ตัวที่ priority สูงสุด (อันตราย/score ต่ำสุด)
  const top = items[0] || null;
  const topAction = top ? { symbol: top.symbol, verdict: top.verdict, size: top.size, why: (top.flags[0] && top.flags[0].msg) || '', score: top.score } : null;
  return {
    ok: true, updated: new Date().toISOString(), regime, defenseLevel: defense.level,
    conflicts: items.filter(i => i.status === 'conflict').length, reviews: items.filter(i => i.status === 'review').length,
    themeClusters: clusters, topAction, items,
    assumptions: [
      'คะแนน 5 ชั้น: technical=conviction จริง · fundamental=thesis(AI)+flags (ชั้นอ่อนสุด ถ่วงน้ำหนักน้อยใน risk-on) · macro=regime · fit=น้ำหนัก/theme · risk=RR/invalidation/beta',
      'verdict/ขนาดไม้เป็น "คำตัดสินเอนเอียง" จากกฎ deterministic — ไม่ใช่คำสั่งซื้อ ตรวจ entry zone + งบ ก่อนเข้าจริงเสมอ',
      'หุ้นที่ขัดในธีมเดียวกัน = เดิมพันก้อนเดียว (ระวังนับ conviction ซ้ำ)',
    ],
    note: 'Conflict Resolution (deterministic) — engine/thesis/invalidation/defense → verdict+size · ไม่ใช่คำแนะนำการลงทุน',
  };
}

// B — บันทึก verdict รายวันลง D1 → วัด calibration ทีหลัง (เรียกจาก daily cron · idempotent)
async function logResolutions(env) {
  if (!env.JOURNAL) return { ok: false, error: 'no D1' };
  const r = await computeConsensus(env).catch(e => ({ ok: false, error: e && e.message }));
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.items || !r.items.length) return { ok: true, logged: 0 };
  await env.JOURNAL.prepare(`CREATE TABLE IF NOT EXISTS resolution_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_date TEXT NOT NULL, ts_iso TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT, verdict TEXT, score REAL, engine_stance TEXT, thesis_stance TEXT, regime TEXT, price REAL, UNIQUE(ts_date, symbol))`).run().catch(() => {});
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const ts = new Date().toISOString();
  const stmt = env.JOURNAL.prepare(`INSERT OR IGNORE INTO resolution_log (ts_date, ts_iso, symbol, status, verdict, score, engine_stance, thesis_stance, regime, price) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const batch = r.items.map(i => stmt.bind(date, ts, i.symbol, i.status, i.verdict, i.score, i.engineStance, i.thesisStance, r.regime, i.price));
  await env.JOURNAL.batch(batch).catch(() => {});
  return { ok: true, logged: batch.length, date };
}

// /defense — HTML สรุป Portfolio Defense (white card style เหมือน /risk /portfolio)
async function handleDefense(env) {
  const d = await computeDefense(env).catch(e => ({ error: e && e.message }));
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  if (d.error) return new Response(`<p>error: ${esc(d.error)}</p>`, { status: 500, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
  const tm = new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const lvlCol = { 0: '#16a34a', 1: '#ca8a04', 2: '#ea580c', 3: '#dc2626' }[d.level] || '#666';
  const trigHtml = d.triggers.length
    ? d.triggers.map(t => `<li>${esc(t)}</li>`).join('')
    : `<li style="color:#16a34a">ไม่มี trigger ตลาดเปิด${d.headroom.length ? ' — ' + d.headroom.map(esc).join(' · ') : ''}</li>`;
  const trimRows = (d.trimPlan || []).map(p => `<tr>
    <td><b>${esc(p.symbol)}</b> ${p.core ? '<span class=tag>core</span>' : ''}<br><span class=n>${esc(p.name)}</span></td>
    <td class=num>${p.beta == null ? '—' : f(p.beta) + (p.betaReliable === false ? ' <span style="color:#dc2626" title="beta เพี้ยน — ใช้ 1.0 แทนในการคิดเสี่ยง">⚠</span>' : '')}</td>
    <td class=num>${f(p.weight)}%</td>
    <td class=num>${p.keep ? '<span style="color:#16a34a">เก็บไว้</span>' : f(p.trimPct, 0) + '%'}</td>
    <td class=num>${p.sharesToSell ? qtyFmt(p.sharesToSell) : '—'}</td>
    <td class=num>${p.valueFreed ? '$' + f(p.valueFreed, 0) : '—'}</td></tr>`).join('');
  const txt = `Portfolio Defense — ระดับ ${d.level} (${d.levelTag}) · regime ${d.regime.regime} · VIX ${f(d.regime.vix)}\n`
    + `Trigger: ${d.triggers.length ? d.triggers.join(' | ') : 'ไม่มี'}\nAction: ${d.action}\n`
    + `Weighted beta ≈ ${f(d.weightedBeta)} (ครอบคลุม ${f(d.betaCoveragePct, 0)}% ของพอร์ต) · ถ้า trim ตามแผนได้เงินสด ~$${f(d.totalFreed, 0)}`;
  const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Portfolio Defense — L${d.level}</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:900px;margin:18px auto;padding:0 14px;color:#111;background:#fff;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:14px}
.lvl{display:inline-block;padding:6px 14px;border-radius:8px;color:#fff;font-weight:800;font-size:18px;background:${lvlCol}}
.box{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin:12px 0}
.box.act{background:#fff7ed;border-color:#fed7aa}.box h3{margin:0 0 6px;font-size:14px}
ul{margin:6px 0;padding-left:20px}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}
th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}th{background:#f3f4f6}
.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#888;font-size:11px}.tag{background:#dbeafe;color:#1e40af;font-size:10px;padding:1px 5px;border-radius:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:9px 12px;background:#fafafa}.kpi .lab{font-size:12px;color:#666}.kpi .val{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.asm{color:#777;font-size:12px;margin-top:6px}.asm li{margin:2px 0}
.txt{white-space:pre-wrap;font-size:12.5px;color:#444;margin-top:16px;border-top:1px solid #eee;padding-top:10px}</style></head>
<body>
<h1>🛡️ Portfolio Defense / Kill Switch</h1>
<div class=sub>อัปเดต ${esc(tm)} (เวลาไทย) · regime <b>${esc(d.regime.regime)}</b> · VIX ${f(d.regime.vix)} · SPX ${f(d.regime.spxAboveEma200Pct)}% / NDX ${f(d.regime.ndxAboveEma200Pct)}% เทียบ EMA200</div>
<div class=lvl>ระดับ ${d.level} — ${esc(d.levelTag)}</div>
<div class=kpis>
  <div class=kpi><div class=lab>Weighted Beta พอร์ต</div><div class=val>${f(d.weightedBeta)}</div></div>
  <div class=kpi><div class=lab>มูลค่าพอร์ต</div><div class=val>$${f(d.portfolioValue, 0)}</div></div>
  <div class=kpi><div class=lab>เงินสดถ้า trim ตามแผน</div><div class=val>$${f(d.totalFreed, 0)}</div></div>
</div>
<div class=box><h3>🚨 Trigger ที่เปิด (${d.triggers.length})</h3><ul>${trigHtml}</ul></div>
<div class="box act"><h3>📌 Action ระดับ ${d.level}</h3>${esc(d.action)}</div>
<div class=box><h3>✂️ แผน Trim (tactical beta สูง trim ก่อน · core เก็บไว้)</h3>
<table><thead><tr><th>หุ้น</th><th class=num>Beta</th><th class=num>น้ำหนัก</th><th class=num>Trim</th><th class=num>ขาย (หุ้น)</th><th class=num>ได้เงินสด</th></tr></thead>
<tbody>${trimRows || '<tr><td colspan=6 style="text-align:center;color:#888;padding:16px">ไม่มี position ในพอร์ต</td></tr>'}</tbody></table></div>
<div class=box><h3>📋 สมมติฐาน (ห้ามอ่านเป็นตัวเลขเป๊ะ)</h3><ul class=asm>${(d.assumptions || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>
<div class=txt>สรุปข้อความ (สำหรับ AI วิเคราะห์):
${esc(txt)}</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  // cron — (1) "*/15" signal→KV  (2) "0 22 1-5" snapshot+surprise+heartbeat รายวัน  (3) "0 23 6" backup journal รายสัปดาห์
  async scheduled(event, env, ctx) {
    _env = env;
    if (event.cron === '0 22 * * 1-5') {
      ctx.waitUntil(runDailyCron(env));
    } else if (event.cron === '0 1 * * 2-6') {
      ctx.waitUntil(runCatchupSnapshot(env).catch(e => console.error('catch-up snapshot:', e && e.message)));
    } else if (event.cron === '0 23 * * 6') {
      ctx.waitUntil(runWeeklyBackup(env).catch(e => console.error('weekly backup:', e && e.message)));
    } else {
      ctx.waitUntil(writeSignalsToKV(env).catch(e => console.error('writeSignalsToKV:', e && e.message)));
    }
  },
  async fetch(request, env, ctx) {
    _env = env;
    const url = new URL(request.url);

    // /api/secret-check — เช็คว่า worker เห็น secret ไหม (ไม่เปิดค่า) debug
    if (url.pathname === '/api/secret-check') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      return new Response(JSON.stringify({
        gemini: !!env.GEMINI_API_KEY, telegram_token: !!env.TELEGRAM_BOT_TOKEN, telegram_chat: !!env.TELEGRAM_CHAT_ID, heartbeat: !!env.HEARTBEAT_URL, admin: !!env.ADMIN_TOKEN, twelvedata: !!env.TWELVEDATA_API_KEY,
      }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/source-test — เทียบ Yahoo (raw) vs Stooq (fallback) ต่อ symbol · ยืนยันว่า fallback พร้อมใช้ (debug ข้อ 6)
    if (url.pathname === '/api/source-test') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const sym = (url.searchParams.get('sym') || '^GSPC').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const brief = r => r && r.ok
        ? { ok: true, via: r.via, price: r.price, bars: r.closes && r.closes.length, lastBar: r.timestamps && r.timestamps.length ? new Date(r.timestamps[r.timestamps.length - 1] * 1000).toISOString().slice(0, 10) : null }
        : { ok: false, error: r && r.error };
      const [yahoo, fallback, wrapped] = await Promise.all([
        yahooDailyRaw(sym, range, '1d').catch(e => ({ ok: false, error: e && e.message })),
        twelveDailyFallback(sym, range).catch(e => ({ ok: false, error: e && e.message })),
        yahooDaily(sym, range, '1d').catch(e => ({ ok: false, error: e && e.message })),
      ]);
      return new Response(JSON.stringify({ sym, fallbackSymbol: toTwelveSymbol(sym), yahoo: brief(yahoo), fallback: brief(fallback), wrapper: brief(wrapped) }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/gemini-test — ลองหลาย model หาตัวที่ key นี้ใช้ได้ฟรี (debug Phase 4)
    if (url.pathname === '/api/gemini-test') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const key = env.GEMINI_API_KEY;
      if (!key) return new Response(JSON.stringify({ error: 'no key' }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-flash-latest'];
      const out = {};
      for (const m of models) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'reply with: ok' }] }] }),
          });
          const j = await res.json().catch(() => ({}));
          out[m] = res.ok ? '✅ OK' : `${res.status}: ${((j.error && j.error.message) || '').slice(0, 70)}`;
        } catch (e) { out[m] = 'ERR ' + (e && e.message); }
      }
      return new Response(JSON.stringify(out, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/earnings-test — ทดสอบดึงวันงบ (debug catalyst)
    if (url.pathname === '/api/earnings-test') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const sym = (url.searchParams.get('sym') || 'AVGO').toUpperCase();
      const r = await fetchEarnings(sym).catch(e => ({ error: e && e.message }));
      return new Response(JSON.stringify({ sym, result: r }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/warm-earnings — อุ่น cache วันงบทุกตัวใน watchlist (ครั้งเดียว/วัน · cron ทำให้อยู่แล้ว)
    if (url.pathname === '/api/warm-earnings') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      let syms = [];
      try { const raw = await env.WATCHLIST.get('main'); syms = (JSON.parse(raw || '[]') || []).map(w => w && w.symbol).filter(Boolean); } catch (e) {}
      await warmEarnings(env, syms);
      await warmFundamentals(env, syms);
      const out = {}, fund = {};
      for (const s of syms) { out[s] = await fetchEarningsReadOnly(env, s); const f = await fetchFundamentalsReadOnly(env, s); fund[s] = f ? { flags: fundamentalFlags(f), ...f } : null; }
      return new Response(JSON.stringify({ warmed: syms.length, earnings: out, fundamentals: fund }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/refresh-signals — บังคับคำนวณ+เขียน KV ทันที (ทดสอบ / อุ่นเครื่องหลัง deploy)
    if (url.pathname === '/api/refresh-signals') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const sig = await writeSignalsToKV(env).catch(e => ({ error: e && e.message }));
      return new Response(JSON.stringify({ ok: !sig.error, signals: sig }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/snapshot — บังคับ snapshot ลง D1 ทันที (ทดสอบ Phase 0.5 / เก็บย้อนวันนี้) · ?force=1 ข้าม holiday guard
    if (url.pathname === '/api/snapshot') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      const r = await logDailySnapshot(env, force).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/journal-export — สำรองข้อมูล D1 (ข้อมูลย้อนเก็บไม่ได้) · ?format=csv|json · ?days=N · gated (เปิดข้อมูลดิบ)
    if (url.pathname === '/api/journal-export') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      if (!env.JOURNAL) return new Response(JSON.stringify({ error: 'no D1' }), { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } });
      const fmt = (url.searchParams.get('format') || 'json').toLowerCase();
      const days = Math.min(parseInt(url.searchParams.get('days') || '3650', 10) || 3650, 3650);
      if (fmt === 'csv') {
        const { csv } = await journalCsv(env, days);
        return new Response(csv, { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="journal.csv"', 'Cache-Control': 'no-store' } });
      }
      const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const { results } = await env.JOURNAL.prepare(
        `SELECT * FROM signal_history WHERE ts_date >= ? ORDER BY ts_date, symbol`
      ).bind(since).all();
      return new Response(JSON.stringify({ count: (results || []).length, rows: results }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/backup-now — บังคับ backup journal เข้า Telegram ทันที (ทดสอบ cron เสาร์) · gated
    if (url.pathname === '/api/backup-now') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const r = await runWeeklyBackup(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/performance — วัดผลย้อนหลัง JSON (Phase 1)
    if (url.pathname === '/api/performance') {
      const r = await computePerformance(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /performance — วัดผลย้อนหลัง HTML อ่านง่าย
    if (url.pathname === '/performance') {
      const d = await computePerformance(env).catch(e => ({ ok: false, error: e && e.message }));
      const f = (x) => x == null ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(2);
      const col = x => x == null ? '#666' : x > 0 ? '#16a34a' : x < 0 ? '#dc2626' : '#666';
      let body;
      const dd = d.distinctDays || ((d.ok && d.symbols) ? Math.round(d.snapshots / d.symbols) : 0);   // วันทำการที่เก็บได้จริง
      if (!d.ok) {
        body = `<p>ยังไม่มีข้อมูล: ${d.error || 'unknown'}</p>`;
      } else if (d.snapshots < 4) {
        body = `<div class=info><b>กำลังสะสมข้อมูล</b><br>เก็บ snapshot ได้ <b>${dd} วันทำการ</b> (${d.snapshots} แถว · ${d.symbols} หุ้น)${d.dateRange ? ` · ${d.dateRange.from} → ${d.dateRange.to}` : ''}<br>
          horizon X วัน = เทียบ snapshot ห่างกัน X วัน → <b>ต้องมี snapshot X+1 วัน</b> · early read (3 วัน) ต้องมี 4 วัน · ระบบเก็บอัตโนมัติ 05:00 น.ไทย</div>`;
      } else {
        const hzBlock = (h, early) => {
          const hh = d.horizons[h] || {};
          const has = ['BUY', 'HOLD', 'SELL'].some(sig => hh[sig] && hh[sig].n > 0);
          if (!has) {
            const left = Math.max(0, (h + 1) - dd);
            return `<h2>Horizon ${h} วันทำการ</h2><div class=note>⏳ รอข้อมูล — ต้องมี snapshot <b>${h + 1} วัน</b> (มี ${dd}) · ขาดอีก ~${left} วันทำการ</div>`;
          }
          const rowsH = ['BUY', 'HOLD', 'SELL'].map(sig => {
            const s = hh[sig] || { n: 0 };
            return `<tr><td><b>${sig}</b></td><td class=num>${s.n}</td>
              <td class=num style="color:${col(s.beatRate == null ? null : s.beatRate - 50)}">${s.beatRate == null ? '—' : s.beatRate + '%'}</td>
              <td class=num style="color:${col(s.avgExcess)}">${f(s.avgExcess)}%</td>
              <td class=num style="color:${col(s.medianExcess)}">${f(s.medianExcess)}%</td>
              <td class=num style="color:${col(s.avgExcessNet)}"><b>${f(s.avgExcessNet)}%</b></td>
              <td class=num>${s.infoRatio == null ? '—' : s.infoRatio}</td></tr>`;
          }).join('');
          // BUY−SELL spread (net) = discriminating power (สัญญาณแยกแพ้/ชนะได้ไหม ตัดผลตลาดออก)
          const buy = hh.BUY || {}, sell = hh.SELL || {};
          const spread = (buy.avgExcessNet != null && sell.avgExcessNet != null) ? +(buy.avgExcessNet - sell.avgExcessNet).toFixed(2) : null;
          const spreadHtml = spread != null
            ? `<div class=note style="background:#f0fdf4;border-color:#bbf7d0">↔️ <b>BUY−SELL spread (net) = ${f(spread)}%</b> · &gt;0 = สัญญาณแยกแพ้/ชนะได้จริง (edge แท้ ตัดผลตลาด) · n: BUY ${buy.n || 0} / SELL ${sell.n || 0}</div>`
            : `<div class=note>↔️ BUY−SELL spread: รอ SELL signal (ยังไม่มี/น้อย)</div>`;
          // effective independent periods ≈ distinctDays ÷ horizon (overlap-aware) — ใช้เป็นเกณฑ์นัยสำคัญ ไม่ใช่ n ดิบ
          const effN = Math.floor(dd / h);
          const sigStatus = effN < 20
            ? `<span style="color:#b45309">ยังไม่พอสรุป (ช่วงอิสระ ~${effN} · ต้อง ≥~20 ≈ หลายเดือน)</span>`
            : `<span style="color:#16a34a">พอประเมินเบื้องต้น (ช่วงอิสระ ~${effN})</span>`;
          const warn = early ? `<div class=warn>⚠️ <b>ผลเบื้องต้น</b> — เก็บแค่ ${dd} วัน = ช่วงเวลาเดียว · <b>ยังไม่มีนัยสำคัญ</b> อย่าตัดสินใจจากนี้</div>` : '';
          return `<h2>Horizon ${h} วัน${early ? ' · 🔍 early read' : ''}</h2>${warn}
            <table><thead><tr><th>สัญญาณ</th><th>n</th><th>ชนะ SPX</th><th>ส่วนเกิน</th><th>median</th><th>Net*</th><th>IR</th></tr></thead><tbody>${rowsH}</tbody></table>
            ${spreadHtml}<div class=note style="font-size:11.5px">นัยสำคัญ: ${sigStatus}</div>`;
        };
        const blocks = [3, 5, 10, 20].map(h => hzBlock(h, h === 3)).join('');
        // slice tables — BUY แยกตาม regime / conviction (โชว์ Net · เฉพาะที่มีข้อมูล)
        const sliceTable = (title, obj, keys, klab) => {
          const any = keys.some(k => [3, 5, 10, 20].some(h => obj[k] && obj[k][h] && obj[k][h].n > 0));
          if (!any) return '';
          const rows = keys.map(k => `<tr><td>${klab(k)}</td>${[3, 5, 10, 20].map(h => { const s = (obj[k] && obj[k][h]) || { n: 0 }; return s.n > 0 ? `<td class=num style="color:${col(s.avgExcessNet)}">${f(s.avgExcessNet)}% <span class=n>(${s.n})</span></td>` : '<td class=num>—</td>'; }).join('')}</tr>`).join('');
          return `<h2>${title}</h2><table><thead><tr><th></th><th>3ว</th><th>5ว</th><th>10ว</th><th>20ว</th></tr></thead><tbody>${rows}</tbody></table>`;
        };
        const regimeBlock = sliceTable('BUY แยกตามภาวะตลาด — ส่วนเกิน Net (edge จริง หรือแค่ long ตอนตลาดขึ้น?)', d.byRegime || {}, ['risk-on', 'neutral', 'risk-off'], k => ({ 'risk-on': '🟢 risk-on', 'neutral': '🟡 neutral', 'risk-off': '🔴 risk-off' }[k] || k));
        const convBlock = sliceTable('BUY แยกตาม conviction — Net (conviction สูงดีกว่าจริงไหม?)', d.byConviction || {}, ['high', 'mid'], k => k === 'high' ? 'สูง (≥67)' : 'กลาง (<67)');
        body = `<div class=info>เก็บ <b>${dd} วันทำการ</b> (${d.snapshots} แถว · ${d.symbols} หุ้น) · ${d.dateRange.from} → ${d.dateRange.to}<br>
          horizon X = เทียบ snapshot ห่าง X วัน · ⚠️ <b>ช่วงเวลาซ้อนทับกัน → n หลอกว่าเยอะ</b> → ดู "ช่วงอิสระ" เป็นเกณฑ์นัยสำคัญ ไม่ใช่ n ดิบ</div>
          ${blocks}${regimeBlock}${convBlock}
          <p class=note>💡 <b>Net*</b> (หลังหักต้นทุน ${d.costPctAssumed}%) = ค่าจริงที่สำคัญ ไม่ใช่ gross · <b>median</b> ทน outlier กว่า mean · <b>BUY−SELL spread</b> = edge แท้ (discriminating power) · <b>IR</b> = ส่วนเกิน/ความผันผวน · นัยสำคัญใช้ "ช่วงอิสระ" (overlap-aware) ไม่ใช่ n ดิบ — กัน false positive ตอน sample เล็ก · t-stat/CI + equity curve จะเปิดเมื่อช่วงอิสระ ≥20</p>`;
      }
      const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
        <title>วัดผลสัญญาณย้อนหลัง</title><style>
        body{font-family:system-ui,'Segoe UI',sans-serif;max-width:760px;margin:18px auto;padding:0 14px;color:#111;line-height:1.5}
        h1{font-size:20px}h2{font-size:15px;margin:18px 0 6px;color:#374151}
        table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
        th{background:#f9fafb}.num{text-align:right;font-variant-numeric:tabular-nums}
        .info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:8px}
        .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 11px;font-size:12.5px;color:#92400e;margin:4px 0 8px}
        .note{font-size:12px;color:#555;background:#fafafa;border-radius:8px;padding:8px 10px}</style></head>
        <body><h1>📊 วัดผลสัญญาณย้อนหลัง (benchmark-relative)</h1>${body}</body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/riskconfig — ตั้ง/อ่านเงินพอร์ต + %เสี่ยงต่อไม้ (สำหรับ position sizing)
    if (url.pathname === '/api/riskconfig') {
      return handleKvJson(request, env, 'riskConfig', x => x && typeof x === 'object' && !Array.isArray(x));
    }

    // /api/dashboard — aggregator: คำนวณทุกอย่างที่หน้า dashboard ใช้ในครั้งเดียว
    // memo dedupe portfolio/regime/watchlist (เคย recompute ~5x/โหลด) + ลด round-trip 7→1
    if (url.pathname === '/api/dashboard') {
      const safe = p => p.then(v => v).catch(e => ({ error: e && e.message }));
      const [decide, posWatch, defense, scenario, consensus, perf, tstats] = await Promise.all([
        safe(computeDecision(env)), safe(computePositionWatch(env)), safe(computeDefense(env)),
        safe(computeScenario(env, {})), safe(computeConsensus(env)), safe(computePerformance(env)), safe(computeTradeStats(env)),
      ]);
      let riskConfig = null;
      try { const raw = await env.WATCHLIST.get('riskConfig'); if (raw) riskConfig = JSON.parse(raw); } catch (e) {}
      return new Response(JSON.stringify({ updated: new Date().toISOString(), decide, posWatch, defense, scenario, consensus, perf, tstats, riskConfig }), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/decide — Decision Engine JSON (Phase 2)
    if (url.pathname === '/api/decide') {
      const r = await computeDecision(env).catch(e => ({ error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // ===== CIO LAYER (Phase 5 · deterministic) =====
    // /api/defense — M36 Portfolio Defense / Kill Switch JSON
    if (url.pathname === '/api/defense') {
      const r = await computeDefense(env).catch(e => ({ error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /api/allocate — M37 Capital Allocation Ranking JSON · ?budget=10000 (USD)
    if (url.pathname === '/api/allocate') {
      const budget = +(url.searchParams.get('budget') || '0') || 0;
      const r = await computeAllocation(env, budget).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /api/scenario — M38 Portfolio Scenario JSON · ?dovish=&neutral=&hawkish= (override prob)
    if (url.pathname === '/api/scenario') {
      const ov = { dovish: url.searchParams.get('dovish'), neutral: url.searchParams.get('neutral'), hawkish: url.searchParams.get('hawkish') };
      const r = await computeScenario(env, ov).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /api/consensus — A2 Consensus/Conflict Detector JSON (จับ engine/thesis/invalidation/defense ขัดกัน)
    if (url.pathname === '/api/consensus') {
      const r = await computeConsensus(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /api/log-resolutions — บังคับ log verdict วันนี้ทันที (ทดสอบ B · cron ทำให้อยู่แล้ว) · gated (เขียน D1)
    if (url.pathname === '/api/log-resolutions') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      const r = await logResolutions(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // /api/resolution-log — อ่าน log verdict ย้อนหลัง (รากฐาน calibration Tier B) · gated (เปิดข้อมูลดิบ)
    if (url.pathname === '/api/resolution-log') {
      const gate = requireAdmin(request, env, url); if (gate) return gate;
      if (!env.JOURNAL) return new Response(JSON.stringify({ ok: false, error: 'no D1' }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      const days = Math.min(parseInt(url.searchParams.get('days') || '90', 10) || 90, 3650);
      const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const r = await env.JOURNAL.prepare(`SELECT ts_date, symbol, status, verdict, score, engine_stance, thesis_stance, regime, price FROM resolution_log WHERE ts_date >= ? ORDER BY ts_date DESC, score ASC`).bind(since).all().catch(e => ({ error: e && e.message }));
      return new Response(JSON.stringify({ ok: !r.error, count: (r.results || []).length, rows: r.results || [], error: r.error }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /defense — M36 HTML (ดู/ก๊อปในเบราว์เซอร์ + ให้ AI browse)
    if (url.pathname === '/defense') return handleDefense(env);

    // /api/positions-watch — เตือน position ใกล้/หลุด invalidation
    if (url.pathname === '/api/positions-watch') {
      const r = await computePositionWatch(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /api/trades — POST บันทึกการขาย (realized trade) → trade_log
    if (url.pathname === '/api/trades') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (request.method === 'POST') {
        let body; try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ ok: false, error: 'bad json' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
        const r = await logTrade(env, body).catch(e => ({ ok: false, error: e && e.message }));
        return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      return new Response('method not allowed', { status: 405, headers: CORS });
    }
    // /api/trade-stats — สถิติการเทรด JSON
    if (url.pathname === '/api/trade-stats') {
      const r = await computeTradeStats(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /trades — ประวัติเทรด + สถิติ HTML
    if (url.pathname === '/trades') {
      const d = await computeTradeStats(env).catch(e => ({ ok: false, error: e && e.message }));
      const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
      const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      let body;
      if (!d.ok) body = `<p>error: ${esc(d.error)}</p>`;
      else if (!d.count) body = `<div class=info>${esc(d.note)}</div>`;
      else {
        const s = d.summary;
        const pc = x => (x || 0) >= 0 ? '#16a34a' : '#dc2626';
        body = `<div class=cards>
          <div class=card><div class=lab>Win Rate</div><div class=big style="color:${(s.winRate||0)>=50?'#16a34a':'#dc2626'}">${f(s.winRate,0)}%</div><div class=sub>${s.wins}ชนะ / ${s.losses}แพ้</div></div>
          <div class=card><div class=lab>กำไรรวม (realized)</div><div class=big style="color:${pc(s.totalPnl)}">${s.totalPnl>=0?'+':''}$${f(s.totalPnl,0)}</div></div>
          <div class=card><div class=lab>R เฉลี่ย</div><div class=big style="color:${pc(s.avgR)}">${s.avgR>=0?'+':''}${f(s.avgR,2)}R</div><div class=sub>กำไร÷ความเสี่ยง</div></div>
          <div class=card><div class=lab>Profit Factor</div><div class=big style="color:${(s.profitFactor||0)>=1.5?'#16a34a':'#ca8a04'}">${f(s.profitFactor,2)}</div><div class=sub>กำไร÷ขาดทุน</div></div>
          <div class=card><div class=lab>กำไรเฉลี่ย/ไม้</div><div class=big style="color:#16a34a">+$${f(s.avgWin,0)}</div></div>
          <div class=card><div class=lab>ขาดทุนเฉลี่ย/ไม้</div><div class=big style="color:#dc2626">-$${f(s.avgLoss,0)}</div></div>
        </div>
        <div class=info>🏆 ดีสุด: <b>${esc(s.best.symbol)}</b> +$${f(s.best.pnl,0)} (${f(s.best.pnlPct,1)}%) · 💀 แย่สุด: <b>${esc(s.worst.symbol)}</b> $${f(s.worst.pnl,0)} (${f(s.worst.pnlPct,1)}%)</div>
        <table><thead><tr><th>วันที่</th><th>หุ้น</th><th class=num>จำนวน</th><th class=num>ซื้อ</th><th class=num>ขาย</th><th class=num>กำไร/ขาดทุน</th><th class=num>R</th></tr></thead><tbody>` +
        d.trades.map(t => `<tr><td>${String(t.ts_iso).slice(0,10)}</td><td><b>${esc(t.symbol)}</b></td><td class=num>${f(t.qty,2)}</td><td class=num>$${f(t.buy_price)}</td><td class=num>$${f(t.sell_price)}</td><td class=num style="color:${pc(t.pnl)}">${t.pnl>=0?'+':''}$${f(t.pnl,0)} (${f(t.pnl_pct,1)}%)</td><td class=num>${t.r_multiple!=null?f(t.r_multiple,2)+'R':'—'}</td></tr>`).join('') +
        `</tbody></table>`;
      }
      const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Trade History</title><style>
        body{font-family:system-ui,'Segoe UI',sans-serif;max-width:860px;margin:18px auto;padding:0 14px;color:#111;line-height:1.5}
        h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:10px}th,td{border:1px solid #e5e7eb;padding:7px 9px;text-align:left}
        th{background:#f9fafb}.num{text-align:right;font-variant-numeric:tabular-nums}
        .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
        .card{border:1px solid #e5e7eb;border-radius:10px;padding:11px 13px}.lab{font-size:12px;color:#666}.big{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}.sub{font-size:11px;color:#888}
        .info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:10px}</style></head>
        <body><h1>📒 ประวัติการเทรด + สถิติ</h1>${body}
        <p class=info style="margin-top:14px;background:#fafafa;border-color:#eee">บันทึกเมื่อกด "ขาย" ใน Positions · R-multiple ต้องตั้ง SL ในหุ้นนั้นถึงคำนวณได้</p></body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // /positions — HTML เฝ้า position เทียบ invalidation/SL
    if (url.pathname === '/positions') {
      const d = await computePositionWatch(env).catch(e => ({ ok: false, error: e && e.message }));
      const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
      const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      let body;
      if (!d.ok) body = `<p>error: ${esc(d.error)}</p>`;
      else if (!d.positions.length) body = `<div class=info>${esc(d.note || 'ไม่มี position')}</div>`;
      else {
        const rows = d.positions.map(p => {
          const plc = (p.plPct || 0) >= 0 ? '#16a34a' : '#dc2626';
          const sc = p.status === 'breached' ? '#dc2626' : p.status === 'near' ? '#ca8a04' : '#16a34a';
          return `<tr><td><b>${esc(p.symbol)}</b><br><span class=n>${qtyFmt(p.qty)} หุ้น</span></td>
            <td class=num>$${f(p.price)}</td><td class=num>$${f(p.avgCost)}</td>
            <td class=num style="color:${plc}">${p.plPct >= 0 ? '+' : ''}${f(p.plPct)}%</td>
            <td class=num>${p.invalidationPrice ? '$' + f(p.invalidationPrice) : '—'}</td>
            <td style="color:${sc}">${p.alert ? esc(p.alert) : '✅ ปกติ'}</td></tr>`;
        }).join('');
        body = `<table><thead><tr><th>หุ้น</th><th>ราคา</th><th>ทุนเฉลี่ย</th><th>P/L</th><th>Invalidation</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table>
          <p class=note>Invalidation = ราคาที่ LLM ตั้งไว้ว่า "ถ้าหลุด thesis พัง" (จาก /thesis) · ถ้ายังไม่มีแปลว่าหุ้นนั้นยังไม่ถูกวิเคราะห์</p>`;
      }
      const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
        <title>Position Watch</title><style>
        body{font-family:system-ui,'Segoe UI',sans-serif;max-width:820px;margin:18px auto;padding:0 14px;color:#111;line-height:1.5}
        h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e5e7eb;padding:7px 9px;text-align:left}
        th{background:#f9fafb}.num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#666;font-size:11px}
        .info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 12px;font-size:13px}
        .note{font-size:12px;color:#555;background:#fafafa;border-radius:8px;padding:8px 10px;margin-top:10px}</style></head>
        <body><h1>📍 Position Watch (เทียบ invalidation จาก thesis)</h1>${body}</body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/surprise — Surprise Detector JSON (Phase 3) ดูว่ามีอะไรเปลี่ยนจริง
    if (url.pathname === '/api/surprise') {
      const r = await computeSurprise(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /api/surprise-alert — บังคับเทียบ+ส่ง Telegram ทันที (ทดสอบ)
    if (url.pathname === '/api/surprise-alert') {
      const r = await runSurpriseAlert(env).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/telegram-test — ส่งข้อความทดสอบ ยืนยัน secret ถูก (ไม่ต้องรอ surprise)
    if (url.pathname === '/api/telegram-test') {
      if (!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID))
        return new Response(JSON.stringify({ ok: false, error: 'ยังไม่ตั้ง secret TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      const r = await sendTelegram(env, '✅ ทดสอบ Telegram จาก stock-dashboard — Phase 3 surprise alert พร้อมใช้');
      return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // /api/thesis — LLM judgment JSON (Phase 4) — ทุกตัวหน้าเดียว · ?refresh=1 บังคับวิเคราะห์ใหม่
    if (url.pathname === '/api/thesis') {
      const r = await generateThesis(env, { refresh: url.searchParams.get('refresh') === '1' }).catch(e => ({ ok: false, error: e && e.message }));
      return new Response(JSON.stringify(r, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /thesis — LLM judgment HTML — ทุกตัวยาวหน้าเดียว · ?refresh=1 วิเคราะห์ใหม่
    if (url.pathname === '/thesis') {
      const d = await generateThesis(env, { refresh: url.searchParams.get('refresh') === '1' }).catch(e => ({ ok: false, error: e && e.message }));
      const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      const confColor = c => c == null ? '#999' : c >= 70 ? '#16a34a' : c >= 50 ? '#ca8a04' : '#dc2626';
      let body;
      if (!d.ok) {
        body = `<div class=warn><b>ยังใช้ไม่ได้:</b> ${esc(d.error)}${(d.error || '').includes('GEMINI') ? '<br>ตั้ง secret <code>GEMINI_API_KEY</code> ก่อน (ฟรีจาก Google AI Studio: aistudio.google.com/apikey)' : ''}</div>`;
      } else if (!d.theses.length) {
        body = `<div class=info>${esc(d.note || 'ไม่มี candidate')}</div>`;
      } else {
        const stCol = { buy: '#16a34a', wait: '#ca8a04', avoid: '#dc2626', hold: '#6366f1', reduce: '#ea580c', sell: '#dc2626' };
        const cacheInfo = d.cached ? ` · 💾 จาก cache (${new Date(d.cachedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', timeStyle: 'short', dateStyle: 'short' })}) <a href="/thesis?refresh=1" class=refresh>↻ วิเคราะห์ใหม่</a>` : ' · ✨ วิเคราะห์สด';
        body = `<div class=info>สภาวะตลาด: <b>${esc(d.regime)}</b> · วิเคราะห์ ${d.count} ตัว${d.heldCount ? ` (★ ถืออยู่ ${d.heldCount} ตัว)` : ''} · Gemini 2.5 Flash${cacheInfo}</div>` +
          d.theses.map(t => {
            const c = stCol[(t.stance || '').toLowerCase()] || '#666';
            const cf = t.confidence;
            const diff = (t.engineStance && t.engineStance !== t.stance) ? ` <span class=diff>(engine: ${esc(t.engineStance)})</span>` : '';
            return `<div class="card${t.held ? ' held' : ''}">
              <div class=hd><b style="font-size:16px">${esc(t.symbol)}</b>${t.held ? ` <span class=holdtag>★ ถืออยู่ ${qtyFmt(t.heldQty)} หุ้น</span>` : ''} <span class=badge style="background:${c}">${esc(t.stance).toUpperCase()}</span>${diff}
                <span class=confbox>มั่นใจ <b style="color:${confColor(cf)}">${cf ?? '—'}%</b><span class=bar><span style="width:${cf || 0}%;background:${confColor(cf)}"></span></span></span>
                ${t.engineConviction != null ? `<span class=eng>conviction(ระบบ) ${t.engineConviction}</span>` : ''}${t.rr_ratio != null ? `<span class=eng>RR ${(+t.rr_ratio).toFixed(1)}:1</span>` : ''}${t.entry_target > 0 ? `<span class=entry>🎯 เข้า $${(+t.entry_target).toFixed(2)}</span>` : ''}</div>
              ${t.setup ? `<div class=row><span class=lbl>📐 Setup</span> ${esc(t.setup)}</div>` : ''}
              <div class=row><span class=lbl>✅ ฝั่งซื้อ</span> ${esc(t.bull_case)}</div>
              <div class=row><span class=lbl>⚠️ ความเสี่ยง</span> ${esc(t.bear_case)}</div>
              ${t.scenario ? `<div class=row><span class=lbl>🎲 Bear/Base/Bull</span> ${esc(t.scenario)}</div>` : ''}
              ${t.key_levels ? `<div class=row><span class=lbl>📊 ระดับสำคัญ</span> ${esc(t.key_levels)}</div>` : ''}
              ${t.action_plan ? `<div class="row plan"><span class=lbl>🎯 แผนปฏิบัติ</span> ${esc(t.action_plan)}</div>` : ''}
              ${t.weak_point ? `<div class="row weak"><span class=lbl>🔻 จุดอ่อนสุด</span> ${esc(t.weak_point)}</div>` : ''}
              ${t.bright_point ? `<div class="row bright"><span class=lbl>💡 จุดที่จะกลับมา</span> ${esc(t.bright_point)}</div>` : ''}
              <div class=row><span class=lbl>🛑 จุดที่ผิด</span> ${esc(t.invalidation)}${t.invalidation_price ? ` (ราคา $${t.invalidation_price})` : ''}</div>
              ${t.missing_info ? `<div class=row><span class=lbl>❓ ข้อมูลที่ขาด</span> ${esc(t.missing_info)}</div>` : ''}
            </div>`;
          }).join('');
      }
      const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
        <title>LLM Thesis</title><style>
        body{font-family:system-ui,'Segoe UI',sans-serif;max-width:760px;margin:18px auto;padding:0 14px;color:#111;line-height:1.55}
        h1{font-size:20px}.info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
        .warn{background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:11px 13px;font-size:13px}
        .card{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-bottom:12px}
        .card.held{border-color:#6366f1;border-width:2px;background:#fafaff}
        .holdtag{background:#6366f1;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px}
        .hd{margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .badge{color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px}
        .diff{color:#999;font-size:11px}.eng{color:#888;font-size:11px}
        .entry{background:#dcfce7;color:#15803d;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px}
        .confbox{font-size:12px;color:#444;display:inline-flex;align-items:center;gap:5px}
        .bar{display:inline-block;width:54px;height:7px;background:#eee;border-radius:4px;overflow:hidden}
        .bar>span{display:block;height:100%}
        .row{font-size:13px;margin:5px 0}
        .plan{background:#f0fdf4;border-radius:6px;padding:7px 9px}
        .weak{background:#fef2f2;border-left:3px solid #f87171;border-radius:4px;padding:6px 9px}
        .bright{background:#f0fdf4;border-left:3px solid #4ade80;border-radius:4px;padding:6px 9px}
        .refresh{background:#2563eb;color:#fff;padding:2px 8px;border-radius:6px;text-decoration:none;font-size:11px;white-space:nowrap}
        .lbl{display:inline-block;min-width:104px;color:#374151;font-weight:600;font-size:12px;vertical-align:top}</style></head>
        <body><h1>🧠 LLM Thesis (judgment layer)</h1>${body}
        <p class=info style="margin-top:14px;background:#fafafa;border-color:#eee">⚠️ การวิเคราะห์ทางเทคนิค ไม่ใช่คำแนะนำการลงทุน · ตัดสินใจเองและบริหารความเสี่ยง</p></body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // /decide — Decision Engine HTML (รายงานตัดสินใจ)
    if (url.pathname === '/decide') {
      const d = await computeDecision(env).catch(e => ({ error: e && e.message }));
      if (d.error) return new Response(`<p>error: ${d.error}</p>`, { status: 500, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
      const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      const f = (x, dg = 2) => (x == null) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
      const rg = d.regime;
      const rgCol = rg.regime === 'risk-on' ? '#16a34a' : rg.regime === 'risk-off' ? '#dc2626' : '#ca8a04';
      const rgTh = { 'risk-on': 'เปิดรับความเสี่ยง', 'risk-off': 'เลี่ยงความเสี่ยง', 'neutral': 'เป็นกลาง', 'unknown': 'ไม่ทราบ' }[rg.regime] || rg.regime;
      const stanceBadge = st => {
        const m = { buy: ['#16a34a', '🟢 ซื้อได้'], wait: ['#ca8a04', '🟡 รอ'], avoid: ['#dc2626', '🔴 เลี่ยง'], core: ['#6366f1', '🔵 Core'], 'n/a': ['#999', '⚪ —'] };
        const [c, t] = m[st] || ['#999', st];
        return `<span style="color:${c};font-weight:700">${t}</span>`;
      };
      const cvBar = score => {
        if (score == null) return '—';
        const c = score >= 67 ? '#16a34a' : score >= 50 ? '#ca8a04' : '#dc2626';
        return `<div style="display:inline-block;width:46px;height:8px;background:#eee;border-radius:4px;vertical-align:middle;overflow:hidden"><div style="width:${score}%;height:100%;background:${c}"></div></div> <b>${score}</b>`;
      };
      const candRows = d.candidates.map(c => {
        const fl = c.flags.length ? `<div class=flags>${c.flags.map(x => '⚠️ ' + esc(x)).join('<br>')}</div>` : '';
        const sz = c.sizing ? (c.sizing.shares != null
          ? `${f(c.sizing.shares)} หุ้น ($${f(c.sizing.positionValue, 0)} · ${c.sizing.pctOfPort}% พอร์ต)`
          : `stop ${f(c.sizing.stopDist)} (${c.sizing.stopType}) · ตั้ง riskConfig เพื่อคำนวณจำนวนหุ้น`) : '—';
        return `<tr><td><b>${esc(c.symbol)}</b><br><span class=n>${esc(c.name)}</span></td>
          <td>${cvBar(c.conviction)}</td>
          <td>${stanceBadge(c.stance)}<br><span class=rsn>${esc(c.reason)}</span></td>
          <td class=num>$${f(c.price)}</td>
          <td><span class=mini>RSI ${f(c.rsi, 0)} · CMF ${f(c.cmf, 2)} · RS ${c.rsVsSpx >= 0 ? '+' : ''}${f(c.rsVsSpx)}</span></td>
          <td><span class=mini>${sz}</span>${fl}</td></tr>`;
      }).join('');
      const coreRows = d.core.map(c => `<tr><td><b>${esc(c.symbol)}</b> <span class=n>${esc(c.name)}</span></td><td class=num>$${f(c.price)}</td><td><span class=mini>conviction ${c.conviction == null ? '—' : c.conviction} (อ้างอิงเฉย ๆ ไม่ trade)</span></td></tr>`).join('');
      const html = `<!DOCTYPE html><html lang=th><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
        <title>Decision Engine</title><style>
        body{font-family:system-ui,'Segoe UI',sans-serif;max-width:920px;margin:18px auto;padding:0 14px;color:#111;line-height:1.5}
        h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px;color:#374151}
        table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:6px}
        th,td{border:1px solid #e5e7eb;padding:7px 9px;text-align:left;vertical-align:top}th{background:#f9fafb}
        .num{text-align:right;font-variant-numeric:tabular-nums}.n{color:#666;font-size:11px}
        .rsn{color:#666;font-size:11px}.mini{font-size:11px}.flags{margin-top:4px;color:#b45309;font-size:11px}
        .regime{padding:12px 14px;border-radius:10px;border:2px solid ${rgCol};margin-bottom:10px;font-size:14px}
        .rgbig{font-size:18px;font-weight:800;color:${rgCol}}.sub{color:#666;font-size:12px}
        .warn{background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 11px;font-size:12px;margin-bottom:10px}
        .info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 11px;font-size:12px;margin-bottom:10px}</style></head>
        <body><h1>🧭 Decision Engine</h1>
        <div class=regime><span class=rgbig>${rgTh.toUpperCase()}</span> <span class=sub>(${esc(rg.regime)})</span><br>
          <span class=sub>S&P500 $${f(rg.spxPrice)} · ${rg.aboveEma200Pct >= 0 ? 'เหนือ' : 'ใต้'} EMA200 ${f(Math.abs(rg.aboveEma200Pct || 0))}% · VIX ${f(rg.vix)} · เกณฑ์ BUY conviction ≥ ${d.buyThresh}${rg.pending ? ` · ⏳ กำลังจะเปลี่ยนเป็น ${esc(rg.pending)}` : ''}</span></div>
        ${d.riskConfigSet ? '' : '<div class=warn>💡 ยังไม่ตั้งเงินพอร์ต — position sizing แสดงแค่ระยะ stop · ตั้งค่าผ่าน <code>POST /api/riskconfig {"capital":100000,"riskPctPerTrade":1}</code> เพื่อคำนวณจำนวนหุ้น</div>'}
        ${(() => {
          const h = d.heat || {}; const parts = [];
          if (h.buyCount != null) parts.push(`สัญญาณซื้อ ${h.buyCount} ตัว`);
          if (h.grossRiskPct != null) parts.push(`ถ้าเปิดครบ = เสี่ยงรวม ${h.grossRiskPct}%`);
          if (!parts.length) return '';
          const danger = h.warn || (h.correlatedClusters && h.correlatedClusters.length);
          return `<div class="${danger ? 'warn' : 'info'}"><b>🔥 Portfolio Heat:</b> ${parts.join(' · ')}` +
            (h.warn ? `<br>⚠️ ${esc(h.warn)}` : '') +
            (h.correlatedClusters && h.correlatedClusters.length ? `<br>🔗 ไม้ที่สัมพันธ์สูง (เสี่ยงซ้ำ): ${esc(h.correlatedClusters.join(', '))}` : '') + `</div>`;
        })()}
        <h2>📈 Tactical — เรียงตาม conviction (${d.candidates.length} ตัว)</h2>
        <table><thead><tr><th>หุ้น</th><th>Conviction</th><th>คำแนะนำ</th><th>ราคา</th><th>สัญญาณ</th><th>ขนาดไม้ / ความเสี่ยง</th></tr></thead><tbody>${candRows}</tbody></table>
        ${coreRows ? `<h2>🔵 Core — ถือยาว ไม่ trade ตาม signal</h2><table><tbody>${coreRows}</tbody></table>` : ''}
        <p class=sub style="margin-top:14px">${esc(d.note)} · อัปเดต ${new Date(d.updated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}</p>
        </body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/stocks') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleStocks(url);
    }
    if (url.pathname === '/api/data') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleData(env, url.searchParams.get('options') === '1');
    }
    if (url.pathname === '/report' || url.pathname === '/api/report') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleReport(env);
    }
    if (url.pathname === '/text' || url.pathname === '/api/text') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleText(env);
    }
    if (url.pathname === '/csv' || url.pathname === '/api/csv') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleCsv(env);
    }
    if (url.pathname === '/portfolio') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handlePortfolio(env);
    }
    if (url.pathname === '/api/portfolio') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handlePortfolioJson(env);
    }
    if (url.pathname === '/api/catalysts') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleCatalysts(env, +(url.searchParams.get('days') || 180));
    }
    if (url.pathname === '/risk') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleRisk(env);
    }
    if (url.pathname === '/api/risk') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleRiskJson(env);
    }
    if (url.pathname === '/correlation') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleCorrelation(env);
    }
    if (url.pathname === '/api/correlation') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleCorrelationJson(env);
    }
    if (url.pathname === '/dividend') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleDividend(env);
    }
    if (url.pathname === '/api/dividend') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleDividendJson(env);
    }
    // /live, /now — redirect ไป /text?ts=<เวลา> ที่ "ไม่ซ้ำทุกครั้ง" → บังคับ AI (Claude/Gemini) ดึงสด เลี่ยง cache ฝั่ง client
    // ใช้ลิงก์เดิม /live ตลอด แต่ปลายทางเปลี่ยน timestamp ทุก request
    if (url.pathname === '/live' || url.pathname === '/now') {
      const dest = `${url.origin}/text?ts=${Date.now()}`;
      return new Response(null, { status: 302, headers: { ...CORS, 'Location': dest, 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
    }
    // /api/signals — อ่านป้าย BUY/HOLD/SELL ปัจจุบันจาก KV (read-only) = single source ให้ GitHub-Actions fallback (alert.mjs) ดึงผ่าน HTTP ได้
    // (CF alerts worker อ่านผ่าน KV binding ตรงๆ · GitHub อยู่นอก CF เลยต้องผ่าน endpoint นี้) · คืน {updated, signals:{SYM:'BUY'}}
    if (url.pathname === '/api/signals') {
      const raw = await env.WATCHLIST.get('signals');
      return new Response(raw || JSON.stringify({ updated: null, signals: {} }),
        { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } });
    }
    // State endpoints — เก็บใน KV namespace WATCHLIST (key ต่างกันต่อ resource) เพื่อซิงค์ข้ามเครื่อง
    if (url.pathname === '/api/watchlist') return handleKvJson(request, env, 'main', x => Array.isArray(x));
    if (url.pathname === '/api/positions') return handleKvJson(request, env, 'positions', x => Array.isArray(x));
    if (url.pathname === '/api/alerts')    return handleKvJson(request, env, 'alertCfg', x => x && typeof x === 'object' && !Array.isArray(x));
    if (url.pathname === '/api/ics') return handleIcs(request, url);

    // everything else → static assets (index.html lobby, dashboard.html, …)
    const res = await env.ASSETS.fetch(request);
    // บังคับ HTML โหลดสดทุกครั้ง — กัน iPad/Safari ค้างเวอร์ชันเก่าหลัง deploy
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
};

// Named exports สำหรับ unit test (node --test) — pure functions ล้วน · Wrangler ใช้แค่ default ไม่กระทบ deploy
export { convictionScore, labelFromConviction, buyThreshFor, positionSize, corrPenaltyFor, CONV_WEIGHTS,
  defenseAssess, defenseHeadroom, DEFENSE_LEVELS, allocationRank, scenarioOutcome, defaultScenarios,
  invalidationStatus, INVALIDATION_BUFFER_PCT, signalStability, SIGNAL_BORDERLINE_BAND, reconcile,
  resolveLayers, resolveScore, resolveVerdict, RESOLVE_WEIGHTS,
  betaVsSpx, corrBetween, alignedReturns, betaReliable, betaForRisk };
