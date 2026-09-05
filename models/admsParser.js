/**
 * Universal ADMS / iClock Protocol Parser for BioMax, eSSL, and ZKTeco Biometric Devices.
 * Supports ATTLOG, OPERLOG, and Key-Value text push payloads.
 */

// Punch state mapping from ADMS state codes
const PUNCH_STATE_MAP = {
  "0": "CHECK_IN",
  "1": "CHECK_OUT",
  "2": "BREAK_OUT",
  "3": "BREAK_IN",
  "4": "OVERTIME_IN",
  "5": "OVERTIME_OUT",
  "I": "CHECK_IN",
  "O": "CHECK_OUT",
  "255": "AUTO",
};

// Verification type mapping from ADMS verify codes
const VERIFY_TYPE_MAP = {
  "1": "FINGERPRINT",
  "2": "PIN_PASSWORD",
  "3": "CARD_RFID",
  "4": "FINGER_CARD",
  "15": "FACE_RECOGNITION",
  "200": "PALM_VEIN",
};

/**
 * Extracts the Device Serial Number (SN) from any location in an incoming HTTP request
 * @param {object} req - Express request object
 * @returns {string} Serial Number or "UNKNOWN"
 */
function extractDeviceSN(req) {
  if (!req) return "UNKNOWN";

  // 1. Query parameters
  const querySN =
    req.query?.SN ||
    req.query?.sn ||
    req.query?.SerialNumber ||
    req.query?.serialNumber ||
    req.query?.serialno ||
    req.query?.deviceId ||
    req.query?.sn_id;
  if (querySN) return String(querySN).trim();

  // 2. HTTP Headers
  const headerSN =
    req.headers?.["x-serial-number"] ||
    req.headers?.["sn"] ||
    req.headers?.["serialnumber"] ||
    req.headers?.["device-sn"] ||
    req.headers?.["x-sn"];
  if (headerSN) return String(headerSN).trim();

  // 3. Parsed JSON / URL-encoded body
  if (req.body && typeof req.body === "object") {
    const bodySN = req.body.SN || req.body.sn || req.body.SerialNumber || req.body.serialNumber;
    if (bodySN) return String(bodySN).trim();
  }

  // 4. Raw text string body search (e.g., "SN=NFZ8235301513\t..." or "~SerialNumber=...")
  if (typeof req.body === "string") {
    const match = req.body.match(/(?:SN|sn|SerialNumber|~SerialNumber|serialNumber)=([^\s&,\r\n]+)/i);
    if (match && match[1]) return match[1].trim();
  }

  return "UNKNOWN";
}

/**
 * Parses raw text push payload from BioMax / eSSL / iclock device POST request.
 * Expected format for ATTLOG lines:
 * <USER_ID>\t<TIMESTAMP>\t<STATE>\t<VERIFY_TYPE>\t<WORK_CODE>\t<RESERVED>
 * Example: "1001\t2026-08-27 08:30:00\t0\t1\t0\t0\t0"
 * Or Key-Value format: "USERID=1001\tCHECKTIME=2026-08-27 08:30:00\tCHECKTYPE=I\tVERIFYCODE=1"
 *
 * @param {string} rawBody - Raw body received from HTTP request
 * @returns {Array<object>} Array of parsed punch records
 */
function parseAdmsPayload(rawBody) {
  if (!rawBody || typeof rawBody !== "string") {
    return [];
  }

  const lines = rawBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const records = [];

  for (const line of lines) {
    // Skip command header lines or non-punch entries
    if (line.startsWith("OPERLOG") || line.startsWith("USER ") || line.startsWith("FP ") || line.startsWith("CMD")) {
      continue;
    }

    // Check if key-value line
    if (line.includes("USERID=") || line.includes("CHECKTIME=")) {
      const parsedKV = parseKeyValueLine(line);
      if (parsedKV) records.push(parsedKV);
      continue;
    }

    // Standard tab or space delimited format
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/);

    if (parts.length >= 2) {
      const employeeId = parts[0]?.trim();

      // Look for timestamp (YYYY-MM-DD HH:mm:ss)
      let timestampStr = "";
      let stateCode = "0";
      let verifyCode = "1";

      if (parts[1] && parts[2] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
        // Space separated date and time in parts[1] and parts[2]
        timestampStr = `${parts[1]} ${parts[2]}`;
        stateCode = parts[3] || "0";
        verifyCode = parts[4] || "1";
      } else {
        timestampStr = parts[1]?.trim();
        stateCode = parts[2]?.trim() || "0";
        verifyCode = parts[3]?.trim() || "1";
      }

      const dateObj = new Date(timestampStr.replace(/-/g, "/"));
      const validDate = !isNaN(dateObj.getTime()) ? dateObj : new Date();

      if (employeeId) {
        records.push({
          employeeId,
          timestamp: validDate,
          state: PUNCH_STATE_MAP[stateCode] || stateCode || "CHECK_IN",
          punchType: VERIFY_TYPE_MAP[verifyCode] || "FINGERPRINT",
          rawLine: line,
        });
      }
    }
  }

  return records;
}

/**
 * Parses Key-Value pair lines
 * Example: USERID=101\tCHECKTIME=2026-08-27 08:30:00\tCHECKTYPE=0\tVERIFYCODE=1
 */
function parseKeyValueLine(line) {
  const parts = line.split(/[\t&]/);
  const data = {};

  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) {
      data[k.trim().toUpperCase()] = v.trim();
    }
  }

  const employeeId = data.USERID || data.PIN || data.CARDNO;
  const timeStr = data.CHECKTIME || data.TIME;

  if (!employeeId || !timeStr) return null;

  const dateObj = new Date(timeStr.replace(/-/g, "/"));
  const validDate = !isNaN(dateObj.getTime()) ? dateObj : new Date();
  const stateCode = data.CHECKTYPE || data.STATUS || "0";
  const verifyCode = data.VERIFYCODE || data.VERIFY || "1";

  return {
    employeeId,
    timestamp: validDate,
    state: PUNCH_STATE_MAP[stateCode] || stateCode || "CHECK_IN",
    punchType: VERIFY_TYPE_MAP[verifyCode] || "FINGERPRINT",
    rawLine: line,
  };
}

module.exports = {
  PUNCH_STATE_MAP,
  VERIFY_TYPE_MAP,
  extractDeviceSN,
  parseAdmsPayload,
  parseKeyValueLine,
};
