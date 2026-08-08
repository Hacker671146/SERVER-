// server.js
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/prediction_db');

// Schemas
const keySchema = new mongoose.Schema({
    keyCode: { type: String, unique: true },
    durationDays: Number,
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

const userSchema = new mongoose.Schema({
    username: String,
    role: { type: String, default: 'user' },
    subscriptionExpiresAt: Date
});

const Key = mongoose.model('Key', keySchema);
const User = mongoose.model('User', userSchema);

// ------------------- ADMIN ROUTES -------------------

// 1. Admin: Generate New Key
app.post('/api/admin/generate-key', async (req, res) => {
    const { days } = req.body; // e.g., 7 days or 30 days
    const randomKey = 'PRED-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const newKey = new Key({
        keyCode: randomKey,
        durationDays: days
    });

    await newKey.save();
    res.json({ success: true, key: randomKey, validity: `${days} Days` });
});

// ------------------- USER ROUTES -------------------

// 2. User: Redeem Key
app.post('/api/user/redeem-key', async (req, res) => {
    const { userId, keyCode } = req.body;

    const key = await Key.findOne({ keyCode, isUsed: false });
    if (!key) {
        return res.status(400).json({ error: 'Invalid or already used key' });
    }

    // Key expiry calculate karo
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + key.durationDays);

    // Key mark as used & update user expiry
    key.isUsed = true;
    key.usedBy = userId;
    await key.save();

    await User.findByIdAndUpdate(userId, { subscriptionExpiresAt: expireDate });

    res.json({ success: true, message: 'Key redeemed successfully!', validUntil: expireDate });
});

// 3. User: Get Prediction (Protected Route)
app.post('/api/user/get-prediction', async (req, res) => {
    const { userId, gameData } = req.body;

    const user = await User.findById(userId);
    if (!user || !user.subscriptionExpiresAt || new Date() > user.subscriptionExpiresAt) {
        return res.status(403).json({ error: 'Active subscription missing or key expired!' });
    }

    // --- PREDICTION ALGORITHM / LOGIC HERE ---
    const result = Math.random() > 0.5 ? 'High' : 'Low'; // Simple logic placeholder

    res.json({
        success: true,
        prediction: result,
        expiresAt: user.subscriptionExpiresAt
    });
});

app.listen(5000, () => console.log('Server running on port 5000'));
