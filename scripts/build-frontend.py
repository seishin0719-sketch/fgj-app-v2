#!/usr/bin/env python3
"""由原版 app.html 產生 v2 前台：移除外洩金鑰與直連 Gemini 的程式、把主程式抽成外部 JS、補上 API 串接所需的 id。"""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root.parent / 'original' / 'app_src_page.html').read_text(encoding='utf-8')

def must_replace(s, old, new, count=1):
    if s.count(old) < 1:
        sys.exit('找不到要替換的片段：' + old[:60])
    return s.replace(old, new, count)

head, rest = src.split('<script>\n', 1)
script, tail = rest.rsplit('</script>', 1)

# ---- 1. 移除前端金鑰、模型、系統提示與直連 Gemini 的函式（改由伺服器 /api/ai/chat）----
a = script.index('/* ★ 在此填入你的 Gemini API Key')
b = script.index('function escapeHtml(')
script = script[:a] + '/* v2：AI 金鑰與系統提示已移到伺服器端（/api/ai/chat），前端不再持有任何金鑰。 */\n\n' + script[b:]
a = script.index('async function callGemini(')
b = script.index('/*==================== 物件')
script = script[:a] + '/* v2：sendMsg() 改由 /js/bridge.js 提供 */\n\n' + script[b:]
assert 'GEMINI_API_KEY' not in script and 'generativelanguage' not in script
assert not re.search(r"AQ\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}", script)
script = must_replace(script, "toast('已存至「我的文件」雲端')", "toast('雲端存檔功能即將推出')")

# ---- 2. HTML 調整（最小修改）----
h = head
h = must_replace(h, '<span onclick="toast(\'密碼重設連結已寄出\')">忘記密碼</span>', '<span onclick="toast(\'請透過 LINE OA 聯繫客服協助重設密碼\')">忘記密碼</span>')
h = must_replace(h, '<div onclick="doLogin()">💬</div><div onclick="doLogin()">🍎</div><div onclick="doLogin()">✉️</div>',
                 '<div onclick="toast(\'第三方登入尚未開放\')">💬</div><div onclick="toast(\'第三方登入尚未開放\')">🍎</div><div onclick="toast(\'第三方登入尚未開放\')">✉️</div>')
h = must_replace(h, '<input class="input" placeholder="請輸入真實姓名">', '<input class="input" id="rg-name" maxlength="40" placeholder="請輸入真實姓名">')
h = must_replace(h, '<input class="input" placeholder="09xx-xxx-xxx">', '<input class="input" id="rg-phone" inputmode="tel" maxlength="12" placeholder="09xx-xxx-xxx">')
h = must_replace(h, '<input class="input" placeholder="example@mail.com">', '<input class="input" id="rg-email" type="email" maxlength="254" placeholder="example@mail.com">')
h = must_replace(h, '<label class="fl">身份</label>\n          <select class="input">', '<label class="fl">身份</label>\n          <select class="input" id="rg-identity">')
h = must_replace(h, '<input class="input" type="password" placeholder="至少 8 碼英數字">', '<input class="input" type="password" id="rg-pwd" autocomplete="new-password" placeholder="至少 8 碼，含英文與數字">')
h = must_replace(h, '<input class="input" type="password" placeholder="請再輸入一次">', '<input class="input" type="password" id="rg-pwd2" autocomplete="new-password" placeholder="請再輸入一次">')
h = must_replace(h, '☑ 我已閱讀並同意服務條款', '<label><input type="checkbox" id="rg-agree"> 我已閱讀並同意服務條款與隱私權政策</label>')
h = must_replace(h, '<button class="btn btn-gold" onclick="doLogin()">註冊並開始使用</button>', '<button class="btn btn-gold" onclick="doRegister()">註冊並開始使用</button>')
h = must_replace(h, '<option>面對面諮詢（台北事務所）</option>', '<option>面對面諮詢（地點由合作事務所確認）</option>')
h = must_replace(h, '<label class="fl">問題類別</label>\n            <select class="input">', '<label class="fl">問題類別</label>\n            <select class="input" id="bkCat">')
h = must_replace(h, '<label class="fl">希望日期</label>\n            <input class="input" type="date">', '<label class="fl">希望日期</label>\n            <input class="input" type="date" id="bkDate">')
h = must_replace(h, '<label class="fl">希望時段（每節 1 小時）</label>\n            <select class="input">', '<label class="fl">希望時段（每節 1 小時）</label>\n            <select class="input" id="bkSlot">')
h = must_replace(h, '<textarea class="input" rows="3" placeholder="簡述您的狀況，律師將事先了解"></textarea>', '<textarea class="input" rows="3" id="bkSummary" maxlength="1000" placeholder="簡述您的狀況，律師將事先了解"></textarea>')
h = must_replace(h, 'onclick="toast(\'預約申請已送出，將由專人聯繫確認 ✓\')">送出預約申請</button>', 'onclick="submitBooking()">送出預約申請</button>\n            <div id="myBookings" style="margin-top:12px"></div>')
h = re.sub(r'<div class="ld">[^<]*│ 09\d\d-\d{3}-\d{3}</div>', '<div class="ld" id="meAcc">尚未登入</div>', h, count=1)
assert 'id="meAcc"' in h
h = must_replace(h, '<div class="ld">已產生 12 份範本文件</div>', '<div class="ld">即將推出</div>')
h = must_replace(h, '<div class="list-item" onclick="toast(\'已登出\')">', '<div class="list-item" onclick="doLogout()">')
h = must_replace(h, '<div id="lawList"></div>', '<div id="lawList"></div>\n        <div id="kbServer"></div>')
h = must_replace(h, '<div id="tplList"></div>', '<div id="tplList"></div>\n        <div id="tplServer"></div>')
tail = must_replace(tail, '', '')

out_html = h + '<script src="/js/app.js"></script>\n<script src="/js/bridge.js"></script>' + tail
(root / 'public' / 'app.html').write_text(out_html, encoding='utf-8')
(root / 'public' / 'js' / 'app.js').write_text('/* 房管家前台主程式（由原版 app.html 抽出，已移除前端 AI 金鑰） */\n' + script, encoding='utf-8')
print('ok', len(out_html.splitlines()), 'lines html;', len(script.splitlines()), 'lines js')
