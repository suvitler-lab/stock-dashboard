# สถาปัตยกรรมระบบตัดสินใจลงทุน (Investment Decision System)

> **สถานะ (มิ.ย. 2026): Phase 0–4 + critique นักลงทุนระดับโลก 5 หมวด เสร็จและ deploy แล้ว**
> Endpoints: `/decide` `/thesis` `/performance` `/positions` `/api/surprise` · catalyst/heat/position-tracking ครบ · cache fullData ลด /decide เหลือ ~วินาที
> **ยกระดับ 5 หมวด (signal/วัดผล/ความเสี่ยง/พื้นฐาน/regime) → ดู [REVIEW.md](REVIEW.md)** (critique→สถานะ→โค้ด→วิธี verify)
> conviction engine: 5 มิติ regime-weighted · ป้าย=conviction (เลิก signalOf) · RS 3 เดือน · sizing หัก corr/kill-switch/event · regime + credit/breadth · fundamentals flag
> รายละเอียด implementation อยู่ใน memory `d1-journal-phase05.md` · build/precompile: `dashboard-build-precompile.md`


> เป้าหมาย: ยกระดับจาก "data → prompt → vibes" เป็นระบบที่ **วัดผลได้ + มีวินัย + จำได้**
> หลักการแกน: แยก "สิ่งที่คำนวณได้" (โค้ด ฟรี ทดสอบได้) ออกจาก "สิ่งที่ต้องใช้วิจารณญาณ" (LLM เฉพาะจุด)
> งบประมาณ: **$0/เดือน** อยู่ใน free tier ของ Cloudflare + Gemini ทั้งหมด

---

## ภาพรวม 5 ชั้น (Data Flow)

```
┌──────────────────────────────────────────────────────────────────┐
│  ชั้น 5 · PRESENTATION (สิ่งที่คุณเห็น)                              │
│  /decide (รายงานตัดสินใจ) · Telegram (surprise-only) · /report     │
└───────────────▲──────────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────────┐
│  ชั้น 4 · JUDGMENT (LLM — ใช้แค่ ~15% ที่ต้องวิจารณญาณ)             │
│  Thesis generator · บังคับ JSON schema + invalidation + confidence │
│  ป้อนเฉพาะ candidate ที่ผ่าน gate แล้วเท่านั้น (ประหยัด token)       │
└───────────────▲──────────────────────────────────────────────────┘
                │ (candidate + conviction + เหตุผลเชิงตัวเลข)
┌───────────────┴──────────────────────────────────────────────────┐
│  ชั้น 3 · DECISION ENGINE (โค้ดล้วน — deterministic, ฟรี, เร็ว)     │
│  1. Market Regime    risk-on/off จาก VIX+breadth+SPX/EMA200        │
│  2. Hard Screen      ตัดตัวไม่เข้าเงื่อนไขก่อน                       │
│  3. Conviction Score 6 มิติ → 0-100 (weight ตาม regime)            │
│  4. Position Sizing  risk-based จาก ATR + conviction               │
│  5. Risk Gate        correlation/concentration/ไม่ซ้ำ theme         │
│  6. Playbook Match   เช็คกฎที่ตั้งไว้ตอนหัวเย็น (กัน FOMO)           │
│  7. Surprise Detect  มีอะไร "เปลี่ยน regime" จริงไหม                │
└──────▲────────────────────────────────────────────▲───────────────┘
       │                                            │
┌──────┴─────────────────────┐     ┌────────────────┴───────────────┐
│  ชั้น 1 · DATA              │     │  ชั้น 2 · MEMORY (D1 SQLite)    │
│  Yahoo proxy (มีแล้ว)       │     │  decision_journal               │
│  Indicators (มีแล้ว:        │     │  signal_history (snapshot)      │
│  RSI/MACD/ATR/Beta/Corr/    │     │  calibration (confidence vs ผล) │
│  CMF/RS/Bollinger/52w...)   │     │  → cron วัดผลย้อนหลังรายสัปดาห์ │
│  KV: watchlist/positions/   │     └────────────────────────────────┘
│      playbook               │
└────────────────────────────┘
```

---

## รายละเอียดแต่ละชั้น

### ชั้น 1 — DATA (มีอยู่แล้ว 90%)
- **Yahoo Finance proxy** ผ่าน Worker (`/api/stocks`) — ฟรี
- **Indicators engine** — RSI(วัน/สัปดาห์), MACD, ROC, EMA stack, Bollinger, CMF, RS vs S&P, Volume ratio, ATR14, Beta1y, Correlation 30/60d, Implied Move, 52-week
- **KV store** — watchlist, positions, alertCfg + **เพิ่มใหม่: `playbook`** (กฎเข้า/ออกที่ตั้งไว้ล่วงหน้า)

### ชั้น 2 — MEMORY (สร้างใหม่ · หัวใจของระบบ · ใช้ D1)
นี่คือสิ่งที่ทำให้ระบบ "รู้ว่าตัวเองดีแค่ไหน" — ขาดไม่ได้

**ตาราง D1:**
```sql
-- บันทึกทุกครั้งที่ออก signal (cron รายวันหลังตลาดปิด)
signal_history(
  id, ts, symbol, signal, conviction, price,
  rsi, macd_hist, cmf, rs_vs_spx, atr14, beta, regime,
  snapshot_json     -- เก็บ indicator ครบชุด ณ เวลานั้น
)

-- บันทึกการตัดสินใจ + thesis ของ LLM
decision_journal(
  id, ts, symbol, action, conviction, thesis,
  invalidation_price, confidence,   -- LLM ต้องระบุ
  outcome_5d, outcome_10d, outcome_20d  -- เติมทีหลังโดย cron
)

-- สรุปผลแบบง่าย (ดูด้วยตา ไม่ต้อง Brier ตอนแรก)
outcome_summary(
  signal_type, n, win_rate, avg_return, avg_vs_spx  -- ชนะ benchmark กี่%
)
```
> หมายเหตุ: เริ่มจาก 2 ตารางแรกก็พอ · `outcome_summary` คือ view/query สรุป ไม่ใช่ตารางหลัก

**Cron วัดผลย้อนหลัง (รายสัปดาห์):**
- ดึง signal เมื่อ 5/10/20 วันก่อน → เทียบราคาปัจจุบัน → คำนวณ hit rate ต่อ signal type
- **วัดแบบ benchmark-relative ไม่ใช่ absolute:** เทียบ return ของ signal กับ "ถ้าถือ SPX ช่วงเดียวกัน" — ในตลาดขาขึ้น สุ่มซื้อก็ถูก 60% · edge จริงคือ **ชนะ benchmark** ไม่ใช่ hit rate ดิบ
- วัดบน **signal ทั้งหมด (paper)** ไม่ใช่แค่ที่ซื้อจริง → sample เยอะกว่า + ไม่มี selection bias จากอารมณ์

**✅ ความจริงเรื่อง scale (อย่าหลอกตัวเอง):**
- ที่ 21 หุ้น กว่าจะมี 30-50 decisions ใช้เวลา **หลายเดือนถึงเป็นปี** → **Brier score / calibration เข้มงวด ยังไม่มีนัยสำคัญทางสถิติ** อย่าเพิ่งทำ
- เริ่มจาก **tracking ง่าย ๆ ก่อน:** "BUY แล้ว 10 วันบวกกี่%, ชนะ SPX กี่ครั้ง" — ตารางธรรมดา ดูด้วยตาได้
- **weight ปรับด้วยมือ (มนุษย์ดูแล้วตัดสิน) ไม่ auto-tune** — auto-tune กับ sample เล็ก = overfit noise แน่นอน · ระบบแค่ "แสดงผลให้ดู" คุณเป็นคนปรับ
- คุณค่าจริงของระบบนี้คือ **วินัย + ความจำ + กระบวนการที่คงเส้นคงวา** ไม่ใช่ "ML ที่ปรับตัวเอง" — อย่าคาดหวังผิดทาง

**⚠️ กับดักที่ต้องกันตั้งแต่ออกแบบ:**
- **Data integrity (lookahead bias):** Yahoo คืน adjusted-close ที่ **เปลี่ยนย้อนหลัง**เมื่อมี dividend/split → ทำให้ outcome เพี้ยน · **ต้องเก็บราคา raw ณ เวลานั้นใน snapshot** แล้ววัดผลจาก snapshot-to-snapshot ไม่ใช่ดึง history ใหม่มาเทียบ
- **Idempotent:** ใส่ `UNIQUE(ts_date, symbol)` กัน cron รันซ้ำ/เด้งสร้างแถวซ้ำ
- **Sample size:** 21 หุ้น signal เปลี่ยนไม่บ่อย → กว่าจะ significant ใช้หลายเดือน · ช่วงแรกคือ **"เก็บข้อมูลเงียบ ๆ" ไม่ใช่ปรับ weight ทันที**
- **Backup:** ข้อมูลสะสม "ย้อนเก็บไม่ได้" → มี endpoint `/api/journal-export` (CSV/JSON) ดึงสำรองเป็นระยะ · กันลบ D1 ผิด/free-tier มีปัญหา

### ชั้น 3 — DECISION ENGINE (สร้างใหม่ · โค้ดล้วน · ฟรี)
รันใน Worker ทั้งหมด ไม่เรียก LLM → ฟรี เร็ว ทดสอบได้ ตอบเหมือนเดิมทุกครั้ง

1. **Market Regime** — `risk-on / neutral / risk-off` จาก **VIX level + SPX vs EMA200** (ข้อมูลที่ดึงได้จริง)
   - ⚠️ **ตัด "market breadth" ออก** — breadth จริงต้องมีข้อมูลหุ้นหลายร้อยตัวใน index แต่เราดึงแค่ 21 ตัว คำนวณไม่ได้ · ถ้าอยากได้ proxy หยาบ ใช้ `^GSPC`+`^NDX` เทียบ EMA200 ตัวเอง พอ
   - **ต้องมี hysteresis** — ต้องอยู่สภาพใหม่ ≥2-3 วันก่อนสลับ regime กัน whipsaw (flip ไปมารายวัน)
2. **Hard Screen** — กฎตายตัว ตัด candidate ที่ไม่ผ่าน (เช่น ต่ำกว่า SMA200 ใน risk-off)
   - **แยก Core vs Tactical (สำคัญ):** ติด tag ต่อหุ้นใน watchlist — `core` (ETF/ถือยาว เช่น VOO/QQQI/SMH → ไม่ส่ง signal trade, แสดงแค่ context) vs `tactical` (รายตัว เช่น GEV/AVGO/NVDA → เข้า decision engine เต็ม) · กัน "SELL VOO" ที่ไร้สาระ
3. **Conviction Score (0-100)** — รวมจากสัญญาณที่มีอยู่แล้ว (RSI/MACD/CMF/RS/EMA stack...) เป็นคะแนนเดียว
   - **เริ่มเรียบง่าย: weight คงที่ชุดเดียว** — regime แค่ปรับ "ทิศ/threshold" (risk-off → ยกเกณฑ์ BUY ให้สูงขึ้น) ไม่ต้องมี weight matrix หลายชุดตั้งแต่แรก
   - อัปเกรดเป็น weight ต่อ regime **ทีหลัง** เมื่อมีข้อมูลพิสูจน์ว่าคุ้ม · อย่าทำซับซ้อนก่อนจำเป็น
4. **Position Sizing** — risk-based: `size = (เงินที่ยอมเสียต่อ trade) / (2 × ATR)` × conviction factor — ไม่ให้ LLM เดาเลข
   - **ต้องมี config ใหม่ใน KV `riskConfig`:** เงินพอร์ตรวม + % ที่ยอมเสียต่อ trade (เช่น 1%) → ไม่งั้นสูตรไม่มี input
5. **Risk Gate** — เช็คก่อนอนุมัติ: correlation กับพอร์ตที่ถือ (มี `pairCorr30` แล้ว), concentration, ไม่เพิ่ม exposure ซ้ำ theme (AI/semi)
6. **Playbook Match** — เทียบกับกฎที่ตั้งไว้ตอนหัวเย็น → เด้งเฉพาะเมื่อเงื่อนไขครบ (กัน FOMO)
7. **Surprise Detector** — flag เฉพาะเมื่อ regime เปลี่ยนจริง: CMF พลิกขั้ว, RS เปลี่ยนข้าง, volume spike, correlation พุ่ง

### ชั้น 4 — JUDGMENT (LLM · ใช้ฟรี tier)
เรียก LLM **เฉพาะ candidate ที่ผ่าน gate แล้ว** (ปกติ 2-5 ตัว/วัน ไม่ใช่ 21) → ประหยัด token มหาศาล

**บังคับ output schema (JSON):**
```json
{
  "symbol": "AVGO",
  "stance": "buy | wait | avoid",
  "confidence": 0-100,
  "bull_case": "...",
  "bear_case": "...",
  "invalidation": "หลุด $XXX = thesis ผิด ออกทันที",
  "missing_info": "ข้อมูลอะไรที่ถ้ารู้จะเปลี่ยนใจ"
}
```
- บังคับ `invalidation` + `confidence` ทุกครั้ง → เก็บลง journal → วัด calibration ได้
- ตัวเลือก LLM: **Gemini 2.0 Flash (free tier 1,500 req/วัน)** หรือ Cloudflare Workers AI (Llama, ฟรี) หรือ copy `/text` ไป Claude/Gemini เอง (ฟรี)
- **LLM = enrichment ไม่ใช่ critical path:** ถ้า API ล่ม/เกิน rate limit → ชั้น 3 (decision engine) ต้องทำงานต่อได้โดยไม่มี thesis · อย่าให้ทั้งระบบพังเพราะ LLM
- **API key เก็บใน `wrangler secret`** ไม่ hardcode

### ชั้น 5 — PRESENTATION
- **`/decide`** (endpoint ใหม่) — รันทั้ง pipeline → รายงานตัดสินใจฉบับเต็ม (regime + candidate + conviction + thesis + sizing + invalidation)
- **Telegram** — เปลี่ยนจาก "รายงานทุกวัน" เป็น **surprise-only** (เด้งเฉพาะของสำคัญ → เลิก alert fatigue)
- **`/report`, `/text`, `/live`** — คงไว้ (มีแล้ว)

---

## ตารางค่าใช้จ่าย (เน้นฟรี)

| ส่วนประกอบ | บริการ | Free Tier | พอใช้ไหม (21 หุ้น) |
|---|---|---|---|
| Compute | Cloudflare Workers | 100,000 req/วัน | ✅ เหลือเฟือ |
| Memory/Journal | **Cloudflare D1** | 5GB · อ่าน 5M/วัน · เขียน 100k/วัน | ✅ เหลือเฟือ |
| State | Cloudflare KV | อ่าน 100k · เขียน 1k/วัน | ✅ (มีแล้ว) |
| Cron | Cloudflare Triggers | รวมใน Workers | ✅ ฟรี |
| ราคาหุ้น | Yahoo Finance | ไม่จำกัด (unofficial) | ✅ ฟรี |
| LLM judgment | **Gemini 2.0 Flash** | 1,500 req/วัน · 15 RPM | ✅ (ใช้ 2-5/วัน) |
| LLM สำรอง | Cloudflare Workers AI | 10,000 Neurons/วัน | ✅ ฟรี |
| แจ้งเตือน | Telegram Bot | ไม่จำกัด | ✅ ฟรี |
| **รวม** | | | **$0/เดือน** |

**ข้อควรรู้:**
- **D1 ฟรีเพียงพอจริง** — 21 หุ้น × 1 snapshot/วัน = ~7,700 แถว/ปี เทียบ limit เขียน 100k/วัน
- **เลี่ยง Cloudflare Queues** (ต้อง Workers Paid $5/เดือน) — ใช้ cron + D1 แทนได้ทั้งหมด
- ค่าใช้จ่ายเดียวที่อาจโผล่: ถ้า backtest ย้อนหลังหนักมาก หรือเรียก LLM เกิน free tier — scale ระดับนี้ไม่ถึง

---

## ลำดับการสร้าง (Phase Rollout)

| Phase | ทำอะไร | ทำไมก่อน | Effort |
|---|---|---|---|
| **0** ✅ | Data + Indicators (เสร็จแล้ว) | ฐานข้อมูล | — |
| **0.5** 🎯🎯 | **D1 + snapshot logging เงียบ ๆ (เก็บราคา raw รายวัน)** | **ทำก่อนสุด — เพราะ calibration ถูกจำกัดด้วยเวลา ไม่ใช่ effort** ยิ่งเริ่มเก็บเร็ว ยิ่งมีข้อมูลวัดผลเร็ว · ทำเดี่ยว ๆ ได้แม้ส่วนอื่นยังไม่เสร็จ | ต่ำ |
| **1** | Cron วัดผลย้อนหลัง + calibration บน log ที่สะสม | เปลี่ยน log → มาตรวัด edge | กลาง |
| **2** | Decision Engine (regime/conviction/sizing/risk gate) + `riskConfig` → `/decide` | เปลี่ยน vibes เป็นกระบวนการ | กลาง-สูง |
| **3** | Playbook + Surprise Detector → Telegram อัจฉริยะ | กัน FOMO + เลิก alert fatigue | ต่ำ-กลาง |
| **4** | LLM Judgment layer (schema-bound) + Calibration | ความเห็นที่วัดความแม่นได้ | กลาง |
| **5** | (ทางเลือก) Multi-agent debate | ROI ต่ำสุด ทำท้ายสุด | สูง |

**กฎเหล็ก:** ทำ **Phase 0.5 (logging) ก่อนสุด** แม้ส่วนอื่นยังไม่พร้อม — เพราะข้อมูลที่หายไปวันนี้ ย้อนเก็บไม่ได้ · ทุก Phase หลังพึ่ง "ข้อมูลว่าอะไรเวิร์ก" ซึ่งต้องใช้เวลาสะสม

---

## สิ่งที่ต้องตัดสินใจก่อนลงมือ
1. **LLM ตัวไหนเป็นหลัก** — Gemini Flash (free API, auto) vs copy `/text` ไปเอง (ฟรี 100% แต่ manual)
2. **ความถี่ snapshot** — รายวันหลังตลาดปิด (พอ + ประหยัด) vs ทุก 15 นาที (ละเอียดแต่เปลือง)
   - หมายเหตุ: ตลาด US ปิด ~04:00 น.ไทย → cron snapshot ตั้ง **05:00 น.ไทย = `0 22 * * 1-5` UTC** (จ-ศ)
3. **เริ่ม Phase 0.5 เลยไหม** — สร้าง D1 binding + ตาราง + cron logging (ของที่หายวันนี้ย้อนเก็บไม่ได้)

---

## บันทึกการแก้แผน
**รอบ 2** — กันกับดัก infra/สถิติ 7 จุด: **(1)** Phase 0.5 logging ก่อนสุด · **(2)** ราคา raw กัน lookahead · **(3)** UNIQUE กัน dup · **(4)** weight freeze กัน overfit · **(5)** regime hysteresis กัน whipsaw · **(6)** `riskConfig` ให้ sizing · **(7)** LLM = enrichment

**รอบ 3** — กันกับดักเชิงพอร์ต/การวัดผล 3 จุด: **(8)** แยก Core vs Tactical (กัน "SELL VOO") · **(9)** วัด benchmark-relative + paper ทั้งหมด (กันหลอกตัวเองด้วย hit rate ดิบ) · **(10)** journal backup/export (ข้อมูลย้อนเก็บไม่ได้)

**รอบ 4 (reality-check — ตัดของเพ้อฝัน)** — **(11)** ตัด market breadth (ดึงไม่ได้ที่ 21 หุ้น = ผิดเทคนิค) · **(12)** downgrade Brier/calibration → tracking ง่าย ๆ (sample เล็กไม่มีนัยสำคัญหลายเดือน) · **(13)** weight ปรับมือ ไม่ auto-tune (กัน overfit noise) · **(14)** conviction weight คงที่ชุดเดียวก่อน regime แค่ปรับ threshold (อย่าซับซ้อนก่อนจำเป็น)
> สรุป: คุณค่าจริง = **วินัย + ความจำ + กระบวนการคงเส้นคงวา** ไม่ใช่ ML ปรับตัวเอง · ทุกชิ้นในแผน ship ได้จริงด้วยข้อมูล/เครื่องมือที่มีอยู่
