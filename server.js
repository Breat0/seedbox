/**
 * 种子盲盒 · 抽签网站（零依赖 Node 服务）
 * 启动：node server.js     默认端口 8787（可用 PORT 环境变量覆盖）
 * 前台：http://<IP>:8787/          手机微信可直接打开
 * 后台：http://<IP>:8787/admin     默认口令 bua2026（可在后台修改）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// 数据目录可用环境变量覆盖（Render 挂载持久磁盘时指向 /var/data）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DRAWS_FILE = path.join(DATA_DIR, 'draws.json');
const CONFIG_FILE = process.env.CONFIG_FILE ? path.resolve(process.env.CONFIG_FILE) : path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT || 8787);

const STAGES = [
  { no: 1, name: '破土', step: 3, chapter: '芽', img: '/assets/stage-1.png',
    tip: '土裂开的那一刻，你第一次被看见', dirs: '起点 · 冲破 · 第一次登台' },
  { no: 2, name: '新生', step: 5, chapter: '芽', img: '/assets/stage-2.png',
    tip: '两片叶子展开，从此自己养活自己', dirs: '独立 · 成长 · 第一次独立完成' },
  { no: 3, name: '向光', step: 6, chapter: '穗', img: '/assets/stage-3.png',
    tip: '茎朝光弯曲，方向是自己选的', dirs: '选择 · 方向 · 追随热爱' },
  { no: 4, name: '扎根', step: 4, chapter: '穗', img: '/assets/stage-4.png',
    tip: '先长根，再长苗；根深才能叶茂', dirs: '基本功 · 师承 · 沉淀' },
  { no: 5, name: '破壳', step: 2, chapter: '根', img: '/assets/stage-5.png',
    tip: '顶开种皮的那一下，最难也最静', dirs: '挣脱 · 突破 · 破圈' },
  { no: 6, name: '蓄力', step: 1, chapter: '根', img: '/assets/stage-6.png',
    tip: '看不见的日子里，养分都在往里存', dirs: '积累 · 等待 · 准备' }
];

// ---------- 存储 ----------
// 首次启动时用环境变量初始化配置（Render 等平台用环境变量传口令最方便）
function defaultConfig() {
  return {
    password: process.env.ADMIN_PASSWORD || 'bua2026',
    perStageQuota: Number(process.env.PER_STAGE_QUOTA) || 12,
    title: process.env.SITE_TITLE || '声耀七十载 · 金话颂北农',
    subtitle: process.env.SITE_SUBTITLE || '种子盲盒 · 六阶签',
    allowRepeat: false
  };
}
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DRAWS_FILE)) fs.writeFileSync(DRAWS_FILE, '[]', 'utf8');
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  }
}
function envOverride(cfg) {
  if (process.env.ADMIN_PASSWORD) cfg.password = process.env.ADMIN_PASSWORD;
  if (process.env.PER_STAGE_QUOTA) {
    const q = Number(process.env.PER_STAGE_QUOTA);
    if (q > 0) cfg.perStageQuota = q;
  }
  if (process.env.SITE_TITLE) cfg.title = process.env.SITE_TITLE;
  if (process.env.SITE_SUBTITLE) cfg.subtitle = process.env.SITE_SUBTITLE;
  return cfg;
}
function loadConfig() {
  ensureDirs();
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { cfg = defaultConfig(); }
  return envOverride(cfg);
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
}
function loadDraws() {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(DRAWS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveDraws(list) {
  fs.writeFileSync(DRAWS_FILE + '.tmp', JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(DRAWS_FILE + '.tmp', DRAWS_FILE);
}

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};
function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}
function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) raw = raw.slice(0, 1e6); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}
const tokens = new Map(); // token -> expireAt
function newToken() {
  const t = crypto.randomBytes(18).toString('hex');
  tokens.set(t, Date.now() + 8 * 3600 * 1000);
  return t;
}
function authOk(token) {
  const exp = tokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(token); return false; }
  return true;
}
function counts(draws) {
  const c = {}; STAGES.forEach(s => c[s.no] = 0);
  draws.forEach(d => { if (c[d.stage] !== undefined) c[d.stage]++; });
  return c;
}
function normSid(s) { return String(s || '').trim().toUpperCase(); }

// ---------- 业务 ----------
function handleDraw(body, req) {
  const cfg = loadConfig();
  const draws = loadDraws();
  const name = String(body.name || '').trim().slice(0, 20);
  const sid = normSid(body.sid).slice(0, 24);
  const cls = String(body.cls || '').trim().slice(0, 24);

  if (!name) return { code: 400, obj: { error: '请填写姓名' } };
  if (!sid || sid.length < 4) return { code: 400, obj: { error: '请填写正确的学号（至少4位）' } };

  const dup = draws.find(d => normSid(d.sid) === sid);
  if (dup) {
    const st = STAGES.find(s => s.no === dup.stage);
    return { code: 409, obj: { error: 'duplicate', message: '你已经拆过盲盒了', draw: Object.assign({}, st, { ts: dup.ts }) } };
  }

  const c = counts(draws);
  const quota = Number(cfg.perStageQuota) || 12;
  const pool = STAGES.filter(s => (c[s.no] || 0) < quota);
  if (!pool.length) return { code: 410, obj: { error: 'empty', message: '盲盒已经拆完啦' } };

  const pick = pool[Math.floor(Math.random() * pool.length)];
  const rec = {
    id: draws.length + 1,
    name, sid, cls,
    stage: pick.no, stageName: pick.name, step: pick.step,
    ts: new Date().toISOString(),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
    ua: String(req.headers['user-agent'] || '').slice(0, 160)
  };
  draws.push(rec);
  saveDraws(draws);
  return {
    code: 200, obj: {
      ok: true,
      seq: c[pick.no] + 1,
      draw: Object.assign({}, pick, { ts: rec.ts, name, sid, cls })
    }
  };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = decodeURIComponent(u.pathname);

  // API
  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
  if (p === '/api/info' && req.method === 'GET') {
    const cfg = loadConfig(), draws = loadDraws(), c = counts(draws);
    return sendJson(res, 200, {
      title: cfg.title, subtitle: cfg.subtitle, quota: cfg.perStageQuota,
      counts: c, total: draws.length, stages: STAGES
    });
  }
  if (p === '/api/draw' && req.method === 'POST') {
    const body = await readBody(req);
    const r = handleDraw(body, req);
    return sendJson(res, r.code, r.obj);
  }
  if (p === '/api/mine' && req.method === 'GET') {
    const sid = normSid(u.searchParams.get('sid'));
    if (!sid) return sendJson(res, 400, { error: '缺少学号' });
    const draws = loadDraws();
    const d = draws.find(x => normSid(x.sid) === sid);
    if (!d) return sendJson(res, 404, { error: 'notfound' });
    const st = STAGES.find(s => s.no === d.stage) || {};
    return sendJson(res, 200, { draw: Object.assign({}, st, { ts: d.ts, name: d.name, sid: d.sid, cls: d.cls }) });
  }
  if (p === '/api/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    if (String(body.password || '') !== String(cfg.password)) return sendJson(res, 401, { error: '口令不正确' });
    return sendJson(res, 200, { ok: true, token: newToken() });
  }
  if (p === '/api/admin/data' && req.method === 'GET') {
    if (!authOk(u.searchParams.get('token'))) return sendJson(res, 401, { error: '登录已过期' });
    const cfg = loadConfig(), draws = loadDraws();
    return sendJson(res, 200, { config: { perStageQuota: cfg.perStageQuota }, draws, stats: counts(draws), stages: STAGES });
  }
  if (p === '/api/admin/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!authOk(body.token)) return sendJson(res, 401, { error: '登录已过期' });
    const cfg = loadConfig();
    if (body.perStageQuota !== undefined) {
      const q = Math.max(1, Math.min(200, Number(body.perStageQuota) || cfg.perStageQuota));
      cfg.perStageQuota = q;
    }
    if (body.password && String(body.password).length >= 4) cfg.password = String(body.password);
    saveConfig(cfg);
    const locked = [];
    if (process.env.ADMIN_PASSWORD) locked.push('口令');
    if (process.env.PER_STAGE_QUOTA) locked.push('配额');
    return sendJson(res, 200, {
      ok: true, config: loadConfig(),
      note: locked.length ? ('注意：' + locked.join('、') + '由环境变量控制，后台修改不会生效，请改环境变量并重新部署') : ''
    });
  }
  if (p === '/api/admin/reset' && req.method === 'POST') {
    const body = await readBody(req);
    if (!authOk(body.token)) return sendJson(res, 401, { error: '登录已过期' });
    if (body.confirm !== 'RESET') return sendJson(res, 400, { error: '需要二次确认' });
    saveDraws([]);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/export' && req.method === 'GET') {
    if (!authOk(u.searchParams.get('token'))) return sendJson(res, 401, { error: '登录已过期' });
    const draws = loadDraws();
    const head = '序号,抽取时间,姓名,学号,班级,阶段,生长步\n';
    const rows = draws.map(d => {
      const t = new Date(d.ts);
      const pad = (n) => String(n).padStart(2, '0');
      const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      const esc = (v) => '"' + String(v === undefined ? '' : v).replace(/"/g, '""') + '"';
      return [d.id, time, esc(d.name), esc(d.sid), esc(d.cls), esc(d.stageName), d.step].join(',');
    }).join('\n');
    const csv = '\ufeff' + head + rows;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="seedbox-draws.csv"'
    });
    return res.end(Buffer.from(csv, 'utf8'));
  }

  // 静态文件
  let file = p === '/' ? '/index.html' : p;
  if (file === '/admin' || file === '/admin/') file = '/admin.html';
  const full = path.join(PUBLIC, path.normalize(file).replace(/^([/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
});

ensureDirs();
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const ifs = os.networkInterfaces();
  const real = [], virtual = [];
  const VIRTUAL_KEYS = ['vmware', 'vmnet', 'vethernet', 'hyper-v', 'virtualbox', 'loopback', 'bluetooth', 'tailscale', 'zerotier', 'docker'];
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((i) => {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) return;
      const low = name.toLowerCase();
      const isVirtual = VIRTUAL_KEYS.some((k) => low.indexOf(k) >= 0) || /^192\.168\.(5[0-9]|1[0-9][0-9])\./.test(i.address);
      (isVirtual ? virtual : real).push({ name, address: i.address });
    });
  });

  console.log('');
  console.log('==================================================');
  console.log('  种子盲盒已启动');
  console.log('==================================================');
  console.log('  本机测试 : http://127.0.0.1:' + PORT + '/');
  if (real.length) {
    real.forEach((r) => console.log('  手机访问 : http://' + r.address + ':' + PORT + '/   ← ' + r.name + '（手机须连同一 Wi-Fi）'));
  } else {
    console.log('  手机访问 : 没找到可用的实体网卡，请确认 Wi-Fi 已连接');
  }
  if (virtual.length) {
    virtual.forEach((r) => console.log('  不用这个 : http://' + r.address + ':' + PORT + '/   ← ' + r.name + '（虚拟网卡，手机连不上）'));
  }
  console.log('  管理后台 : http://127.0.0.1:' + PORT + '/admin');
  console.log('  数据文件 : ' + DRAWS_FILE);
  console.log('');
  console.log('  手机打不开？按顺序试：');
  console.log('   1) 双击同目录「放行防火墙.bat」（需点"是"授权）');
  console.log('   2) 手机与电脑连同一个 Wi-Fi，且不是校园网访客网络');
  console.log('   3) 仍不行：手机开个人热点 → 电脑连这个热点 → 用新地址访问');
  console.log('==================================================');
  console.log('');
});
