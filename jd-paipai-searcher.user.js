// ==UserScript==
// @name         京东拍拍夺宝岛商品搜索助手（隐去不匹配商品）
// @namespace    https://1paipai.jd.com/
// @version      1.2.0
// @description  夺宝岛列表页商品搜索：①输入关键词即刻隐去当前页不匹配商品；②深度搜索在当前浏览的分类内自动翻页扫描，结果以原生卡片样式汇总展示。点击结果直达详情页，配合抢拍助手自动出价。
// @author       WorkBuddy
// @match        https://1paipai.jd.com/auction-list*
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /********************************************************************
   * 免责声明
   * 1. 本脚本仅供个人学习研究自动化技术使用，与京东官方无关。
   * 2. 自动翻页扫描可能加重站点负担，已做节流；请勿把扫描页数调得过大。
   * 3. 仅供个人购物比价使用，请遵守京东服务条款。
   ********************************************************************/

  // ---------- 配置 ----------
  const LS_KEY = 'paipai_searcher_config';   // 搜索偏好
  const PAGE_GAP_MS = 600;                   // 每页之间的停顿（节流）
  const PAGE_WAIT_MS = 8000;                 // 单页翻页等待上限

  let cfg = {
    kw: '', maxPrice: '', remainMin: '', quality: 'all',
    scanPages: 10
  };
  try { const s = localStorage.getItem(LS_KEY); if (s) cfg = Object.assign(cfg, JSON.parse(s)); } catch (e) {}
  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }

  // ---------- DOM 工具 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
  function text(el) { return el ? (el.innerText || '').trim() : ''; }

  function cards() { return $$('li.gl-item'); }
  function pager() { return $('.el-pagination'); }
  function activePage() {
    const li = $('.el-pager li.active');
    const n = li ? parseInt(text(li), 10) : NaN;
    return isNaN(n) ? 0 : n;
  }

  // ---------- 卡片解析 ----------
  // li.gl-item：.p-name 标题 / .p-price 当前价 / .origin-price 原价 /
  // .p-label 成色 / .p-time .desc(距开始|距结束) .time(0天0时3分24秒) / .p-btn 状态
  function parseCountdownText(s) {
    const g = { tian: 0, shi: 0, fen: 0, miao: 0 };
    const parts = s.match(/\d+\s*(?:天|时|分|秒)/g) || [];
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (/天/.test(p)) g.tian = n; else if (/时/.test(p)) g.shi = n;
      else if (/分/.test(p)) g.fen = n; else if (/秒/.test(p)) g.miao = n;
    }
    return ((g.tian * 24 + g.shi) * 60 + g.fen) * 60 + g.miao;
  }

  function parseCard(li) {
    const title = text(li.querySelector('.p-name'));
    const priceTxt = text(li.querySelector('.p-price'));
    const price = parseFloat((priceTxt.match(/[\d.]+/) || [])[0]);
    const original = parseFloat((text(li.querySelector('.origin-price')).match(/[\d.]+/) || [])[0]);
    const label = text(li.querySelector('.p-label'));
    const desc = text(li.querySelector('.p-time .desc'));
    const timeStr = text(li.querySelector('.p-time .time'));
    const btnTxt = text(li.querySelector('.p-btn'));
    const href = (li.querySelector('a') || {}).href || '';
    const id = (href.match(/auction-detail\/(\d+)/) || [])[1] || href;
    const remainSec = parseCountdownText(timeStr);
    const phase = desc.includes('开始') ? 'wait' : 'ing';   // wait=未开拍 ing=竞拍中
    // 结束/开始时刻（抓取瞬间换算）
    let atTime = '';
    if (timeStr) {
      const d = new Date(Date.now() + remainSec * 1000);
      const p = n => String(n).padStart(2, '0');
      atTime = p(d.getHours()) + ':' + p(d.getMinutes());
    }
    return { title, price, original, label, desc, btnTxt, href, id, remainSec, phase, atTime };
  }

  // ---------- 匹配 ----------
  function readQuery() {
    return {
      kw: elKw.value.trim(),
      maxPrice: parseFloat(elMaxPrice.value),
      remainMin: parseFloat(elRemain.value),
      quality: elQuality.value
    };
  }

  function matches(item, q) {
    const kws = q.kw.split(/\s+/).filter(Boolean);
    if (kws.length && !kws.every(k => item.title.toLowerCase().includes(k.toLowerCase()))) return false;
    if (!isNaN(q.maxPrice) && q.maxPrice > 0 && !(item.price <= q.maxPrice)) return false;
    // 剩余时间筛选：只约束"竞拍中且距结束"的商品；未开拍的场次不受此限制
    if (!isNaN(q.remainMin) && q.remainMin > 0 && item.phase === 'ing' && item.remainSec > q.remainMin * 60) return false;
    if (q.quality !== 'all' && !item.label.includes(q.quality)) return false;
    return true;
  }

  // ---------- UI ----------
  const bar = document.createElement('div');
  bar.id = 'paipai-searcher-bar';
  bar.style.cssText = [
    'position:fixed;top:12px;right:12px;z-index:99998;width:268px;',
    'background:#fff;border:1px solid #d9d9d9;border-radius:10px;',
    'box-shadow:0 2px 12px rgba(0,0,0,.15);padding:10px 12px;',
    'font:13px/1.6 "Microsoft YaHei",Arial,sans-serif;color:#333;'
  ].join('');
  bar.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <b style="font-size:13px;color:#e1251b;">🔍 夺宝岛搜索助手</b>
      <span id="ps-fold" style="cursor:pointer;color:#999;font-size:12px;">收起 ▾</span>
    </div>
    <div id="ps-body">
      <input id="ps-kw" placeholder="关键词，多个用空格分隔（如：睡衣 女）"
        style="width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #d9d9d9;border-radius:4px;margin-bottom:6px;"
        value="${(cfg.kw || '').replace(/"/g, '&quot;')}">
      <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
        <input id="ps-price" type="number" min="0" placeholder="价格≤"
          style="width:70px;padding:3px 6px;border:1px solid #d9d9d9;border-radius:4px;" value="${cfg.maxPrice || ''}">
        <input id="ps-remain" type="number" min="0" placeholder="剩≤分钟"
          style="width:80px;padding:3px 6px;border:1px solid #d9d9d9;border-radius:4px;" value="${cfg.remainMin || ''}">
        <select id="ps-quality" style="padding:3px 4px;border:1px solid #d9d9d9;border-radius:4px;">
          <option value="all">全部成色</option>
          <option value="99成新">99成新</option>
          <option value="95成新">95成新</option>
          <option value="准新品">准新品</option>
        </select>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button id="ps-live" style="flex:1;padding:4px 0;border:0;border-radius:5px;background:#e1251b;color:#fff;cursor:pointer;">过滤本页</button>
        <button id="ps-clear" style="flex:1;padding:4px 0;border:1px solid #d9d9d9;border-radius:5px;background:#fff;color:#666;cursor:pointer;">清除</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
        <button id="ps-deep" title="在当前浏览的分类内翻页扫描（不切换分类）" style="flex:1.4;padding:4px 0;border:0;border-radius:5px;background:#ff6600;color:#fff;cursor:pointer;">本分类深搜</button>
        <select id="ps-pages" title="扫描页数（每页50个）" style="padding:3px 4px;border:1px solid #d9d9d9;border-radius:4px;">
          <option value="5">5页</option>
          <option value="10">10页</option>
          <option value="20">20页</option>
        </select>
      </div>
      <div id="ps-status" style="color:#666;font-size:12px;min-height:18px;">输入关键词即可过滤当前页</div>
      <div id="ps-progress" style="display:none;color:#ff6600;font-size:12px;margin-top:4px;"></div>
    </div>
  `;
  document.body.appendChild(bar);

  const elKw = bar.querySelector('#ps-kw');
  const elMaxPrice = bar.querySelector('#ps-price');
  const elRemain = bar.querySelector('#ps-remain');
  const elQuality = bar.querySelector('#ps-quality');
  const elLive = bar.querySelector('#ps-live');
  const elClear = bar.querySelector('#ps-clear');
  const elDeep = bar.querySelector('#ps-deep');
  const elPages = bar.querySelector('#ps-pages');
  const elStatus = bar.querySelector('#ps-status');
  const elProgress = bar.querySelector('#ps-progress');
  const elFold = bar.querySelector('#ps-fold');
  const elBody = bar.querySelector('#ps-body');

  elPages.value = String(cfg.scanPages || 10);
  if (cfg.quality) elQuality.value = cfg.quality;

  function setStatus(msg, color) { elStatus.textContent = msg; elStatus.style.color = color || '#666'; }
  function setProgress(msg) {
    if (msg) { elProgress.style.display = 'block'; elProgress.textContent = msg; }
    else { elProgress.style.display = 'none'; elProgress.textContent = ''; }
  }

  elFold.addEventListener('click', function () {
    const hidden = elBody.style.display === 'none';
    elBody.style.display = hidden ? 'block' : 'none';
    elFold.textContent = hidden ? '收起 ▾' : '展开 ▸';
  });

  function persistCfg() {
    cfg.kw = elKw.value.trim();
    cfg.maxPrice = elMaxPrice.value;
    cfg.remainMin = elRemain.value;
    cfg.quality = elQuality.value;
    cfg.scanPages = parseInt(elPages.value, 10) || 10;
    saveCfg();
  }

  // ---------- 即时过滤（当前页） ----------
  let liveOn = false;

  function applyLiveFilter() {
    if (!liveOn) return;
    const q = readQuery();
    if (!q.kw && (isNaN(q.maxPrice) || !q.maxPrice) && (isNaN(q.remainMin) || !q.remainMin) && q.quality === 'all') {
      setStatus('请先输入关键词或筛选条件', '#cf1322');
      return;
    }
    const list = cards();
    let hit = 0;
    for (const li of list) {
      const m = matches(parseCard(li), q);
      li.style.display = m ? '' : 'none';
      if (m) hit++;
    }
    setStatus('本页匹配 ' + hit + ' / ' + list.length + ' 个商品（翻页自动继续过滤）', hit ? '#52c41a' : '#999');
  }

  elLive.addEventListener('click', function () {
    liveOn = true;
    persistCfg();
    applyLiveFilter();
  });

  elClear.addEventListener('click', function () {
    liveOn = false;
    for (const li of cards()) li.style.display = '';
    setStatus('已恢复显示全部商品');
  });

  // 关键词输入即时过滤（已开启过滤状态下）
  elKw.addEventListener('input', function () { if (liveOn) applyLiveFilter(); });
  elMaxPrice.addEventListener('input', function () { if (liveOn) applyLiveFilter(); });
  elRemain.addEventListener('input', function () { if (liveOn) applyLiveFilter(); });
  elQuality.addEventListener('change', function () { if (liveOn) applyLiveFilter(); });

  // 翻页/切分类后自动重新应用（Vue 重建卡片 DOM）
  let obs = null;
  let obsPaused = false;
  function watchList() {
    const ul = $('ul.gl-wrap');
    if (!ul || !ul.parentElement) return;
    let deb = null;
    obs = new MutationObserver(function () {
      if (obsPaused || !liveOn) return;
      clearTimeout(deb);
      deb = setTimeout(applyLiveFilter, 150);
    });
    obs.observe(ul.parentElement, { childList: true, subtree: true });
  }

  // ---------- 等待工具 ----------
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitFor(cond, timeout) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      (function check() {
        let ok = false;
        try { ok = cond(); } catch (e) {}
        if (ok) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(check, 200);
      })();
    });
  }

  function firstCardId() { const c = cards()[0]; return c ? parseCard(c).id : ''; }

  // ---------- 深度搜索（在当前浏览的分类内扫描） ----------
  let deepRunning = false;
  let deepCancel = false;
  let resultLayer = null;

  // 当前选中的分类名（用于结果标注；识别失败返回空串）
  function currentCategory() {
    const lis = $$('.auction_nav li');
    const active = lis.find(l => /active|selected|cur|on/.test(l.className || '')) ||
      lis.find(l => {
        const a = l.querySelector('a');
        return a && /active|selected|cur|on/.test(a.className || '');
      });
    return active ? text(active) : '';
  }

  async function gotoFirstPage() {
    if (activePage() === 1) return true;
    const li = $$('.el-pager li.number').find(l => text(l) === '1');
    if (li) {
      li.click();
      await waitFor(() => activePage() === 1, PAGE_WAIT_MS);
    }
    await sleep(400);
    return activePage() === 1;
  }

  async function gotoNextPage() {
    const next = $('.el-pagination .btn-next');
    if (!next || next.disabled) return false;
    const target = activePage() + 1;
    const prevId = firstCardId();
    next.click();
    const ok = await waitFor(function () {
      return activePage() === target && firstCardId() && firstCardId() !== prevId;
    }, PAGE_WAIT_MS);
    await sleep(PAGE_GAP_MS);
    return ok;
  }

  // 收集当前页匹配项（含克隆节点）
  function collectPage(q, sink) {
    const list = cards();
    let hit = 0;
    for (const li of list) {
      const item = parseCard(li);
      if (matches(item, q)) {
        item.clone = li.cloneNode(true);
        item.clone.style.display = '';
        sink.push(item);
        hit++;
      }
    }
    return hit;
  }

  // 静默扫描：在当前分类内翻页收集数据，不切换分类
  async function silentScan(maxPages, q, onProgress) {
    const items = [];
    if (!(await gotoFirstPage())) throw new Error('无法回到第 1 页');
    for (let p = 1; p <= maxPages; p++) {
      if (deepCancel) break;
      if (onProgress) onProgress(p, maxPages);
      collectPage(q, items);
      if (p === maxPages) break;
      const ok = await gotoNextPage();
      if (!ok) break;   // 无更多页
    }
    // 按 id 去重
    const seen = new Set();
    return items.filter(it => { if (!it.id || seen.has(it.id)) return false; seen.add(it.id); return true; });
  }

  // 结果层：隐藏原列表 + 分页，插入克隆卡片
  function renderResults(items, elapsed, catName) {
    removeResultLayer();
    const ul = $('ul.gl-wrap');
    if (!ul) return;
    const box = document.createElement('div');
    box.id = 'pps-result-layer';
    box.style.cssText = 'margin:10px 0;';

    const ing = items.filter(i => i.phase === 'ing').length;
    const catTxt = catName ? '「' + catName + '」分类内 · ' : '';
    const head = document.createElement('div');
    head.style.cssText = 'padding:8px 12px;background:#fff7e6;border:1px solid #ffd591;border-radius:8px;margin-bottom:10px;font-size:13px;color:#873800;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;';
    head.innerHTML = '<span>' + catTxt + '搜索结果：<b>' + items.length + '</b> 场（竞拍中 ' + ing + '，未开拍 ' + (items.length - ing) + '）· 耗时 ' + elapsed + 's · 剩余时间为抓取时刻数据</span>';
    const exitBtn = document.createElement('button');
    exitBtn.textContent = '退出搜索，恢复列表';
    exitBtn.style.cssText = 'padding:3px 10px;border:1px solid #ffd591;border-radius:5px;background:#fff;color:#873800;cursor:pointer;';
    exitBtn.addEventListener('click', exitResultView);
    head.appendChild(exitBtn);
    box.appendChild(head);

    const grid = document.createElement('ul');
    grid.className = 'gl-wrap';
    grid.style.cssText = 'list-style:none;padding:0;margin:0;';
    for (const it of items) {
      const node = it.clone;
      // 角标：结束/开始时刻
      if (it.atTime) {
        const tag = document.createElement('div');
        tag.style.cssText = 'color:#999;font-size:12px;padding:0 0 4px 4px;';
        tag.textContent = (it.phase === 'ing' ? '预计 ' + it.atTime + ' 结束' : it.atTime + ' 开拍');
        node.appendChild(tag);
      }
      grid.appendChild(node);
    }
    box.appendChild(grid);
    ul.parentElement.insertBefore(box, ul);
    ul.style.display = 'none';
    const pg = pager();
    if (pg) pg.style.display = 'none';
    resultLayer = box;
  }

  function removeResultLayer() {
    if (resultLayer) { try { resultLayer.remove(); } catch (e) {} resultLayer = null; }
    const ul = $('ul.gl-wrap');
    if (ul) ul.style.display = '';
    const pg = pager();
    if (pg) pg.style.display = '';
  }

  async function exitResultView() {
    obsPaused = true;
    removeResultLayer();
    await gotoFirstPage();   // 留在当前分类，只回到第 1 页
    obsPaused = false;
    setStatus('已恢复列表');
  }

  async function runDeepSearch() {
    if (deepRunning) return;
    persistCfg();
    const q = readQuery();
    if (!q.kw && (isNaN(q.maxPrice) || !q.maxPrice) && (isNaN(q.remainMin) || !q.remainMin) && q.quality === 'all') {
      setStatus('请先输入关键词或筛选条件', '#cf1322');
      return;
    }
    deepRunning = true; deepCancel = false;
    const maxPages = parseInt(elPages.value, 10) || 10;
    const catName = currentCategory();
    const t0 = Date.now();
    liveOn = false;
    setProgress('深度搜索中（' + (catName || '当前分类') + '）：第 1/' + maxPages + ' 页…');
    try {
      obsPaused = true;
      const items = await silentScan(maxPages, q, function (p, total) {
        setProgress('深度搜索中（' + (catName || '当前分类') + '）：第 ' + p + '/' + total + ' 页…' + (deepCancel ? '（正在取消）' : ''));
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (deepCancel) { setStatus('已取消深度搜索'); return null; }
      renderResults(items, elapsed, catName);
      setStatus('深度搜索完成：' + items.length + ' 场匹配 · ' + elapsed + 's', items.length ? '#52c41a' : '#999');
      if (!items.length) setStatus('未找到匹配商品，试试放宽关键词/筛选', '#999');
      scrollIntoResults();
      return items;
    } catch (e) {
      setStatus('搜索出错：' + e.message, '#cf1322');
      return null;
    } finally {
      obsPaused = false;
      deepRunning = false;
      setProgress('');
    }
  }

  function scrollIntoResults() {
    const head = $('#pps-result-layer > div');
    if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  elDeep.addEventListener('click', function () { runDeepSearch(); });

  // 双击深度搜索按钮 = 取消
  elDeep.addEventListener('dblclick', function () { deepCancel = true; });

  // ---------- 初始化 ----------
  const initTimer = setInterval(function () {
    if (cards().length) { clearInterval(initTimer); watchList(); }
  }, 500);
  setTimeout(function () { clearInterval(initTimer); }, 20000);
})();
