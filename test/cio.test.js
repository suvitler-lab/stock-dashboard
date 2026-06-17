// Unit tests สำหรับ CIO Layer (Phase 5) — pure functions · รัน: npm test
// เลขพวกนี้ตัดสินใจเรื่องเงิน (defense/allocation/scenario) → กัน regression เงียบ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defenseAssess, allocationRank, scenarioOutcome, defaultScenarios } from '../worker.js';

// ============ M36 — defenseAssess ============
const HEALTHY = { aboveEma200Pct: 3, ndxAboveEma200Pct: 4, vix: 15, creditOk: true, breadthOk: true };

test('defenseAssess: ตลาดแข็ง → level 0 ไม่มี trigger', () => {
  const r = defenseAssess(HEALTHY);
  assert.equal(r.level, 0);
  assert.equal(r.triggers.length, 0);
  assert.equal(r.trimTacticalPct, 0);
});

test('defenseAssess: VIX > 25 (1 trigger) → level 1', () => {
  const r = defenseAssess({ ...HEALTHY, vix: 28 });
  assert.equal(r.level, 1);
  assert.equal(r.triggers.length, 1);
  assert.equal(r.trimTacticalPct, 20);
});

test('defenseAssess: credit + breadth อ่อน (2 triggers) → level 2', () => {
  const r = defenseAssess({ ...HEALTHY, creditOk: false, breadthOk: false });
  assert.equal(r.triggers.length, 2);
  assert.equal(r.level, 2);
  assert.equal(r.trimTacticalPct, 50);
});

test('defenseAssess: 3 triggers (NDX<EMA, SPX<EMA, credit) → level 3', () => {
  const r = defenseAssess({ aboveEma200Pct: -2, ndxAboveEma200Pct: -3, vix: 20, creditOk: false, breadthOk: true });
  assert.equal(r.triggers.length, 3);
  assert.equal(r.level, 3);
  assert.equal(r.trimTacticalPct, 100);
});

test('defenseAssess: VIX > 35 บังคับ L3 แม้ trigger เดียว (panic escalator)', () => {
  const r = defenseAssess({ ...HEALTHY, vix: 40 });
  assert.equal(r.level, 3, 'VIX panic ต้องดัน level เป็น 3');
  assert.equal(r.triggers.length, 1);
});

test('defenseAssess: level cap ที่ 3 แม้ trigger ครบ 5', () => {
  const r = defenseAssess({ aboveEma200Pct: -2, ndxAboveEma200Pct: -3, vix: 40, creditOk: false, breadthOk: false });
  assert.equal(r.triggers.length, 5);
  assert.equal(r.level, 3);
});

test('defenseAssess: regime null/ข้อมูลขาด → level 0 ไม่ crash', () => {
  assert.equal(defenseAssess(null).level, 0);
  assert.equal(defenseAssess({}).level, 0);
});

// ============ M37 — allocationRank ============
const CANDS = [
  { symbol: 'A', name: 'A', conviction: 80, stance: 'buy', price: 100, entry: 100, earnings: null },   // in-zone
  { symbol: 'B', name: 'B', conviction: 75, stance: 'buy', price: 110, entry: 100, earnings: null },   // above-zone +10%
  { symbol: 'C', name: 'C', conviction: 70, stance: 'buy', price: 100, entry: 99, earnings: null },    // in-zone
  { symbol: 'D', name: 'D', conviction: 90, stance: 'buy', price: 100, entry: 100, earnings: null },   // overweight
  { symbol: 'E', name: 'E', conviction: 85, stance: 'avoid', price: 100, entry: 0, earnings: null },   // avoid
];

test('allocationRank: overweight (≥15%) ถูกตัดแม้ conviction สูงสุด', () => {
  const r = allocationRank(CANDS, { D: 20 }, { budget: 0 });
  const d = r.ranked.find(x => x.symbol === 'D');
  assert.equal(d.eligible, false);
  assert.ok(d.reasons.some(s => s.includes('overweight')));
  assert.ok(!r.allocations.some(a => a.symbol === 'D'));
});

test('allocationRank: stance avoid + above-zone ไม่ได้รับเงิน', () => {
  const r = allocationRank(CANDS, {}, { budget: 10000 });
  assert.ok(!r.allocations.some(a => a.symbol === 'E'), 'avoid ต้องไม่ได้เงิน');
  assert.ok(!r.allocations.some(a => a.symbol === 'B'), 'above-zone ต้องไม่ได้เงิน (รอย่อ)');
});

test('allocationRank: แบ่งงบตาม allocScore ให้ in-zone + เหลือเข้า cash = 0 เมื่อแบ่งครบ', () => {
  const r = allocationRank(CANDS, { D: 20 }, { budget: 10000 });   // D overweight → ตัดออก เหลือ A,C
  const syms = r.allocations.map(a => a.symbol).sort();
  assert.deepEqual(syms, ['A', 'C']);
  const a = r.allocations.find(x => x.symbol === 'A');
  const c = r.allocations.find(x => x.symbol === 'C');
  assert.ok(a.usd > c.usd, 'A (score สูงกว่า) ต้องได้เงินมากกว่า C');
  assert.equal(Math.round(r.allocated), 10000);
  assert.equal(r.toCash, 0);
  assert.ok(Math.abs((a.usd + c.usd) - 10000) < 0.5);
});

test('allocationRank: ไม่มีตัว fundable → เงินเข้า cash ทั้งก้อน', () => {
  const onlyAbove = [{ symbol: 'B', conviction: 75, stance: 'buy', price: 200, entry: 100, earnings: null }];
  const r = allocationRank(onlyAbove, {}, { budget: 5000 });
  assert.equal(r.allocations.length, 0);
  assert.equal(r.toCash, 5000);
});

test('allocationRank: งบ ≤3 วัน → ตัดออก (รอผ่านงบ)', () => {
  const c = [{ symbol: 'X', conviction: 90, stance: 'buy', price: 100, entry: 100, earnings: { daysUntil: 2 } }];
  const r = allocationRank(c, {}, { budget: 1000 });
  assert.equal(r.ranked[0].eligible, false);
  assert.equal(r.toCash, 1000);
});

test('allocationRank: ranked เรียงจาก allocScore มาก→น้อย', () => {
  const r = allocationRank(CANDS, { D: 20 }, { budget: 0 });
  for (let i = 1; i < r.ranked.length; i++)
    assert.ok(r.ranked[i - 1].allocScore >= r.ranked[i].allocScore, 'ต้องเรียงลดหลั่น');
});

// ============ M38 — scenarioOutcome ============
const HOLD = [{ symbol: 'X', value: 6000 }, { symbol: 'Y', value: 4000 }];   // total 10000
const BETA = { X: 1.5, Y: 0.5 };
const SCN = [
  { key: 'up', label: 'Up', prob: 50, marketMove: 10 },
  { key: 'dn', label: 'Down', prob: 50, marketMove: -10 },
];

test('scenarioOutcome: ผลพอร์ต = Σ(weight × beta × marketMove)', () => {
  const r = scenarioOutcome(HOLD, BETA, SCN);
  // up: 0.6*1.5*10 + 0.4*0.5*10 = 9 + 2 = 11
  assert.equal(r.scenarios[0].portReturnPct, 11);
  assert.equal(r.scenarios[1].portReturnPct, -11);
});

test('scenarioOutcome: expected = Σ(prob × ผลฉาก)', () => {
  const r = scenarioOutcome(HOLD, BETA, SCN);
  assert.equal(r.expectedReturnPct, 0);   // 0.5*11 + 0.5*-11
  assert.equal(r.probSum, 100);
});

test('scenarioOutcome: best/worst stock ต่อฉากถูกต้อง', () => {
  const r = scenarioOutcome(HOLD, BETA, SCN);
  assert.equal(r.scenarios[0].bestStock.symbol, 'X');   // beta สูงสุดวิ่งแรงสุดตอนตลาดขึ้น
  assert.equal(r.scenarios[0].worstStock.symbol, 'Y');
});

test('scenarioOutcome: beta ขาด → ข้ามตัวนั้น + coverage ลด', () => {
  const r = scenarioOutcome(HOLD, { X: 1.5 }, SCN);   // Y ไม่มี beta
  assert.equal(r.scenarios[0].portReturnPct, 9);       // เฉพาะ X: 0.6*1.5*10
  assert.equal(r.scenarios[0].betaCoveragePct, 60);
});

test('scenarioOutcome: probSum ≠ 100 ถูกรายงาน (กัน expected เพี้ยนเงียบ)', () => {
  const r = scenarioOutcome(HOLD, BETA, [{ key: 'a', label: 'A', prob: 30, marketMove: 5 }]);
  assert.equal(r.probSum, 30);
});

test('defaultScenarios: risk-off ให้ prob hawkish สูงกว่า risk-on + รวม = 100', () => {
  const off = defaultScenarios('risk-off');
  const on = defaultScenarios('risk-on');
  const hawkOff = off.find(s => s.key === 'hawkish').prob;
  const hawkOn = on.find(s => s.key === 'hawkish').prob;
  assert.ok(hawkOff > hawkOn, 'risk-off ควรกลัว hawkish มากกว่า');
  assert.equal(off.reduce((s, x) => s + x.prob, 0), 100);
  assert.equal(on.reduce((s, x) => s + x.prob, 0), 100);
});
