-- Phase 0.5 — Decision Journal schema
-- snapshot ราคา+อินดิเคเตอร์รายวัน (เก็บราคา raw กัน lookahead bias)

CREATE TABLE IF NOT EXISTS signal_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_date       TEXT NOT NULL,          -- YYYY-MM-DD (วันที่ snapshot เวลาไทย)
  ts_iso        TEXT NOT NULL,          -- ISO timestamp เต็ม
  symbol        TEXT NOT NULL,
  signal        TEXT,                   -- BUY/HOLD/SELL ณ เวลานั้น
  price         REAL,                   -- ราคา raw (livePrice) — ใช้วัดผล snapshot-to-snapshot
  regular_close REAL,                   -- ราคาปิด regular session
  rsi           REAL,
  rsi_weekly    REAL,
  macd_hist     REAL,
  cmf           REAL,
  rs_vs_spx     REAL,
  atr14         REAL,
  beta1y        REAL,
  ema50         REAL,
  ema200        REAL,
  sma200        REAL,
  change_pct    REAL,
  spx_change    REAL,                   -- %เปลี่ยน S&P500 วันนั้น (ไว้วัด benchmark-relative)
  spx_price     REAL,                   -- ราคา S&P500 ณ snapshot (วัด excess snapshot-to-snapshot)
  conviction    REAL,                   -- conviction score 0-100 ณ เวลานั้น (slice ผลตาม tier)
  regime        TEXT,                   -- risk-on/off/neutral ณ วันนั้น (slice ผลตาม regime) — เพิ่ม มิ.ย.2026
  snapshot_json TEXT,                   -- indicator ครบชุด ณ เวลานั้น (เผื่ออนาคต)
  UNIQUE(ts_date, symbol)               -- idempotent กัน cron รันซ้ำ
);

CREATE INDEX IF NOT EXISTS idx_sh_symbol_date ON signal_history(symbol, ts_date);
CREATE INDEX IF NOT EXISTS idx_sh_date ON signal_history(ts_date);

-- บันทึกการตัดสินใจ + thesis (ใช้ตอน Phase 4 — สร้างไว้ล่วงหน้า)
CREATE TABLE IF NOT EXISTS decision_journal (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_iso             TEXT NOT NULL,
  symbol             TEXT NOT NULL,
  action             TEXT,              -- buy/wait/avoid
  conviction         REAL,
  thesis             TEXT,
  invalidation_price REAL,
  confidence         REAL,
  outcome_5d         REAL,              -- เติมทีหลังโดย cron วัดผล
  outcome_10d        REAL,
  outcome_20d        REAL
);

CREATE INDEX IF NOT EXISTS idx_dj_symbol ON decision_journal(symbol);

-- Conflict Resolution log — บันทึก verdict รายวัน เพื่อวัด calibration ทีหลัง (join กับ signal_history)
-- "verdict ที่วัดความแม่นไม่ได้ = ความเชื่อ ไม่ใช่ edge" — ต้อง log ตั้งแต่วันแรก
CREATE TABLE IF NOT EXISTS resolution_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_date        TEXT NOT NULL,         -- YYYY-MM-DD (เวลาไทย)
  ts_iso         TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  status         TEXT,                  -- conflict/review
  verdict        TEXT,                  -- BUY เล็ก/WAIT/AVOID/HOLD/TRIM
  score          REAL,                  -- คะแนนรวม 0-100
  engine_stance  TEXT,
  thesis_stance  TEXT,
  regime         TEXT,
  price          REAL,                  -- ราคา ณ ตอน verdict (วัดผลทีหลัง)
  UNIQUE(ts_date, symbol)               -- idempotent กัน cron/refresh ซ้ำวันเดียว
);

CREATE INDEX IF NOT EXISTS idx_rl_symbol ON resolution_log(symbol, ts_date);
