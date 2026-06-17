/* Build: src/dashboard.html (มี inline JSX) -> public/dashboard.html + public/app.js
 * - แตก <script type="text/babel"> ออกมา คอมไพล์ JSX -> app.js ด้วย esbuild (ผ่าน npx)
 * - สลับ <script unpkg react/react-dom/babel> เป็น vendor ที่ self-host + app.js
 * รัน:  node build.cjs   (ต้องมี network ให้ npx ดึง esbuild ครั้งแรก)
 * แก้ dashboard ต่อไป: แก้ที่ src/dashboard.html เสมอ แล้วรัน build ใหม่ก่อน deploy
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const dir = __dirname;
const srcHtml = fs.readFileSync(path.join(dir, "src", "dashboard.html"), "utf8");

// 1) แตก inline JSX
const openTag = '<script type="text/babel" data-presets="react">';
const start = srcHtml.indexOf(openTag);
if (start < 0) throw new Error("ไม่พบ <script type=text/babel> ใน src/dashboard.html");
const bodyStart = start + openTag.length;
const end = srcHtml.indexOf("</script>", bodyStart);
if (end < 0) throw new Error("ไม่พบ </script> ปิด babel block");
const jsx = srcHtml.slice(bodyStart, end);

// 2) คอมไพล์ JSX -> app.js (เขียน temp .jsx แล้วเรียก esbuild)
const tmp = path.join(dir, "_app.jsx");
fs.writeFileSync(tmp, jsx, "utf8");
try {
  execSync(
    `npx.cmd --yes esbuild "${tmp}" --loader:.jsx=jsx --jsx=transform --minify --charset=utf8 --outfile="${path.join(dir, "public", "app.js")}"`,
    { cwd: dir, stdio: "inherit" }
  );
} finally {
  fs.unlinkSync(tmp);
}

// 2.5) hash เนื้อ app.js → cache-bust (?v=) · URL เปลี่ยนเฉพาะเมื่อโค้ดเปลี่ยน
// กัน browser/edge/bfcache ค้างเวอร์ชันเก่าหลัง deploy — ไม่ต้อง hard-refresh อีก
const appHash = require("crypto")
  .createHash("sha1")
  .update(fs.readFileSync(path.join(dir, "public", "app.js")))
  .digest("hex")
  .slice(0, 10);

// 3) สร้าง public/dashboard.html — สลับ CDN เป็น vendor + app.js (ตัด Babel ทิ้ง)
let html = srcHtml
  .replace(
    '<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
    '<script src="/vendor/react.production.min.js"></script>'
  )
  .replace(
    '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>',
    '<script src="/vendor/react-dom.production.min.js"></script>'
  )
  .replace('<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n', "");
// แทน babel block ด้วย <script src=/app.js>
const block = srcHtml.slice(start, end + "</script>".length);
html = html.replace(block, `<script src="/app.js?v=${appHash}"></script>`);

fs.writeFileSync(path.join(dir, "public", "dashboard.html"), html, "utf8");

const sz = (p) => (fs.statSync(p).size / 1024).toFixed(1) + " KiB";
console.log("✓ public/app.js        =", sz(path.join(dir, "public", "app.js")));
console.log("✓ public/dashboard.html=", sz(path.join(dir, "public", "dashboard.html")), "· app.js?v=" + appHash);
