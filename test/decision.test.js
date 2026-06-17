// Unit tests สำหรับ decision engine (pure functions) — รัน: npm test (node --test)
// คุ้มสุดต่อบรรทัด: deploy เป็น manual จากเครื่อง Windows → กัน regression เงียบในสูตรที่ตัดสินใจเรื่องเงิน
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convictionScore, labelFromConviction, buyThreshFor, positionSize, corrPenaltyFor } from '../worker.js';

// ---------- buyThreshFor ----------
test('buyThreshFor: risk-off เข้มกว่า neutral กว่า risk-on', () => {
  assert.equal(buyThreshFor('risk-on'), 60);
  assert.equal(buyThreshFor('neutral'), 67);
  assert.equal(buyThreshFor('risk-off'), 75);
  assert.equal(buyThreshFor('unknown'), 67); // default = neutral
  assert.equal(buyThreshFor(undefined), 67);
});

// ---------- labelFromConviction ----------
test('labelFromConviction: null = HOLD (ข้อมูลไม่พอ ไม่เดาป้าย)', () => {
  assert.equal(labelFromConviction(null, 'neutral'), 'HOLD');
});

// INVARIANT (REVIEW.md หมวด 1.4 "mismatch ต้อง 0"): ป้ายต้องผูกกับ buyThresh ของ regime เป๊ะ
// conviction ≥ buyThresh ⟺ BUY · ≤35 ⟺ SELL · นอกนั้น HOLD — ทุก score 0..100 ทุก regime
test('INVARIANT: label ↔ buyThreshold ตรงกัน 100% ทุก regime', () => {
  for (const regime of ['risk-on', 'neutral', 'risk-off']) {
    const thr = buyThreshFor(regime);
    for (let score = 0; score <= 100; score++) {
      const label = labelFromConviction(score, regime);
      const expected = score >= thr ? 'BUY' : score <= 35 ? 'SELL' : 'HOLD';
      assert.equal(label, expected, `regime=${regime} score=${score} thr=${thr}`);
    }
  }
});

// ---------- convictionScore ----------
const BULL = { price: 110, ema50: 100, ema200: 90, sma200: 88, macdHist: 0.5, roc10: 3, rsi: 60, bollLower: 95, bollUpper: 115, cmf: 0.1, rs3m: 5 };
const BEAR = { price: 80, ema50: 100, ema200: 110, sma200: 112, macdHist: -0.5, roc10: -3, rsi: 75, bollLower: 78, bollUpper: 120, cmf: -0.1, rs3m: -5 };

test('convictionScore: ข้อมูล <3 มิติ → score null (กัน conviction ปลอมจากมิติเดียว)', () => {
  const r = convictionScore({ price: 100, ema50: 90, rs3m: 2 }, 'neutral'); // trend + relStrength = 2 มิติ
  assert.equal(r.score, null);
  assert.equal(r.insufficient, true);
});

test('convictionScore: setup ขาขึ้นเต็ม → score สูง + ป้าย BUY', () => {
  const r = convictionScore(BULL, 'neutral');
  assert.ok(r.score >= buyThreshFor('neutral'), `score=${r.score}`);
  assert.equal(labelFromConviction(r.score, 'neutral'), 'BUY');
});

test('convictionScore: setup ขาลงเต็ม → score ต่ำ + ป้าย SELL', () => {
  const r = convictionScore(BEAR, 'neutral');
  assert.ok(r.score <= 35, `score=${r.score}`);
  assert.equal(labelFromConviction(r.score, 'neutral'), 'SELL');
});

test('convictionScore: regime-weighting มีผลจริง (risk-on เน้น trend/momentum > risk-off)', () => {
  // หุ้น trend/momentum แข็งแต่ meanRev ลบ (overbought) → risk-on ควรให้คะแนนสูงกว่า risk-off
  const mixed = { price: 110, ema50: 100, ema200: 90, sma200: 88, macdHist: 0.5, roc10: 3, rsi: 75, bollLower: 95, bollUpper: 108, cmf: 0.1, rs3m: 5 };
  const on = convictionScore(mixed, 'risk-on').score;
  const off = convictionScore(mixed, 'risk-off').score;
  assert.ok(on > off, `risk-on=${on} ควร > risk-off=${off}`);
});

// ---------- positionSize ----------
const RISK = { capital: 100000, riskPctPerTrade: 1 }; // ยอมเสีย 1% = $1,000/trade

test('positionSize: ใช้ SL ที่ตั้ง เป็น stop distance + จำนวนหุ้น = riskAmount/stopDist', () => {
  const r = positionSize({ price: 100, sl: 95, atr14: 2 }, RISK, 60, 1);
  assert.equal(r.stopDist, 5);
  assert.equal(r.stopType, 'SL ที่ตั้ง');
  assert.equal(r.riskAmount, 1000); // 100000 * 1% * convFactor(1) * ef(1)
  assert.equal(r.shares, 200);      // 1000 / 5
  assert.equal(r.positionValue, 20000);
});

test('positionSize: ไม่มี SL ใช้ได้ → fallback 2×ATR', () => {
  const r = positionSize({ price: 100, sl: 0, atr14: 3 }, RISK, 60, 1);
  assert.equal(r.stopDist, 6);
  assert.equal(r.stopType, '2×ATR');
});

test('positionSize: convFactor clamp 0.5–1.5 (กันไม้เล็ก/ใหญ่เกิน)', () => {
  const big = positionSize({ price: 100, sl: 95, atr14: 2 }, RISK, 999, 1);
  assert.equal(big.convFactor, 1.5);
  const small = positionSize({ price: 100, sl: 95, atr14: 2 }, RISK, 6, 1);
  assert.equal(small.convFactor, 0.5);
});

test('positionSize: extraFactor (corr/kill-switch) ลดไม้จริง', () => {
  const full = positionSize({ price: 100, sl: 95, atr14: 2 }, RISK, 60, 1);
  const half = positionSize({ price: 100, sl: 95, atr14: 2 }, RISK, 60, 0.5);
  assert.equal(half.riskAmount, full.riskAmount * 0.5);
  assert.equal(half.sizeFactor, 0.5);
});

test('positionSize: ไม่มี ATR → null (คำนวณ stop ไม่ได้ ไม่เดา)', () => {
  assert.equal(positionSize({ price: 100, atr14: 0 }, RISK, 60, 1), null);
  assert.equal(positionSize({ price: 100 }, RISK, 60, 1), null);
});

// ---------- corrPenaltyFor ----------
test('corrPenaltyFor: corr ≥0.75 กับหุ้นที่ถือ → ลดไม้ครึ่ง (0.5)', () => {
  const held = [{ symbol: 'AMD' }];
  const pc = [{ a: 'NVDA', b: 'AMD', corr30: 0.8 }];
  assert.equal(corrPenaltyFor({ symbol: 'NVDA' }, held, pc), 0.5);
});

test('corrPenaltyFor: corr <0.75 หรือไม่มี holding → ไม่ลด (1)', () => {
  assert.equal(corrPenaltyFor({ symbol: 'NVDA' }, [{ symbol: 'AMD' }], [{ a: 'NVDA', b: 'AMD', corr30: 0.7 }]), 1);
  assert.equal(corrPenaltyFor({ symbol: 'NVDA' }, [], []), 1);
  assert.equal(corrPenaltyFor({ symbol: 'NVDA' }, [{ symbol: 'AAPL' }], [{ a: 'NVDA', b: 'AMD', corr30: 0.9 }]), 1);
});
