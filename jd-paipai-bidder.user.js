// ==UserScript==
// @name         京东拍拍夺宝岛抢拍助手（心理价最后一刻出价）
// @namespace    https://1paipai.jd.com/
// @version      1.1.5
// @description  适配新版 1paipai.jd.com 拍卖详情页：设置心理最高价与加价幅度，倒计时最后 N 秒按「当前价+加价幅度」出价（保守竞争模式，不直接出心理价）。仅剩最后几秒出一次价，不刷接口。
// @changelog    1.1.5 修复出价后页面卡死：移除自动关闭弹窗逻辑（元凶——出价失败时页面弹「提示」框，旧版会瞬间关掉并留下全屏遮罩锁死页面）；新增出价结果校验+失败自动重试（最多3次）；自动清理残留遮罩；监听出价接口返回并把成功/失败原因写入日志
// @author       WorkBuddy
// @match        https://1paipai.jd.com/auction-detail/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /********************************************************************
   * 免责声明
   * 1. 本脚本仅供个人学习研究自动化技术使用，与京东官方无关。
   * 2. 使用自动化出价可能违反京东服务条款，存在账号风控/处罚风险，请自行评估。
   * 3. 不保证抢拍成功；出价可能触发验证码，需人工处理。
   ********************************************************************/

  // ---------- 配置 ----------
  const LS_KEY = 'paipai_bidder_config';
  const DEFAULT_AHEAD_SECONDS = 1;   // 倒计时剩余多少秒时出价
  const DEFAULT_BID_STEP = 1;        // 默认加价幅度（元）
  const POLL_MS = 500;               // 轮询间隔
  const MIN_BID_GAP_MS = 1000;       // 出价后冷却（防重复提交）
  const BID_VERIFY_MS = 6000;        // 出价后等待生效的时间
  const MAX_BID_ATTEMPTS = 3;        // 出价未生效时最多尝试次数

  // ---------- 状态 ----------
  let cfg = { maxPrice: '', bidStep: DEFAULT_BID_STEP, aheadSeconds: DEFAULT_AHEAD_SECONDS, running: false };
  let bidLocked = false;             // 本次监控周期内是否已出价
  let bidOutcome = null;             // 出价结果：null=进行中 / 'ok' / 'retry' / 'fail'
  let lastBidAt = 0;
  let timer = null;

  try { const s = localStorage.getItem(LS_KEY); if (s) cfg = Object.assign(cfg, JSON.parse(s)); } catch (e) {}

  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }

  // ---------- 工具函数 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function text(el) { return el ? (el.innerText || '').trim() : ''; }

  // 读取当前状态：beginning=未开拍, ing=竞拍中, ended=已结束, unknown
  function getAuctionState() {
    const banner = $('.auctionBanner');
    const cls = banner ? banner.className : '';
    if (/beginning/.test(cls)) return 'beginning';
    if (/ing/.test(cls)) return 'ing';
    if (/closed|ended/.test(cls)) return 'ended';
    const t = text($('#count-down .text'));
    if (t.includes('开始')) return 'beginning';
    if (t.includes('结束')) return 'ing';
    if (/结束|已结束|流拍/.test((banner ? banner.innerText : '') + ' ' + (document.body.innerText || '').slice(0, 200))) return 'ended';
    return 'unknown';
  }

  // 解析倒计时为总秒数（#J-count-down 内为纯数字 <i> 序列，冒号为 <span>）
  // 兼容 1~4 个数字：秒 / 分:秒 / 时:分:秒 / 天:时:分:秒
  // 从后往前定位：末位=秒、倒数第2=分、倒数第3=时、倒数第4=天
  function getRemainSeconds() {
    const cd = $('#J-count-down');
    if (!cd) return -1;
    const nums = [...cd.querySelectorAll('i')].map(i => parseInt(i.innerText.trim(), 10)).filter(n => !isNaN(n));
    if (!nums.length) return -1;
    const [s = 0, m = 0, h = 0, d = 0] = nums.reverse();
    const sec = d * 86400 + h * 3600 + m * 60 + s;
    return isNaN(sec) ? -1 : sec;
  }

  // 把秒数格式化成易读文本（1天2时3分 / 3分12秒 / 45s）
  function formatDuration(sec) {
    if (sec < 0) return '--';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + '分' + (s ? s + '秒' : '');
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + '时' + (mm ? mm + '分' : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return d + '天' + (hh ? hh + '时' : '');
  }

  function getCurrentPrice() {
    const p = $('.summary-price .p-price .price') || $('.J-summary-price .price');
    return p ? parseFloat(p.innerText) : NaN;
  }

  function getBidCount() { return parseInt(text($('.recordCount')).replace(/[^\d]/g, ''), 10) || 0; }
  function getCapPrice() {
    const p = $('.n-price .price');
    return p ? parseFloat(p.innerText) : NaN;
  }

  // 出价金额输入框（页面实际结构：div.auction-choose-amount > div.dd > .el-input-number > .el-input > input）
  // 注意：容器是 div 不是 li，历史版本误用 li 标签选择器导致永远找不到，这里改用类选择器并加多层兜底
  function getBidInput() {
    return $('.auction-choose-amount input.el-input__inner')
        || $('.p-choose-wrap .el-input-number input.el-input__inner')
        || $('.el-input-number input.el-input__inner')
        || $('#choose-btns input');
  }

  // 出价按钮：优先取「出价」字样的按钮，其次 #choose-btns 内任意可点元素
  function getBidButton() {
    const box = $('#choose-btns');
    if (box) {
      const all = [].slice.call(box.querySelectorAll('a, button'));
      const byText = all.filter(function (b) { return /出价|买下|一口价/.test(text(b)); });
      const usable = (byText.length ? byText : all).filter(function (b) {
        return !b.disabled && !/disabled/.test(b.className || '');
      });
      if (usable.length) return usable[0];
      if (all.length) return all[0];
    }
    return $('#InitCartUrl') || $('a.btn-special6');
  }

  // 判断出价按钮当前是否可点
  function bidButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    const cls = (btn.className || '');
    if (/disabled/.test(cls)) return true;
    const t = text(btn);
    return /即将开始|已结束|已拍出|敬请期待/.test(t);
  }

  // Vue/Element 兼容地给 input 赋值并触发 input 事件
  function setInputValue(input, val) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(val));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 监听出价接口（paipai.auction.offerPrice）的返回，把成功/失败原因写进日志
  function hookBidApi() {
    if (window.__pbBidHooked) return;
    window.__pbBidHooked = true;
    try {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__pbUrl = String(u || ''); return _open.apply(this, arguments); };
      const _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const xhr = this;
        try {
          if (xhr.__pbUrl && xhr.__pbUrl.indexOf('offerPrice') >= 0) {
            xhr.addEventListener('load', function () {
              try {
                const r = JSON.parse(xhr.responseText);
                const msg = r.msg || r.message || '';
                const okCode = ['0', '200', '0000'].indexOf(String(r.code)) >= 0;
                if (r.success === false || (r.code !== undefined && !okCode)) {
                  log('❌ 出价接口拒绝：' + (msg || ('code=' + r.code)) + '（详见页面弹窗）');
                } else {
                  log('✅ 出价接口已受理' + (msg ? '：' + msg : ''));
                }
              } catch (e) { log('出价接口已返回（内容无法解析）'); }
            });
          }
        } catch (e) {}
        return _send.apply(this, arguments);
      };
    } catch (e) {}
  }

  // 弹窗监视（代替旧的自动关弹窗逻辑）：
  // 1. 把可见弹窗的文字播报到日志（便于知道出价被拒的原因）
  // 2. 自动清理"残留遮罩"：遮罩存在但没有任何可见弹窗时，页面会被透明遮罩锁死（点什么都没反应），
  //    连续 2 个周期确认后移除遮罩，恢复页面可点击
  let lastDlgKey = '';
  let maskStuckTicks = 0;
  function visibleDialogs() {
    return [].slice.call(document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper'))
      .filter(function (w) { return w.style.display !== 'none' && w.offsetWidth > 0; });
  }
  function watchDialogs() {
    const dlgs = visibleDialogs();
    if (dlgs.length) {
      maskStuckTicks = 0;
      const t = text(dlgs[0]).replace(/\s+/g, ' ').slice(0, 100);
      if (t && t !== lastDlgKey) { lastDlgKey = t; log('页面弹窗：' + t); }
      if (/验证码|滑动|拼图/.test(t)) { setState('需人工验证', '#fff1f0', '#cf1322'); }
    } else {
      lastDlgKey = '';
      const mask = document.querySelector('.v-modal');
      if (mask && mask.offsetWidth > 0) {
        maskStuckTicks++;
        if (maskStuckTicks >= 2) {
          try { mask.remove(); maskStuckTicks = 0; log('已自动清理残留遮罩（页面卡死已恢复）'); } catch (e) {}
        }
      } else {
        maskStuckTicks = 0;
      }
    }
  }

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.id = 'paipai-bidder-panel';
  panel.style.cssText = [
    'position:fixed;top:12px;right:12px;z-index:99999;width:250px;',
    'background:#fff;border:1px solid #d9d9d9;border-radius:10px;',
    'box-shadow:0 2px 12px rgba(0,0,0,.18);padding:12px 14px;',
    'font:13px/1.6 "Microsoft YaHei",Arial,sans-serif;color:#333;',
    'user-select:none'
  ].join('');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <b style="font-size:14px;color:#e1251b;">🛎 夺宝岛抢拍助手</b>
      <span id="pb-state" style="font-size:12px;padding:1px 8px;border-radius:10px;background:#f0f0f0;color:#999;">未启动</span>
    </div>
    <div style="margin-bottom:6px;">心理最高价（超出即放弃，元）：
      <input id="pb-max" type="number" step="1" min="0" style="width:86px;padding:2px 6px;border:1px solid #d9d9d9;border-radius:4px;"
        placeholder="${cfg.maxPrice || '如 39'}">
    </div>
    <div style="margin-bottom:6px;">加价幅度（元，≥1 整数）：
      <input id="pb-step" type="number" step="1" min="1" style="width:60px;padding:2px 6px;border:1px solid #d9d9d9;border-radius:4px;"
        value="${cfg.bidStep}">
    </div>
    <div style="margin-bottom:8px;">倒计时剩
      <input id="pb-ahead" type="number" step="0.1" min="0.1" max="10" style="width:52px;padding:2px 6px;border:1px solid #d9d9d9;border-radius:4px;"
        value="${cfg.aheadSeconds}"> 秒时出价
    </div>
    <div style="margin-bottom:8px;color:#666;">
      当前价：<b id="pb-price" style="color:#e1251b;">--</b>&nbsp;
      出价 <b id="pb-bids">--</b> 次<br>
      封顶价：<b id="pb-cap" style="color:#333;">--</b>&nbsp;
      状态：<b id="pb-status">--</b>
    </div>
    <div id="pb-log" style="min-height:34px;max-height:72px;overflow:auto;background:#fafafa;border-radius:6px;padding:4px 8px;margin-bottom:8px;color:#555;font-size:12px;"></div>
    <div style="display:flex;gap:8px;">
      <button id="pb-start" style="flex:1;padding:6px 0;border:0;border-radius:6px;background:#e1251b;color:#fff;cursor:pointer;">▶ 开始抢拍</button>
      <button id="pb-stop" style="flex:1;padding:6px 0;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:#666;cursor:pointer;">■ 停止</button>
    </div>
  `;
  document.body.appendChild(panel);

  const elState = panel.querySelector('#pb-state');
  const elPrice = panel.querySelector('#pb-price');
  const elBids = panel.querySelector('#pb-bids');
  const elCap = panel.querySelector('#pb-cap');
  const elStatus = panel.querySelector('#pb-status');
  const elLog = panel.querySelector('#pb-log');
  const elMax = panel.querySelector('#pb-max');
  const elStep = panel.querySelector('#pb-step');
  const elAhead = panel.querySelector('#pb-ahead');
  const elStart = panel.querySelector('#pb-start');
  const elStop = panel.querySelector('#pb-stop');

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
    elLog.prepend(line);
    while (elLog.children.length > 8) elLog.removeChild(elLog.lastChild);
  }

  function setState(txt, bg, color) {
    elState.textContent = txt;
    elState.style.background = bg || '#f0f0f0';
    elState.style.color = color || '#999';
  }

  // ---------- 核心逻辑 ----------
  // 重试查找出价输入框/按钮（Vue 偶发重建 DOM，需容忍）
  function findBidElements(maxTry, gap) {
    return new Promise(function (resolve) {
      let tried = 0;
      (function attempt() {
        const input = getBidInput();
        const btn = getBidButton();
        const btnOk = !!(btn && !bidButtonDisabled(btn));
        // 按钮可点，且（输入框已就绪 或 重试几次后确认本场次确实没有输入框）→ 立即返回，避免白白耗掉最后几秒
        const inputSettled = !!input || tried >= 3;
        if ((btnOk && inputSettled) || tried >= maxTry) {
          resolve({ input: input || null, btn: btn || null });
          return;
        }
        tried++;
        setTimeout(attempt, gap);
      })();
    });
  }

  function tick() {
    // 弹窗监视与残留遮罩清理（无论是否启动都常驻）
    watchDialogs();

    // 刷新信息面板
    const price = getCurrentPrice();
    if (!isNaN(price)) elPrice.textContent = price.toFixed(2);
    elBids.textContent = getBidCount();
    const cap = getCapPrice();
    elCap.textContent = isNaN(cap) ? '--' : cap.toFixed(2);

    const state = getAuctionState();
    const remain = getRemainSeconds();
    const remainTxt = formatDuration(remain);
    const statusMap = {
      beginning: '距开始 ' + remainTxt,
      ing: '距结束 ' + remainTxt,
      ended: '已结束',
      unknown: '未知'
    };
    elStatus.textContent = statusMap[state] || state;

    if (!cfg.running) return;

    if (state === 'beginning') {
      setState('等待开拍', '#fff7e6', '#d48806');
      return;
    }
    if (state === 'ended') {
      setState('已结束', '#f0f0f0', '#999');
      cfg.running = false;
      log('拍卖已结束，停止监控');
      return;
    }
    if (state !== 'ing') { setState('未开拍', '#f0f0f0', '#999'); return; }

    // 竞拍中
    if (bidLocked) {
      const m = {
        ok: ['已出价', '#f6ffed', '#52c41a'],
        retry: ['自动重试中', '#fff7e6', '#d48806'],
        fail: ['出价未生效', '#fff1f0', '#cf1322']
      }[bidOutcome] || ['已出价，等待结果', '#e6f7ff', '#1890ff'];
      setState(m[0], m[1], m[2]);
      return;
    }
    if (remain < 0) return;

    setState('监控中', '#e6f7ff', '#1890ff');

    const ahead = parseFloat(elAhead.value);
    const aheadSec = isNaN(ahead) || ahead <= 0 ? DEFAULT_AHEAD_SECONDS : ahead;

    // 剩余时间 ≤ 提前秒数时出价（保守模式：只加最低幅度，不直接出心理价）
    if (remain <= aheadSec) {
      const maxPrice = parseFloat(elMax.value);
      if (isNaN(maxPrice) || maxPrice <= 0) {
        setState('未设置心理价', '#fff1f0', '#cf1322');
        log('请先填写心理最高价（超出此价即放弃）');
        cfg.running = false;
        return;
      }
      // 加价幅度：至少 1 元、必须整数
      const stepRaw = parseFloat(elStep.value);
      let stepVal;
      if (isNaN(stepRaw) || stepRaw <= 0) {
        stepVal = DEFAULT_BID_STEP;   // 未填 → 默认 1
      } else if (stepRaw < 1 || stepRaw !== Math.floor(stepRaw)) {
        setState('幅度不合法', '#fff1f0', '#cf1322');
        log('加价幅度必须为 ≥1 的整数（如 1、2、5），当前填了 ' + stepRaw + '，停止出价');
        cfg.running = false;
        return;
      } else {
        stepVal = stepRaw;
      }

      // 出价 = 当前价 + 加价幅度
      const cur = getCurrentPrice();
      if (isNaN(cur)) {
        setState('读取价格失败', '#fff1f0', '#cf1322');
        log('无法读取当前价，停止出价');
        cfg.running = false;
        return;
      }
      let bidPrice = cur + stepVal;

      // 封顶价校验：达到封顶价按封顶价一口价买下
      const capPrice = getCapPrice();
      if (!isNaN(capPrice) && bidPrice > capPrice) {
        log('当前价+加价已超封顶价 ' + capPrice + '，按封顶价出价（一口价）');
        bidPrice = capPrice;
      }

      // 心理价校验：出价金额超过心理上限则放弃，不再往上加
      if (bidPrice > maxPrice) {
        setState('超出心理价', '#fff1f0', '#cf1322');
        log('当前价 ' + cur + ' + 加价 ' + stepVal + ' = ' + bidPrice + ' 元 > 心理价 ' + maxPrice + '，放弃出价');
        cfg.running = false;
        return;
      }

      // 冷却保护
      if (Date.now() - lastBidAt < MIN_BID_GAP_MS) { log('出价冷却中，跳过'); return; }

      // 锁定并出价（带结果校验与自动重试）
      bidLocked = true;
      bidOutcome = null;
      lastBidAt = Date.now();
      setState('正在出价', '#e6f7ff', '#1890ff');
      attemptBid(bidPrice, cur, getBidCount(), 1);
    }
  }

  // 出价执行：填金额 → 点击 → 校验结果，未生效自动重试
  function attemptBid(bidPrice, prePrice, preCount, attempt) {
    if (!cfg.running) return;
    findBidElements(8, 150).then(function (els) {
      if (!els.btn) {
        setState('出价按钮不可用', '#fff1f0', '#cf1322');
        log('未找到出价按钮（页面可能已结束/未登录/改版），本次未出价');
        cfg.running = false;
        return;
      }
      if (els.input) {
        setInputValue(els.input, bidPrice);
        log('第 ' + attempt + ' 次出价 ' + bidPrice + ' 元（当前 ' + prePrice + ' + 加价）');
      } else {
        log('第 ' + attempt + ' 次出价（未找到输入框，按页面默认金额）');
      }
      setTimeout(function () {
        if (!cfg.running) return;
        if (bidButtonDisabled(els.btn)) {
          log('出价按钮不可点（' + text(els.btn) + '），本次未出价');
          setState('按钮不可点', '#fff1f0', '#cf1322');
          return;
        }
        try {
          els.btn.click();
          log('已点击出价按钮，等待结果…');
          setState('已提交，等待结果', '#e6f7ff', '#1890ff');
        } catch (e) {
          log('点击出价失败：' + e.message);
          setState('出价失败', '#fff1f0', '#cf1322');
          return;
        }
        verifyBid(bidPrice, prePrice, preCount, attempt);
      }, 80);
    });
  }

  // 校验出价是否真的生效：看出价次数 / 当前价有没有变化
  function verifyBid(bidPrice, prePrice, preCount, attempt) {
    const t0 = Date.now();
    (function check() {
      const cnt = getBidCount();
      const price = getCurrentPrice();
      const state = getAuctionState();
      if (state === 'ended') {
        log('拍卖已结束，停止校验');
        setState('已结束', '#f0f0f0', '#999');
        return;
      }
      if (cnt > preCount || (!isNaN(price) && price >= bidPrice)) {
        log('✅ 出价已生效：当前价 ' + (isNaN(price) ? '?' : price.toFixed(2)) + '，共 ' + cnt + ' 次出价');
        bidOutcome = 'ok';
        setState('已出价', '#f6ffed', '#52c41a');
        return;
      }
      if (Date.now() - t0 < BID_VERIFY_MS) { setTimeout(check, 300); return; }
      // 规定时间内未生效
      if (attempt < MAX_BID_ATTEMPTS && cfg.running) {
        log('⚠ 出价未生效（出价次数仍为 ' + cnt + '），2 秒后自动重试');
        bidOutcome = 'retry';
        setState('重试出价', '#fff7e6', '#d48806');
        lastBidAt = Date.now();
        setTimeout(function () { attemptBid(bidPrice, price, cnt, attempt + 1); }, 2000);
      } else {
        log('❌ 出价未生效且已达最大尝试次数，请手动查看页面弹窗');
        bidOutcome = 'fail';
        setState('出价未生效', '#fff1f0', '#cf1322');
      }
    })();
  }

  function start() {
    cfg.maxPrice = elMax.value;
    const stepRaw = parseFloat(elStep.value);
    cfg.bidStep = (!isNaN(stepRaw) && stepRaw >= 1 && stepRaw === Math.floor(stepRaw)) ? stepRaw : DEFAULT_BID_STEP;
    cfg.aheadSeconds = parseFloat(elAhead.value) || DEFAULT_AHEAD_SECONDS;
    saveCfg();
    cfg.running = true;
    bidLocked = false;
    bidOutcome = null;
    hookBidApi();
    setState('启动中', '#e6f7ff', '#1890ff');
    log('已启动：心理价上限 ' + cfg.maxPrice + ' 元，加价幅度 ' + cfg.bidStep + ' 元，提前 ' + cfg.aheadSeconds + 's 出价');
    const preInput = getBidInput();
    const preBtn = getBidButton();
    log('元素自检：输入框 ' + (preInput ? '✓' : '✗') + ' ｜ 出价按钮 ' + (preBtn ? '✓「' + text(preBtn) + '」' : '✗ 未找到'));
    if (!timer) timer = setInterval(tick, POLL_MS);
    tick();
  }

  function stop() {
    cfg.running = false;
    setState('已停止', '#f0f0f0', '#999');
    log('已停止');
  }

  elStart.addEventListener('click', start);
  elStop.addEventListener('click', stop);

  // 页面加载后先刷新一次信息，并常驻轮询（弹窗播报/遮罩清理需要持续运行）
  setTimeout(function () {
    tick();
    if (!timer) timer = setInterval(tick, POLL_MS);
  }, 800);
})();
