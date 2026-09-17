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

    // 1. Check if individual variables are set (Recommended for Railway/clean envs)
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      try {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
        serviceAccount = {
          projectId: process.env.FIREBASE_PROJECT_ID.trim(),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL.trim(),
          privateKey: privateKey,
          project_id: process.env.FIREBASE_PROJECT_ID.trim(),
        };
        console.log('✅ [FCM] Firebase service account loaded from individual environment variables.');
      } catch (e) {
        console.warn('⚠️ [FCM] Failed to parse individual Firebase env variables:', e.message);
      }
    }

    // 2. Check if provided as full JSON environment variable (JSON string or Base64)
    if (!serviceAccount) {
      const envServiceAccount =
        process.env.FIREBASE_SERVICE_ACCOUNT ||
        process.env['firebase-service-account'] ||
        process.env.firebase_service_account ||
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

      if (envServiceAccount) {
        try {
          let raw = envServiceAccount.trim();
          if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            raw = raw.slice(1, -1);
          }
          serviceAccount = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
          console.log('✅ [FCM] Firebase service account parsed from JSON environment variable.');
        } catch (e) {
          console.warn('⚠️ [FCM] Failed to parse Firebase service account env variable:', e.message);
        }
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
      // Fix escaped newlines in private_key (crucial when pasted in cloud environment variables)
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }

      const app = !admin.getApps().length
        ? admin.initializeApp({
            credential: admin.cert(serviceAccount),
          })
        : admin.getApps()[0];

      firebaseAdmin = {
        admin,
        messaging: getMessaging(app),
      };
      console.log(`✅ [FCM] Firebase Admin SDK initialized successfully for project: ${serviceAccount.project_id}`);
      return firebaseAdmin;
    } else {
      console.log('ℹ️ [FCM] Place "firebase-service-account.json" in root or set firebase-service-account env var.');
    }
  } catch (err) {
    console.error('⚠️ [FCM] Could not initialize Firebase Admin:', err.message, err.stack);
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

/**
 * Dispatches WhatsApp-style high priority push notification for Team Chat messages
 */
async function sendTeamChatPush({
  tenantId,
  groupId,
  groupSubject,
  senderId,
  senderName,
  text,
  members = [],
}) {
  try {
    if (!groupId || !text) return { success: false, reason: 'Missing groupId or text' };

    const tokens = loadTokens();
    let recipientTokens = [];

    // 1. Identify recipient member IDs (exclude sender)
    const recipientMemberIds = new Set();

    if (Array.isArray(members) && members.length > 0) {
      members.forEach((m) => {
        const mId = typeof m === 'string' ? m : (m.id || m.empCode);
        if (mId && String(mId) !== String(senderId)) {
          recipientMemberIds.add(String(mId));
        }
      });
    }

    // 2. Gather device tokens for recipients
    recipientMemberIds.forEach((empId) => {
      if (tokens[empId] && Array.isArray(tokens[empId])) {
        tokens[empId].forEach((t) => {
          recipientTokens.push(typeof t === 'string' ? t : t.token);
        });
      }
    });

    // Fallback: If only testing or single device registered under mobile_user, and mobile_user is not the sender
    if (recipientTokens.length === 0 && tokens['mobile_user'] && senderId !== 'mobile_user') {
      tokens['mobile_user'].forEach((t) => {
        recipientTokens.push(typeof t === 'string' ? t : t.token);
      });
    }

    // Fallback: If still no tokens but we have registered devices (e.g. multi-user testing on same devices)
    if (recipientTokens.length === 0) {
      Object.keys(tokens).forEach((empKey) => {
        if (String(empKey) !== String(senderId) && Array.isArray(tokens[empKey])) {
          tokens[empKey].forEach((t) => {
            recipientTokens.push(typeof t === 'string' ? t : t.token);
          });
        }
      });
    }

    // De-duplicate tokens
    recipientTokens = Array.from(new Set(recipientTokens)).filter(Boolean);

    if (recipientTokens.length === 0) {
      console.log(`[TeamChat Push] No registered device tokens found for group ${groupId}`);
      return { success: true, deliveredCount: 0, reason: 'No device tokens' };
    }

    const fcm = getFirebaseAdmin();
    if (!fcm) {
      console.warn('[TeamChat Push] Firebase Admin SDK not initialized (check firebase-service-account.json)');
      return { success: false, reason: 'Firebase Admin not initialized' };
    }

    const safeSubject = String(groupSubject || 'Team Chat');
    const safeSender = String(senderName || 'Colleague');
    const safeText = String(text || '').trim();

    // WhatsApp format:
    // Title: Group Subject (e.g., "Engineering Team 🚀")
    // Body: "Sender Name: Message text..."
    const title = safeSubject;
    const body = `${safeSender}: ${safeText}`;

    const message = {
      notification: {
        title,
        body,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'swift_high_importance_channel',
          priority: 'high',
          sound: 'default',
          defaultSound: true,
          defaultVibrateTimings: true,
          tag: String(groupId), // Groups notifications by group like WhatsApp
          visibility: 'public',
          clickAction: 'OPEN_TEAM_CHAT',
        },
      },
      data: {
        type: 'team_chat_message',
        groupId: String(groupId),
        groupSubject: safeSubject,
        senderId: String(senderId || ''),
        senderName: safeSender,
        text: safeText,
        tenantId: String(tenantId || 'swift'),
        timestamp: String(Date.now()),
      },
      tokens: recipientTokens,
    };

    const response = await fcm.messaging.sendEachForMulticast(message);
    console.log(
      `[TeamChat Push] Multicast dispatched for "${safeSubject}": ${response.successCount} succeeded, ${response.failureCount} failed out of ${recipientTokens.length} devices.`
    );

    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error('[TeamChat Push] Error sending push:', err.message);
    return { success: false, error: err.message };
  }
}

router.sendTeamChatPush = sendTeamChatPush;
router.loadTokens = loadTokens;
router.getFirebaseAdmin = getFirebaseAdmin;

module.exports = router;

