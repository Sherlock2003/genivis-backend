const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'visitors.json');
const LOG_FILE = path.join(__dirname, 'visit_logs.json');

app.use(cors());
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getHourStr() {
  return new Date().toISOString().slice(0, 13);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { total: 0, today: 0, date: getTodayStr() };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, JSON.stringify({ daily: {}, hourly: {}, visits: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
}

function saveLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function logVisit(req) {
  const logs = loadLogs();
  const today = getTodayStr();
  const hour = getHourStr();
  const now = new Date();

  logs.daily[today] = (logs.daily[today] || 0) + 1;
  logs.hourly[hour] = (logs.hourly[hour] || 0) + 1;

  const visit = {
    timestamp: now.toISOString(),
    date: today,
    time: now.toTimeString().slice(0, 8),
    hour: now.getHours(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
    device: getDevice(req.headers['user-agent'] || ''),
  };

  logs.visits.unshift(visit);
  if (logs.visits.length > 1000) logs.visits = logs.visits.slice(0, 1000);
  saveLogs(logs);
}

function getDevice(ua) {
  if (/mobile/i.test(ua)) return 'Mobile';
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

// ── Online Session Tracking ───────────────────────────────
const onlineSessions = new Map();
const SESSION_TIMEOUT_MS = 35 * 1000;

function cleanSessions() {
  const now = Date.now();
  for (const [id, ts] of onlineSessions.entries()) {
    if (now - ts > SESSION_TIMEOUT_MS) onlineSessions.delete(id);
  }
}

function getOnlineCount() {
  cleanSessions();
  return Math.max(onlineSessions.size, 0);
}

// ── Routes ───────────────────────────────────────────────

app.get('/api/visit', (req, res) => {
  let data = loadData();
  const today = getTodayStr();
  if (data.date !== today) { data.today = 0; data.date = today; }
  const sid = req.query.sid || 'unknown';
  onlineSessions.set(sid, Date.now());
  if (req.query.new === '1') {
    data.total += 1;
    data.today += 1;
    saveData(data);
    logVisit(req);
  }
  res.json({ total: data.total, today: data.today, online: getOnlineCount() });
});

app.get('/api/ping', (req, res) => {
  const sid = req.query.sid || 'unknown';
  onlineSessions.set(sid, Date.now());
  res.json({ online: getOnlineCount() });
});

app.post('/api/leave', (req, res) => {
  const sid = req.query.sid || req.body?.sid || 'unknown';
  onlineSessions.delete(sid);
  res.json({ online: getOnlineCount() });
});

app.get('/api/stats', (req, res) => {
  let data = loadData();
  const today = getTodayStr();
  if (data.date !== today) { data.today = 0; data.date = today; saveData(data); }
  res.json({ total: data.total, today: data.today, online: getOnlineCount() });
});

app.get('/api/reports', (req, res) => {
  const { from, to, password } = req.query;
  if (password !== (process.env.ADMIN_PASSWORD || 'genivis@admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const logs = loadLogs();
  const data = loadData();

  let daily = {};
  Object.entries(logs.daily).forEach(([date, count]) => {
    if ((!from || date >= from) && (!to || date <= to)) daily[date] = count;
  });

  let hourly = {};
  Object.entries(logs.hourly).forEach(([hour, count]) => {
    const date = hour.slice(0, 10);
    if ((!from || date >= from) && (!to || date <= to)) hourly[hour] = count;
  });

  let visits = logs.visits.filter(v => (!from || v.date >= from) && (!to || v.date <= to));

  const devices = { Desktop: 0, Mobile: 0, Tablet: 0 };
  visits.forEach(v => { if (devices[v.device] !== undefined) devices[v.device]++; });

  const hourCounts = {};
  visits.forEach(v => { hourCounts[v.hour] = (hourCounts[v.hour] || 0) + 1; });

  res.json({
    summary: { total: data.total, today: data.today, online: getOnlineCount(), periodTotal: visits.length },
    daily, hourly, hourCounts, devices,
    recentVisits: visits.slice(0, 50),
  });
});

// ── RESET ROUTE ───────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  const { password, resetType } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || 'genivis@admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = getTodayStr();

  if (resetType === 'all') {
    // Reset everything
    saveData({ total: 0, today: 0, date: today });
    saveLogs({ daily: {}, hourly: {}, visits: [] });
    onlineSessions.clear();
    return res.json({ success: true, message: 'All counters and logs reset to zero.' });
  }

  if (resetType === 'today') {
    let data = loadData();
    data.today = 0;
    data.date = today;
    saveData(data);
    // Also clear today's logs
    const logs = loadLogs();
    delete logs.daily[today];
    Object.keys(logs.hourly).forEach(h => { if (h.startsWith(today)) delete logs.hourly[h]; });
    logs.visits = logs.visits.filter(v => v.date !== today);
    saveLogs(logs);
    return res.json({ success: true, message: "Today's count reset to zero." });
  }

  if (resetType === 'total') {
    let data = loadData();
    data.total = 0;
    saveData(data);
    return res.json({ success: true, message: 'Total visitors reset to zero.' });
  }

  return res.status(400).json({ error: 'Invalid resetType. Use: all, today, total' });
});

setInterval(cleanSessions, 30 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Genivis Visitor Counter API running on port ${PORT}`);
});
