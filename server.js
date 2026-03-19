const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'visitors.json');

app.use(cors());
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { total: 1240, today: 0, date: getTodayStr(), online: 0 };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Online users: track active sessions by IP + timestamp
const onlineSessions = new Map(); // ip -> lastSeen timestamp
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getOnlineCount() {
  const now = Date.now();
  for (const [ip, ts] of onlineSessions.entries()) {
    if (now - ts > SESSION_TIMEOUT_MS) onlineSessions.delete(ip);
  }
  return onlineSessions.size || 1;
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── Routes ───────────────────────────────────────────────

// GET /api/visit — called when a user lands on the page
// Increments total + today counter, returns stats
app.get('/api/visit', (req, res) => {
  let data = loadData();
  const today = getTodayStr();

  // Reset today count if new day
  if (data.date !== today) {
    data.today = 0;
    data.date = today;
  }

  // Track online session
  const ip = getClientIp(req);
  const alreadyOnline = onlineSessions.has(ip);
  onlineSessions.set(ip, Date.now());

  // Only count as new visit if not already tracked this session
  // Frontend sends ?new=1 only once per browser session
  if (req.query.new === '1') {
    data.total += 1;
    data.today += 1;
    saveData(data);
  }

  res.json({
    total: data.total,
    today: data.today,
    online: getOnlineCount(),
  });
});

// GET /api/ping — heartbeat to keep session alive (called every 2 mins)
app.get('/api/ping', (req, res) => {
  const ip = getClientIp(req);
  onlineSessions.set(ip, Date.now());
  res.json({ online: getOnlineCount() });
});

// GET /api/stats — just fetch latest stats without incrementing
app.get('/api/stats', (req, res) => {
  let data = loadData();
  const today = getTodayStr();
  if (data.date !== today) {
    data.today = 0;
    data.date = today;
    saveData(data);
  }
  res.json({
    total: data.total,
    today: data.today,
    online: getOnlineCount(),
  });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Genivis Visitor Counter API running on port ${PORT}`);
});
