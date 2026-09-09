const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// In-memory or file-backed storage for device tokens
const TOKENS_FILE = path.join(__dirname, '../data/device-tokens.json');

// Ensure data folder exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading device tokens:', err);
  }
  return {};
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving device tokens:', err);
  }
}

// Optional Firebase Admin SDK initialization
let firebaseAdmin = null;

function findServiceAccountPath() {
  const defaultPath = path.join(__dirname, '../firebase-service-account.json');
  if (fs.existsSync(defaultPath)) return defaultPath;

  try {
    const rootDir = path.join(__dirname, '..');
    const files = fs.readdirSync(rootDir);
    const found = files.find((f) => f.includes('firebase-adminsdk') && f.endsWith('.json'));
    if (found) {
      return path.join(rootDir, found);
    }
  } catch (e) {}

  return null;
}

function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    const admin = require('firebase-admin');
    const { getMessaging } = require('firebase-admin/messaging');
    let serviceAccount = null;

    // 1. Check if provided as environment variable (JSON string or Base64)
    const envServiceAccount =
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env['firebase-service-account'] ||
      process.env.firebase_service_account ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (envServiceAccount) {
      try {
        const raw = envServiceAccount.trim();
        serviceAccount = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        console.log('✅ [FCM] Firebase Admin SDK initialized using environment variable.');
      } catch (e) {
        console.warn('⚠️ [FCM] Failed to parse Firebase service account env variable:', e.message);
      }
    }

    // 2. Fallback to physical local file
    if (!serviceAccount) {
      const serviceAccountPath = findServiceAccountPath();
      if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
        serviceAccount = require(serviceAccountPath);
        console.log(`✅ [FCM] Firebase Admin SDK initialized using: ${path.basename(serviceAccountPath)}`);
      }
    }

    if (serviceAccount) {
      const app = !admin.getApps().length
        ? admin.initializeApp({
            credential: admin.cert(serviceAccount),
          })
        : admin.getApps()[0];

      firebaseAdmin = {
        admin,
        messaging: getMessaging(app),
      };
      return firebaseAdmin;
    } else {
      console.log('ℹ️ [FCM] Place "firebase-service-account.json" in root or set FIREBASE_SERVICE_ACCOUNT env var.');
    }
  } catch (err) {
    console.warn('⚠️ [FCM] Could not initialize Firebase Admin:', err.message);
  }
  return null;
}

/**
 * POST /api/notifications/register-device-token
 * Registers an employee's mobile FCM token
 */
router.post('/register-device-token', (req, res) => {
  try {
    const { employeeId, fcmToken, platform } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ error: 'fcmToken is required' });
    }

    const tokens = loadTokens();
    const key = employeeId || 'anonymous';

    if (!tokens[key]) {
      tokens[key] = [];
    }

    // Keep unique tokens
    const existingIndex = tokens[key].findIndex((t) => (typeof t === 'string' ? t === fcmToken : t.token === fcmToken));
    const tokenEntry = {
      token: fcmToken,
      platform: platform || 'android',
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      tokens[key][existingIndex] = tokenEntry;
    } else {
      tokens[key].push(tokenEntry);
    }

    saveTokens(tokens);
    console.log(`[FCM] Registered token for employee [${key}]: ${fcmToken.slice(0, 15)}...`);

    res.json({ success: true, message: 'Device token registered successfully' });
  } catch (err) {
    console.error('[FCM] Error registering token:', err);
    res.status(500).json({ error: 'Failed to register device token' });
  }
});

/**
 * GET /api/notifications/registered-tokens
 * Lists registered tokens (for debugging & admin verification)
 */
router.get('/registered-tokens', (req, res) => {
  const tokens = loadTokens();
  const summary = Object.keys(tokens).map((empId) => ({
    employeeId: empId,
    tokenCount: tokens[empId].length,
    tokens: tokens[empId],
  }));
  res.json({ count: summary.length, devices: summary });
});

/**
 * POST /api/notifications/send-push
 * Broadcast or direct push notification to devices
 */
router.post('/send-push', async (req, res) => {
  try {
    const { title, body, imageUrl, targetEmployeeId } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    const tokens = loadTokens();
    let recipientTokens = [];

    if (targetEmployeeId) {
      const empTokens = tokens[targetEmployeeId] || [];
      recipientTokens = empTokens.map((t) => (typeof t === 'string' ? t : t.token));
    } else {
      // Broadcast to all registered devices
      Object.values(tokens).forEach((arr) => {
        arr.forEach((t) => {
          recipientTokens.push(typeof t === 'string' ? t : t.token);
        });
      });
    }

    // De-duplicate tokens
    recipientTokens = Array.from(new Set(recipientTokens));

    if (recipientTokens.length === 0) {
      return res.json({
        success: true,
        deliveredCount: 0,
        message: 'No mobile device tokens registered yet. Open the mobile app once to register.',
      });
    }

    const fcm = getFirebaseAdmin();
    if (!fcm) {
      return res.json({
        success: true,
        simulated: true,
        recipientCount: recipientTokens.length,
        message: 'Push queued. Add firebase-service-account.json to swift-backend for live FCM dispatch.',
      });
    }

    // Build FCM payload
    const safeTitle = String(title || 'SWIFT Notification');
    const safeBody = String(body || '');
    const safeImage = imageUrl ? String(imageUrl) : '';

    const message = {
      notification: {
        title: safeTitle,
        body: safeBody,
        ...(safeImage ? { imageUrl: safeImage } : {}),
      },
      data: {
        title: safeTitle,
        body: safeBody,
        ...(safeImage ? { imageUrl: safeImage } : {}),
        timestamp: String(Date.now()),
      },
      tokens: recipientTokens,
    };

    if (safeImage) {
      message.android = {
        notification: {
          imageUrl: safeImage,
        },
      };
    }

    const response = await fcm.messaging.sendEachForMulticast(message);
    console.log(`[FCM] Sent multicast push: ${response.successCount} succeeded, ${response.failureCount} failed.`);

    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.warn(`[FCM] Token failure index ${idx}:`, resp.error?.message);
        }
      });
    }

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (err) {
    console.error('[FCM] Error sending push notification:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
