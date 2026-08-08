require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Configs
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/wingo_prediction_db';
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'wingo_secret_key';
const WINGO_API_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

// MongoDB Connection
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ================= MONGOOSE SCHEMAS =================

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  subscriptionExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

// Key Schema
const keySchema = new mongoose.Schema({
  keyCode: { type: String, required: true, unique: true },
  durationDays: { type: Number, required: true },
  isUsed: { type: Boolean, default: false },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

// Fetched Live Game Results Cache
const gameResultSchema = new mongoose.Schema({
  issueNumber: { type: String, required: true, unique: true },
  number: { type: Number, required: true },
  result: { type: String, enum: ['BIG', 'SMALL'], required: true },
  color: { type: String },
  timestamp: { type: Date, default: Date.now }
});

// User Prediction & Win/Loss Tracking Schema
const predictionLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  issueNumber: { type: String, required: true },
  predictedResult: { type: String, enum: ['BIG', 'SMALL'], required: true },
  confidence: { type: String },
  actualResult: { type: String, enum: ['BIG', 'SMALL'], default: null },
  status: { type: String, enum: ['PENDING', 'WIN', 'LOSS'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Key = mongoose.model('Key', keySchema);
const GameResult = mongoose.model('GameResult', gameResultSchema);
const PredictionLog = mongoose.model('PredictionLog', predictionLogSchema);

// ================= ADVANCED AI PATTERN PREDICTION ENGINE =================

/**
 * Historical array of results analyze karke next prediction decision deta hai
 * @param {Array<string>} historyArray - e.g. ['BIG', 'BIG', 'SMALL', 'BIG', ...]
 */
function analyzePatternAndPredict(historyArray) {
  if (!historyArray || historyArray.length < 5) {
    const fallback = Math.random() > 0.5 ? 'BIG' : 'SMALL';
    return { prediction: fallback, confidence: '55%', patternFound: 'Baseline Random' };
  }

  const recent = historyArray.slice(0, 20); // Last 20 outcomes
  const lastResult = recent[0];

  // 1. Streak / Dragon Pattern Detection
  let streak = 0;
  for (let res of recent) {
    if (res === lastResult) streak++;
    else break;
  }

  // 2. Single Jump Pattern (B-S-B-S)
  let isAlternating = true;
  for (let i = 0; i < Math.min(6, recent.length - 1); i++) {
    if (recent[i] === recent[i + 1]) {
      isAlternating = false;
      break;
    }
  }

  // 3. Double Jump Pattern (B-B-S-S)
  let isDoubleJump = false;
  if (recent.length >= 6) {
    if (recent[0] === recent[1] && recent[2] === recent[3] && recent[0] !== recent[2]) {
      isDoubleJump = true;
    }
  }

  // 4. Frequency Ratio Analysis
  const bigCount = recent.filter(r => r === 'BIG').length;
  const smallCount = recent.length - bigCount;

  let predictedOutcome = 'BIG';
  let confidenceScore = 65;
  let patternName = 'Trend Following';

  if (streak >= 4) {
    // Mean Reversion (Dragon Break Risk) or Dragon Continuation
    if (streak >= 6) {
      predictedOutcome = lastResult === 'BIG' ? 'SMALL' : 'BIG'; // Break dragon
      confidenceScore = 82;
      patternName = `Dragon Reversion (${streak}x ${lastResult})`;
    } else {
      predictedOutcome = lastResult; // Continue dragon
      confidenceScore = 78;
      patternName = `Dragon Streak Continuation (${streak}x ${lastResult})`;
    }
  } else if (isAlternating) {
    predictedOutcome = lastResult === 'BIG' ? 'SMALL' : 'BIG';
    confidenceScore = 80;
    patternName = 'Single-Jump Alternating Pattern (B-S-B-S)';
  } else if (isDoubleJump) {
    predictedOutcome = recent[0] === recent[1] ? (recent[0] === 'BIG' ? 'SMALL' : 'BIG') : recent[0];
    confidenceScore = 75;
    patternName = 'Double-Jump Pattern (B-B-S-S)';
  } else {
    // Frequency Reversion
    predictedOutcome = bigCount > smallCount ? 'SMALL' : 'BIG';
    confidenceScore = 60 + Math.abs(bigCount - smallCount) * 3;
    patternName = 'Frequency Balance Reversion';
  }

  return {
    prediction: predictedOutcome,
    confidence: `${Math.min(92, confidenceScore)}%`,
    patternFound: patternName
  };
}

// ================= LIVE API SYNC & AUTO WIN/LOSS WORKER =================

async function syncLiveResultsAndEvaluatePending() {
  try {
    const response = await axios.get(`${WINGO_API_URL}?ts=${Date.now()}`, { timeout: 8000 });
    
    // Support multiple standard JSON structures from WinGo APIs
    let list = [];
    if (response.data && response.data.data && Array.isArray(response.data.data.list)) {
      list = response.data.data.list;
    } else if (response.data && Array.isArray(response.data.list)) {
      list = response.data.list;
    } else if (Array.isArray(response.data)) {
      list = response.data;
    }

    if (!list || list.length === 0) return;

    // 1. Save results to Database
    for (let item of list) {
      const issueNo = String(item.issueNumber || item.issue || item.period);
      const num = parseInt(item.number !== undefined ? item.number : item.resultNum);
      if (!issueNo || isNaN(num)) continue;

      const bigOrSmall = num >= 5 ? 'BIG' : 'SMALL';

      await GameResult.updateOne(
        { issueNumber: issueNo },
        { 
          issueNumber: issueNo,
          number: num,
          result: bigOrSmall,
          color: item.color || ''
        },
        { upsert: true }
      );

      // 2. Auto Evaluate Pending Predictions for this Period
      const pendingLogs = await PredictionLog.find({ issueNumber: issueNo, status: 'PENDING' });
      for (let log of pendingLogs) {
        const isWin = log.predictedResult === bigOrSmall;
        log.actualResult = bigOrSmall;
        log.status = isWin ? 'WIN' : 'LOSS';
        await log.save();
      }
    }
  } catch (error) {
    console.error('⚠️ Live API Sync Error:', error.message);
  }
}

// Auto-run Live Sync every 10 seconds
setInterval(syncLiveResultsAndEvaluatePending, 10000);

// ================= AUTH MIDDLEWARE =================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, error: 'Access token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// ================= API ENDPOINTS =================

// 1. Auth: Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Missing username/password' });

    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ success: false, error: 'Username taken' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, role: role || 'user' });
    await user.save();

    res.status(201).json({ success: true, message: 'User registered' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Auth: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        subscriptionExpiresAt: user.subscriptionExpiresAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Admin: Generate Key
app.post('/api/admin/generate-key', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Admin only' });

    const days = parseInt(req.body.days) || 7;
    const keyCode = 'WINGO-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const newKey = new Key({ keyCode, durationDays: days });
    await newKey.save();

    res.json({ success: true, keyCode, durationDays: days });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. User: Redeem Key
app.post('/api/user/redeem-key', authenticateToken, async (req, res) => {
  try {
    const { keyCode } = req.body;
    const key = await Key.findOne({ keyCode, isUsed: false });

    if (!key) return res.status(400).json({ success: false, error: 'Invalid/Used Key' });

    const user = await User.findById(req.user.userId);
    let baseDate = new Date();
    if (user.subscriptionExpiresAt && user.subscriptionExpiresAt > new Date()) {
      baseDate = new Date(user.subscriptionExpiresAt);
    }
    baseDate.setDate(baseDate.getDate() + key.durationDays);

    key.isUsed = true;
    key.usedBy = user._id;
    await key.save();

    user.subscriptionExpiresAt = baseDate;
    await user.save();

    res.json({ success: true, message: 'Key redeemed', expiresAt: baseDate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. User: Get Prediction for Next Period
app.post('/api/user/get-prediction', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || !user.subscriptionExpiresAt || new Date() > user.subscriptionExpiresAt) {
      return res.status(403).json({ success: false, error: 'Key expired or subscription required' });
    }

    // Trigger immediate live fetch sync
    await syncLiveResultsAndEvaluatePending();

    // Fetch latest 30 results from Database
    const history = await GameResult.find().sort({ issueNumber: -1 }).limit(30);

    if (history.length === 0) {
      return res.status(500).json({ success: false, error: 'Waiting for live game data...' });
    }

    const latestIssue = history[0].issueNumber;
    
    // Calculate Next Period Issue Number (Increment by 1)
    const nextIssue = (BigInt(latestIssue) + 1n).toString();

    // Run AI Pattern Analysis
    const historyArray = history.map(h => h.result);
    const aiAnalysis = analyzePatternAndPredict(historyArray);

    // Check if user already generated prediction for this next issue
    let log = await PredictionLog.findOne({ userId: user._id, issueNumber: nextIssue });

    if (!log) {
      log = new PredictionLog({
        userId: user._id,
        issueNumber: nextIssue,
        predictedResult: aiAnalysis.prediction,
        confidence: aiAnalysis.confidence,
        status: 'PENDING'
      });
      await log.save();
    }

    res.json({
      success: true,
      data: {
        lastCompletedIssue: latestIssue,
        lastNumber: history[0].number,
        lastResult: history[0].result,
        nextIssueNumber: nextIssue,
        predictedResult: log.predictedResult,
        confidence: log.confidence,
        patternDetected: aiAnalysis.patternFound,
        status: log.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. User: Get Prediction History with WIN / LOSS Stats
app.get('/api/user/history', authenticateToken, async (req, res) => {
  try {
    const logs = await PredictionLog.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(20);

    const total = logs.length;
    const wins = logs.filter(l => l.status === 'WIN').length;
    const losses = logs.filter(l => l.status === 'LOSS').length;
    const winRate = total > 0 ? `${Math.round((wins / (wins + losses || 1)) * 100)}%` : '0%';

    res.json({
      success: true,
      stats: { totalPredictions: total, wins, losses, winRate },
      history: logs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Root Route
app.get('/', (req, res) => {
  res.json({ status: 'Online', engine: 'WinGo 1Min AI Prediction Backend' });
});

app.listen(PORT, () => {
  console.log(`🚀 WinGo Prediction Server active on port ${PORT}`);
  // Initial Sync on startup
  syncLiveResultsAndEvaluatePending();
});
