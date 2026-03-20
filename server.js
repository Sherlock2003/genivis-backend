const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3001;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://genivisadmin:QrbFpD9H4KOW8Usy@genivis.gm5lqdg.mongodb.net/?appName=genivis';
const DB_NAME = 'genivis';

// ── CORS ──────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── MongoDB Connection ────────────────────────────────────
let db;
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ Connected to MongoDB Atlas');

    // Initialize counters doc if not exists
    const counters = db.collection('counters');
    const existing = await counters.findOne({ _id: 'main' });
    if (!existing) {
      await counters.insertOne({
        _id: 'main',
        total: 0,
        today: 0,
        date: getTodayStr(),
      });
      console.log('✅ Initialized counters in MongoDB');
    }
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────

// IST = UTC + 5:30
function getISTDate() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5h 30min in ms
  return new Date(now.getTime() + istOffset);
}

function getTodayStr() {
  return getISTDate().toISOString().slice(0, 10);
}

function getISTTimeStr() {
  const ist = getISTDate();
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function getISTHour() {
  return getISTDate().getUTCHours();
}

function getISTHourKey() {
  return getISTDate().toISOString().slice(0, 13); // "2025-03-19T14"
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

// ── Load / Save Counters ──────────────────────────────────
async function loadCounters() {
  const counters = db.collection('counters');
  let doc = await counters.findOne({ _id: 'main' });
  const today = getTodayStr();
  if (!doc) {
    doc = { _id: 'main', total: 0, today: 0, date: today };
    await counters.insertOne(doc);
  }
  // Reset today if new day
  if (doc.date !== today) {
    await counters.updateOne({ _id: 'main' }, { $set: { today: 0, date: today } });
    doc.today = 0;
    doc.date = today;
  }
  return doc;
}

async function logVisit(req) {
  const today = getTodayStr();
  const now = new Date();
  const hour = getISTHour();
  const timeStr = getISTTimeStr();
  const hourKey = getISTHourKey();

  // Log individual visit
  await db.collection('visits').insertOne({
    timestamp: now,
    date: today,
    time: timeStr,         // IST time e.g. "11:35:22"
    hour,                  // IST hour e.g. 11
    timezone: 'IST',
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
    device: getDevice(req.headers['user-agent'] || ''),
  });

  // Update daily stats (IST date)
  await db.collection('daily').updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true }
  );

  // Update hourly stats (IST hour key)
  await db.collection('hourly').updateOne(
    { hour: hourKey },
    { $inc: { count: 1 }, $set: { date: today, hourNum: hour } },
    { upsert: true }
  );
}

// ── ROUTES ───────────────────────────────────────────────

// Visit
app.get('/api/visit', async (req, res) => {
  try {
    const doc = await loadCounters();
    const sid = req.query.sid || 'unknown';
    onlineSessions.set(sid, Date.now());

    if (req.query.new === '1') {
      await db.collection('counters').updateOne(
        { _id: 'main' },
        { $inc: { total: 1, today: 1 } }
      );
      await logVisit(req);
      doc.total += 1;
      doc.today += 1;
    }

    res.json({ total: doc.total, today: doc.today, online: getOnlineCount() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Ping
app.get('/api/ping', (req, res) => {
  const sid = req.query.sid || 'unknown';
  onlineSessions.set(sid, Date.now());
  res.json({ online: getOnlineCount() });
});

// Leave
app.post('/api/leave', (req, res) => {
  const sid = req.query.sid || req.body?.sid || 'unknown';
  onlineSessions.delete(sid);
  res.json({ online: getOnlineCount() });
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const doc = await loadCounters();
    res.json({ total: doc.total, today: doc.today, online: getOnlineCount() });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reports
app.get('/api/reports', async (req, res) => {
  try {
    const { from, to, password } = req.query;
    const ADMIN_PW = process.env.ADMIN_PASSWORD || 'genivis@admin123';
    if (password !== ADMIN_PW) return res.status(401).json({ error: 'Unauthorized' });

    const doc = await loadCounters();

    // Build date filter
    const dateFilter = {};
    if (from) dateFilter.$gte = from;
    if (to) dateFilter.$lte = to;
    const hasFilter = Object.keys(dateFilter).length > 0;

    // Daily stats
    const dailyDocs = await db.collection('daily')
      .find(hasFilter ? { date: dateFilter } : {})
      .sort({ date: 1 }).toArray();
    const daily = {};
    dailyDocs.forEach(d => { daily[d.date] = d.count; });

    // Hourly stats
    const hourlyDocs = await db.collection('hourly')
      .find(hasFilter ? { date: dateFilter } : {})
      .sort({ hour: 1 }).toArray();
    const hourly = {};
    hourlyDocs.forEach(h => { hourly[h.hour] = h.count; });

    // Visits
    const visitFilter = hasFilter ? { date: dateFilter } : {};
    const visits = await db.collection('visits')
      .find(visitFilter)
      .sort({ timestamp: -1 })
      .limit(50).toArray();

    // All visits for stats
    const allVisits = await db.collection('visits')
      .find(visitFilter).toArray();

    // Device breakdown
    const devices = { Desktop: 0, Mobile: 0, Tablet: 0 };
    allVisits.forEach(v => { if (devices[v.device] !== undefined) devices[v.device]++; });

    // Hour counts
    const hourCounts = {};
    allVisits.forEach(v => { hourCounts[v.hour] = (hourCounts[v.hour] || 0) + 1; });

    res.json({
      summary: {
        total: doc.total,
        today: doc.today,
        online: getOnlineCount(),
        periodTotal: allVisits.length,
      },
      daily, hourly, hourCounts, devices,
      recentVisits: visits.map(v => ({
        date: v.date,
        time: v.time,
        hour: v.hour,
        device: v.device,
        ip: v.ip,
        userAgent: v.userAgent,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset
app.post('/api/reset', async (req, res) => {
  try {
    const password  = req.body?.password  || req.query?.password;
    const resetType = req.body?.resetType || req.query?.resetType;

    console.log('RESET — type:', resetType);

    const ADMIN_PW = process.env.ADMIN_PASSWORD || 'genivis@admin123';
    if (!password || password !== ADMIN_PW) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = getTodayStr();

    if (resetType === 'all') {
      await db.collection('counters').updateOne(
        { _id: 'main' },
        { $set: { total: 0, today: 0, date: today } }
      );
      await db.collection('visits').deleteMany({});
      await db.collection('daily').deleteMany({});
      await db.collection('hourly').deleteMany({});
      onlineSessions.clear();
      return res.json({ success: true, message: 'All counters and logs reset to zero.' });
    }

    if (resetType === 'today') {
      await db.collection('counters').updateOne(
        { _id: 'main' },
        { $set: { today: 0, date: today } }
      );
      await db.collection('visits').deleteMany({ date: today });
      await db.collection('daily').deleteMany({ date: today });
      await db.collection('hourly').deleteMany({ date: today });
      return res.json({ success: true, message: "Today's count reset to zero." });
    }

    if (resetType === 'total') {
      await db.collection('counters').updateOne(
        { _id: 'main' },
        { $set: { total: 0 } }
      );
      return res.json({ success: true, message: 'Total visitors reset to zero.' });
    }

    return res.status(400).json({ error: `Invalid resetType "${resetType}". Use: all, today, total` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Start ─────────────────────────────────────────────────
setInterval(cleanSessions, 30 * 1000);
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Genivis API running on port ${PORT}`);
  });
});