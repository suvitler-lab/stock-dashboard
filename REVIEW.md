# รีวิวระบบตัดสินใจลงทุน — Critique นักลงทุนระดับโลก → สถานะการแก้

> เอกสารนี้ map critique 5 หมวด (มุมมอง PM/quant สถาบัน) เข้ากับสิ่งที่ลงมือแก้จริง · สำหรับโปรแกรมเมอร์รีวิวระบบตอนท้าย
> อัปเดต: มิ.ย. 2026 · ทุกข้อ deploy + verified บน production (`stock-dashboard.suvit-ler.workers.dev`)
> หลักการแกน (ตาม [ARCHITECTURE.md](ARCHITECTURE.md)): **deterministic · ฟรี · ห้าม auto-tune ที่ sample เล็ก**

## 🎯 3 ข้อ ROI สูงสุด (พิสูจน์ว่า edge จริง) — เสร็จหมด
| # | เรื่อง | สถานะ | จุดในโค้ด |
|---|---|---|---|
| 2.1 | slice beatRate ตาม regime | ✅ | `computePerformance` → `byRegime`/`byConviction` ([worker.js](worker.js)) |
| 1.1 | ยุบปัจจัยซ้ำใน signalOf | ✅ | `signalOf` ลบทิ้ง → `convictionScore` + `labelFromConviction` |
| 3.1 | sizing จาก stop จริง | ✅ | `positionSize` ใช้ `s.price - s.sl` (fallback 2×ATR) |

---

## หมวด 1 — Signal design
| # | ปัญหา | แก้ | จุด |
|---|---|---|---|
| 1.1 | signalOf นับปัจจัยเทรนด์ซ้ำ 6-7 รอบ + copy 3 ไฟล์ | ✅ ลบ signalOf จาก worker + alerts · ป้ายมาจาก `convictionScore` (5 มิติ bucketed) ที่เดียว · client เหลือ signalOf ไว้สร้าง "เหตุผล" เท่านั้น (ไม่ใช่ป้าย) | `convictionScore`, `labelFromConviction` (worker.js) · [[signal-three-places]] |
| 1.2 | ผสม trend + mean-reversion ใน score เดียว | ✅ regime-conditional weighting (`CONV_WEIGHTS`: risk-on เน้น trend/momentum, risk-off เปิด meanRev) | `CONV_WEIGHTS` |
| 1.3 | RS เป็นวันเดียว (noise) | ✅ `rs3m` (RS เทรนด์ 3 เดือน ≈63 วัน) ใช้ใน `convictionScore.relStrength` · fallback rsVsSpx | `computeWatchlistData` (rs3m) |
| 1.4 | threshold ลอยๆ/ไม่สมมาตร | ✅ ป้าย/stance ผูก `buyThreshFor(regime)` (60/67/75) ตรงกัน · SELL ≤35 = โซน avoid · calibrate จาก journal = อนาคต (รอข้อมูล) | `buyThreshFor`, `labelFromConviction` |

## หมวด 2 — การวัดผล (edge จริงไหม)
| # | ปัญหา | แก้ | จุด |
|---|---|---|---|
| 2.1 | ไม่ slice ตาม regime | ✅ `byRegime` (BUY beat SPX แยก risk-on/off/neutral) + เก็บคอลัมน์ `regime` ใน D1 (ไปข้างหน้า) | `computePerformance`, `logDailySnapshot`, [schema.sql](schema.sql) |
| 2.2 | ไม่หักต้นทุน | ✅ `beatRateNet`/`avgExcessNet` หัก `COST=0.1%` round-trip | `computePerformance` (COST) |
| 2.3 | ไม่มี risk-adjusted | ✅ `infoRatio = avgExcess / stdevExcess` + slice byConviction tier | `computePerformance` |
| 2.4 | survivorship bias | ✅ **ไม่ต้องแก้** — `signal_history` append-only, วัดทุก symbol ที่เคย snapshot (รวมตัวที่ถอด watchlist) | — |

> ⚠️ ค่าใน byRegime จะ "มีนัยสำคัญ" ต่อเมื่อสะสมหลายเดือน · `regime` เพิ่งเริ่มเก็บ → แถวเก่า = NULL (forward-looking)

## หมวด 3 — ความเสี่ยง & Sizing
| # | ปัญหา | แก้ | จุด |
|---|---|---|---|
| 3.1 | sizing ไม่อิง stop จริง | ✅ (เดิมมี) `stopDist = price - SL ที่ตั้ง` · fallback 2×ATR (โชว์ `stopType`) | `positionSize` |
| 3.2 | เฉลี่ยขาลง (averaging down) | ✅ trend-guarded: ราคา < EMA200 → ลดเหลือ 1 ไม้ + เตือน "ห้ามถัวลึก รับมีดร่วง" | `suggestPro` (src/dashboard.html) |
| 3.3 | factor concentration | ✅ `STOCK_THEMES` map → heat เตือน buy ซ้ำ theme ≥3 ตัว | `themeOf`, heat block |
| 3.4 | ไม่มี kill-switch | ✅ แพ้ติด ≥3 ไม้ (trade_log) → ยกเกณฑ์ +8 + ลดไม้ 50% | `recentLossStreak`, computeDecision |
| 3.5 | correlation ใช้แค่ flag | ✅ corr ≥0.75 กับ holding → ลดไม้ครึ่ง (`corrPenaltyFor` → `sizeFactor`) | `corrPenaltyFor`, `positionSize` |

## หมวด 4 — Fundamentals & Hurdle
| # | ปัญหา | แก้ | จุด |
|---|---|---|---|
| 4.1 | ไม่มีปัจจัยพื้นฐาน | ✅ flag-only — PE/margin/D/E จาก Yahoo quoteSummary (cache 24ชม., warm by cron) → flag "ขาดทุน/หนี้สูง/แพงมาก" | `fetchFundamentals*`, `fundamentalFlags` |
| 4.2 | ไม่มี cash hurdle | ✅ `riskConfig.riskFreePct` (4.5%) → KPI โชว์ค่าเสียโอกาสเงินสด | Settings + cash KPI |
| 4.4 | event blackout = แค่ flag | ✅ งบ 4-7 วัน ×0.6, FOMC ≤2 วัน ×0.7 (ลดไซส์จริง) · งบ ≤3 วัน → wait (เดิม) | `evFactor` in computeDecision |
| 4.3 | long-only ไม่มี hedge | ⏸️ ข้าม (structural — เป็นทางเลือกการลงทุน ไม่ใช่บั๊ก) |

## หมวด 5 — Regime inputs & Execution
| # | ปัญหา | แก้ | จุด |
|---|---|---|---|
| 5.2 | regime แค่ VIX+SPX (ลาก) | ✅ เพิ่ม credit (HYG vs EMA50) + breadth (RSP/SPX vs EMA50) → cap risk-on→neutral ถ้า internals อ่อน | `computeRegimeRaw` |
| 5.1 | fill-probability | ⏸️ ข้าม (ROI ต่ำ) |

---

## สถาปัตยกรรมที่ต้องรู้ (สำหรับคนแก้ต่อ)
- **เครื่องยนต์จริง = `convictionScore(s, regime)`** (worker.js) — 5 มิติ bucketed (trend/momentum/meanRev/moneyFlow/relStrength), ต้อง ≥3 มิติ, regime-weighted · เป็นตัวขับ stance + ป้าย + snapshot
- **ป้าย = `labelFromConviction(score, regime)`** — source เดียว (ไม่ใช่ signalOf เดิม) · KV `signals` (อ่านโดย alerts worker) + `/api/decide` ใช้ตัวนี้ทั้งคู่ = ตรงกัน 100%
- **sizing = `positionSize(s, riskConfig, conviction, sizeFactor)`** · `sizeFactor` = correlation × kill-switch × event-blackout
- **regime = `getRegime`** (hysteresis ≥2 วัน) + internals (credit/breadth) · **deploy:** แก้ `src/dashboard.html` → `node build.cjs` → `npx.cmd wrangler deploy` (ดู [[dashboard-build-precompile]] · [[powershell-npx-cmd]])

## วิธี verify (end-to-end)
```
GET /api/performance     → byRegime / byConviction / infoRatio / costPctAssumed
GET /api/decide          → candidates[].{signal,conviction,sizing.sizeFactor,fundFlags} · regime.{creditOk,breadthOk} · heat.{killSwitch,themeConcentration,lossStreak}
GET /api/warm-earnings    → fundamentals[].flags (อุ่น cache)
POST /api/refresh-signals → เขียน KV signals ใหม่ (ใช้หลัง deploy)
```
- เทียบ label↔buyThresh: candidate ทุกตัว `conviction ≥ buyThresh ⟺ signal=BUY`, `≤35 ⟺ SELL` (mismatch ต้อง 0)

## Known gaps / สิ่งที่ตั้งใจยังไม่ทำ
- **weight (`CONV_WEIGHTS`) + threshold ยังไม่ calibrate** — ตั้งด้วยทฤษฎี · **ห้ามจูนจนกว่า byRegime/byConviction จะสะสมหลายเดือน** (auto-tune sample เล็ก = overfit)
- `entryPlan3` (alerts daily summary, opt-in) ยังไม่ใส่ trend-guard เหมือน client `suggestPro`
- SELL ≤35 ค่อนข้างไว (mega-cap ที่ย่อในตลาด risk-on อาจติด SELL) — จับตา ถ้าไวไปขยาย HOLD band
- fundamentals ผ่าน Yahoo crumb — flaky ได้ (ถ้าดึงไม่ได้ flag หาย ไม่กระทบ decision)
- conviction มิติเป็น discrete ±1/0 → score กระโดดได้ ~10-13 จุดต่อมิติ (ทำให้ smooth = งานอนาคต)
