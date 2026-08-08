require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/prediction_db';
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully'))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

// ================= SCHEMA DEFINITIONS =================

// 1. Key Schema
const keySchema = new mongoose.Schema({
  keyCode: { type: String, required: true, unique: true },
  durationDays: { type: Number, required: true },
  isUsed: { type: Boolean, default: false },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

// 2. User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  subscriptionExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

// 3. Prediction Log Schema
const logSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  prediction: { type: String, required: true },
  confidence: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const Key = mongoose.model('Key', keySchema);
const User = mongoose.model('User', userSchema);
const PredictionLog = mongoose.model('PredictionLog', logSchema);

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

// ================= AUTHENTICATION ROUTES =================

// Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, role: role || 'user' });
    await user.save();

    res.status(201).json({ success: true, message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Login User / Admin
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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= ADMIN PANEL ROUTES =================

// Generate Key (Admin Only)
app.post('/api/admin/generate-key', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { days } = req.body;
    const duration = parseInt(days) || 7;
    const randomKey = 'PRED-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const newKey = new Key({
      keyCode: randomKey,
      durationDays: duration
    });

    await newKey.save();
    res.json({ success: true, keyCode: randomKey, validity: `${duration} Days` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get All Keys (Admin Only)
app.get('/api/admin/keys', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const keys = await Key.find().populate('usedBy', 'username').sort({ createdAt: -1 });
    res.json({ success: true, keys });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= USER PANEL ROUTES =================

// Redeem Key
app.post('/api/user/redeem-key', authenticateToken, async (req, res) => {
  try {
    const { keyCode } = req.body;
    const userId = req.user.userId;

    const key = await Key.findOne({ keyCode, isUsed: false });
    if (!key) {
      return res.status(400).json({ success: false, error: 'Invalid or already redeemed key' });
    }

    const currentUser = await User.findById(userId);
    let baseDate = new Date();

    // Extension agar pehle se active key hai
    if (currentUser.subscriptionExpiresAt && currentUser.subscriptionExpiresAt > new Date()) {
      baseDate = new Date(currentUser.subscriptionExpiresAt);
    }

    baseDate.setDate(baseDate.getDate() + key.durationDays);

    key.isUsed = true;
    key.usedBy = userId;
    await key.save();

    currentUser.subscriptionExpiresAt = baseDate;
    await currentUser.save();

    res.json({
      success: true,
      message: 'Key redeemed successfully',
      expiresAt: baseDate
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Prediction Logic API
app.post('/api/user/get-prediction', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId);

    if (!user || !user.subscriptionExpiresAt || new Date() > user.subscriptionExpiresAt) {
      return res.status(403).json({ success: false, error: 'Active subscription required or key expired' });
    }

    // Prediction Analysis Algorithm
    const { historyLogs } = req.body;
    let predictionResult = 'BIG';
    let confidence = '65%';

    if (Array.isArray(historyLogs) && historyLogs.length > 0) {
      const bigCount = historyLogs.filter(item => String(item).toUpperCase() === 'BIG').length;
      const smallCount = historyLogs.length - bigCount;

      predictionResult = bigCount >= smallCount ? 'SMALL' : 'BIG'; // Reversion pattern strategy
      confidence = `${Math.min(85, 55 + Math.abs(bigCount - smallCount) * 5)}%`;
    } else {
      predictionResult = Math.random() > 0.5 ? 'BIG' : 'SMALL';
    }

    // Save Prediction Log
    const newLog = new PredictionLog({
      userId: user._id,
      prediction: predictionResult,
      confidence
    });
    await newLog.save();

    res.json({
      success: true,
      prediction: predictionResult,
      confidence,
      validUntil: user.subscriptionExpiresAt
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Root Route
app.get('/', (req, res) => {
  res.json({ status: 'Online', server: 'Prediction Backend API Node.js' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Prediction Server running on port ${PORT}`);
});
