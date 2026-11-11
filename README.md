# 房管家 · 租屋管理安全諮詢 APP v2

房管家興業有限公司　前台 APP ＋ 後台管理系統（Node.js / Express / SQLite）

> 這一版**只在本機建置與測試過**，還沒有部署到任何主機，也沒有動到現在的線上網站。

---

## 一、跟原版比，改了什麼

| 項目 | 原版（app.html / admin.html） | v2 |
|---|---|---|
| 架構 | 兩個靜態 HTML，所有資料寫死在程式裡，重新整理就不見 | Express 伺服器 ＋ SQLite 資料庫，前後台讀寫同一份資料 |
| AI 金鑰 | 金鑰直接寫在前端，任何人都看得到 | 前端不放任何金鑰；改由伺服器 `/api/ai/chat` 代呼叫，金鑰只放在環境變數 `GEMINI_API_KEY` |
| AI 額度 | 無限制 | 依等級限制每日、每分鐘次數（`config/plans.json`） |
| 會員登入 | 按「登入」一律成功 | 真正的註冊與登入，密碼用 scrypt 雜湊，Session 使用 HttpOnly Cookie |
| 後台 | 不用登入就能看，會員個資全部明碼顯示 | 必須用管理員帳號登入；Email／手機預設遮罩，查看完整要填原因並留紀錄 |
| 升級付款 | 點方案就直接升級（免費） | 建立「待付款」訂單 → 金流付款 → 驗證過簽章的金流通知（webhook）才開通 |
| 價格 | 前台、會員中心、後台寫了兩套價格 | 只在 `config/prices.json` 設定一處；尚未定價的方案不能下單 |
| 預約 | 按送出只跳提示 | 寫入資料庫，後台可確認／完成／取消並加備註，前台看得到狀態 |
| 安全 | 無 | CSP、HSTS（production）、CSRF 防護、Origin 檢查、輸入驗證、登入限流、操作紀錄 |

前台畫面沿用原版，只做最小修改：
- 主程式抽到 `public/js/app.js`，並刪掉前端的金鑰和直連 Gemini 的程式。
- 加上 `public/js/bridge.js`，把登入、註冊、升級、AI 諮詢、預約改成呼叫 API。
- 「面對面諮詢（台北事務所）」改成「面對面諮詢（地點由合作事務所確認）」。
- 第三方登入、忘記密碼、雲端存檔這幾個還沒做的功能，改成誠實提示「尚未開放」。
- 法律內容**沒有改**，要等法務校正後再處理。

---

## 二、本機執行

需要 Node.js 20 以上（已用 Node 24 測試）。

```bash
cd v2
npm install
cp .env.example .env          # 打開 .env，至少要改 ADMIN_EMAIL、ADMIN_PASSWORD、PAYMENT_WEBHOOK_SECRET
npm start
```

- 前台：http://localhost:3000/app.html
- 後台：http://localhost:3000/admin（沒登入會自動轉到登入頁）
- 自動測試：`npm test`（會用暫存資料庫跑 69 項測試，不影響正式資料）

本機想試付款流程的話，可以先用測試價格啟動：`PRICES_FILE=./config/prices.test.json npm start`。
付款時會進入「模擬付款頁」，不會真的扣款。

**第一次啟動時**，系統會用 `ADMIN_EMAIL`／`ADMIN_PASSWORD` 建立管理員帳號（密碼至少 12 碼）。
建好之後請到後台「設定與密碼」修改密碼，再把 `.env` 裡的 `ADMIN_PASSWORD` 刪掉。

---

## 三、環境變數

| 變數 | 說明 |
|---|---|
| `NODE_ENV` | 正式環境填 `production`（會啟用 HSTS 和 Secure Cookie，並禁止模擬金流） |
| `PORT` | 預設 3000 |
| `TRUST_PROXY` | 放在 Nginx／Caddy／雲端負載平衡後面時設 `1` |
| `COOKIE_SECURE` | 用 HTTPS 時設 `true`（production 會自動開啟） |
| `DB_FILE` | SQLite 檔案位置，預設 `./data/fgj.sqlite` |
| `SESSION_SECRET` | 選填。沒填的話，系統會自動產生並存在 `data/.server_secret` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | 只在第一次建立管理員時使用 |
| `GEMINI_API_KEY` | **只能放在伺服器**。留空就是「測試模式」，AI 回覆會是模擬文字 |
| `GEMINI_MODEL` | 預設沿用原版的 `gemini-3.5-flash`，可依 Google 現行的型號名稱調整 |
| `PRICES_FILE` | 價格設定檔，預設 `./config/prices.json` |
| `PAYMENT_PROVIDER` | `mock`（模擬）／`ecpay`（綠界）／`newebpay`（藍新）。後兩者還沒實作 |
| `PAYMENT_WEBHOOK_SECRET` | 驗證模擬金流通知用的長隨機字串 |
| `PUBLIC_BASE_URL` | 對外網址，給金流回呼使用 |

> ⚠️ 舊版 app.html 裡的 Gemini 金鑰已經公開外洩，**請先到 Google AI Studio 撤銷那把金鑰**，再產生新的，而且只設定在伺服器的環境變數。新金鑰絕對不要寫進任何 HTML 或 JS。

---

## 四、價格設定（`config/prices.json`）

目前金額全部是 `null`（尚未定價）。原版出現過兩套價格，記錄在檔案的說明欄位裡，供決定時參考：
- 前台方案頁：金牌 $200/月（年繳，標示「原價 $500」）、鑽石 $500/月（年繳，標示「原價 $1,000」）。
- 會員中心與後台：金牌月繳 $500、鑽石月繳 $1,000；年繳分別為每月 $200、$500。

決定好之後，把 `monthly`／`yearly` 填上整數（新台幣、含稅），再重新啟動就會生效。
「原價」和「省 60%」這類字樣已經拿掉，如果要用，必須有真實的原價依據。

---

## 五、金流串接方式（綠界／藍新）

`lib/payments/` 定義了統一的介面：
- `createCheckout(order)`：回傳要導向的付款網址，或要自動送出的表單。
- `parseWebhook(req)`：驗證簽章（綠界是 CheckMacValue，藍新是 TradeSha 加 AES），並回報付款成功或失敗。

訂單只有在**簽章驗證通過的通知**送到 `/api/payments/webhook/<provider>` 時才會變成「已付款」。重複的通知不會重複加值。
`ecpay.js` 和 `newebpay.js` 裡已經寫好要實作的重點，等商店申請下來、拿到 MerchantID、HashKey、HashIV 再補上。
接上金流時，CSP 的 `form-action` 也要加入金流商的網域。

銀行轉帳之類的人工收款，可以在後台「訂單與付款」按「人工對帳」，並填寫備註，系統會留下紀錄。

---

## 六、部署步驟（建議）

1. **主機**：任何能跑 Node 20 的 Linux VPS 都可以，例如 GCP、AWS Lightsail、Linode，或台灣在地的雲端主機。SQLite 適合起步階段，會員變多之後可以換成 PostgreSQL。
2. **網域**：申請 `app.你的網域.tw` 之類的子網域，A 記錄指向主機。
3. **安裝**：
   ```bash
   sudo useradd -r -m fgj
   sudo mkdir -p /opt/fgj-app && sudo chown fgj /opt/fgj-app
   # 把 v2 資料夾上傳到 /opt/fgj-app
   cd /opt/fgj-app && npm ci --omit=dev
   cp .env.example .env && nano .env   # NODE_ENV=production、TRUST_PROXY=1、COOKIE_SECURE=true、填好各項密鑰
   ```
4. **常駐執行**：參考 `fgj-app.service.example` 設定 systemd：`sudo systemctl enable --now fgj-app`。
5. **HTTPS**：參考 `Caddyfile.example` 用 Caddy 反向代理，它會自動申請憑證。用 Nginx 加 certbot 也可以。
6. **備份**：每天備份 `data/fgj.sqlite`，可以用 `sqlite3 data/fgj.sqlite ".backup /backup/fgj-$(date +%F).sqlite"` 搭配 cron，並把備份另外存到別的地方。
7. **上線前檢查**：`NODE_ENV=production`、金流已經不是 `mock`、價格已經填好、舊金鑰已經撤銷、管理員密碼已經改過、服務條款和隱私權政策頁已經上線。

---

## 七、檔案結構

```
v2/
├─ server.js                 主程式（路由、權限、金流流程）
├─ lib/db.js                 資料表與初始內容（只放法規連結和範本示範，不含任何個資）
├─ lib/security.js           密碼雜湊、遮罩、輸入驗證、限流
├─ lib/ai.js                 伺服器端 AI 代理（系統提示也搬到這裡）
├─ lib/payments/             金流介面：mock（模擬）、ecpay、newebpay（待實作）
├─ config/prices.json        唯一的價格設定（目前未定價）
├─ config/prices.test.json   測試用假價格
├─ config/plans.json         各等級的 AI 額度、預約選項
├─ public/app.html           前台（由原版自動轉換）
├─ public/js/app.js          前台主程式（原版抽出，已移除金鑰）
├─ public/js/bridge.js       前台與 API 的串接層
├─ views/admin/              後台（需要管理員登入才拿得到）
├─ views/mock-pay.html       模擬付款頁（production 會停用）
├─ scripts/build-frontend.py 從原版重新產生前台的腳本
└─ scripts/smoke-test.js     自動測試
```

---

## 八、還沒做／已知限制

- 原版內建的 16 種範本還寫在前端（`app.js`），免費／付費的鎖只擋在畫面上。後台「範本管理」新增的範本才由伺服器控管內容。之後可以把原有範本逐步搬進後台。
- 新聞、課程、緊急服務、物件管理這些模組，目前還是原版的示範資料，沒有接到後台。
- 忘記密碼（要寄信）、第三方登入、雲端存檔都還沒做。
- 服務條款、隱私權政策、退費辦法的頁面還沒建立，內容需要法務撰寫。
