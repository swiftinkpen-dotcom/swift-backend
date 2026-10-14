const crypto = require("crypto");

/**
 * Universal Biometric USB File Parser & Stream Sanitation Utility
 * Supports arbitrary device vendors: eSSL, ZKTeco, BioMax, Realtime, Mantra, Matrix
 */

const DATE_REGEX = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/;
const TIME_REGEX = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?\b/;
const HEADER_KEYWORD_REGEX = /^(?:no|id|userid|badgenumber|timestamp|cardno|card_id|datetime|date|time|sn|serial|status|state|device)\b/i;

/**
 * Sanitizes raw string or buffer into clean lines
 */
function sanitizeLines(rawInput) {
  let text = typeof rawInput === "string" ? rawInput : Buffer.from(rawInput).toString("utf8");

  // 1. Strip UTF-8 Byte Order Mark (BOM)
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // 2. Strip NULL bytes (\x00) and Unicode replacement chars
  text = text.replace(/[\x00\uFFFD]/g, "");

  // 3. Normalize newlines to \n and split
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Automatically detects the most likely delimiter from sample lines
 */
function detectDelimiter(lines) {
  const sample = lines.slice(0, 25).filter((l) => !HEADER_KEYWORD_REGEX.test(l));
  if (sample.length === 0) return /\s+/;

  const candidates = [
    { type: "tab", delim: "\t", score: 0 },
    { type: "comma", delim: ",", score: 0 },
    { type: "semicolon", delim: ";", score: 0 },
    { type: "multi-space", delim: /\s{2,}/, score: 0 },
  ];

  for (const line of sample) {
    for (const cand of candidates) {
      const parts = line.split(cand.delim);
      if (parts.length >= 2) {
        cand.score += parts.length;
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0].score > 0) {
    return candidates[0].delim;
  }

  return /\s+/;
}

/**
 * Analyzes sample lines across the file to deterministically identify the date format:
 * 'YYYY-MM-DD', 'DD-MM-YYYY' (Day first), or 'MM-DD-YYYY' (Month first)
 */
function detectFileDateFormat(lines) {
  let maxPart1 = 0;
  let maxPart2 = 0;
  const part1Counts = new Map();
  const part2Counts = new Map();

  for (const line of lines) {
    const match = line.match(DATE_REGEX);
    if (!match) continue;
    const clean = match[0].replace(/[/.]/g, "-");
    const parts = clean.split("-");

    if (parts[0].length === 4) {
      return "YYYY-MM-DD";
    }

    if (parts[2] && parts[2].length === 4) {
      const p1 = parseInt(parts[0], 10);
      const p2 = parseInt(parts[1], 10);
      if (!isNaN(p1) && !isNaN(p2)) {
        if (p1 > maxPart1) maxPart1 = p1;
        if (p2 > maxPart2) maxPart2 = p2;
        part1Counts.set(p1, (part1Counts.get(p1) || 0) + 1);
        part2Counts.set(p2, (part2Counts.get(p2) || 0) + 1);
      }
    }
  }

  // If any date has day > 12 in first position (e.g. 13-09-2026), it MUST be DD-MM-YYYY
  if (maxPart1 > 12) {
    return "DD-MM-YYYY";
  }

  // If any date has day > 12 in second position (e.g. 09-13-2026), it MUST be MM-DD-YYYY
  if (maxPart2 > 12) {
    return "MM-DD-YYYY";
  }

  // If neither exceeded 12 (e.g. only 1st-10th of month), the MONTH is constant while DAY varies!
  if (part1Counts.size > 0 && part2Counts.size > 0) {
    if (part1Counts.size < part2Counts.size) {
      return "MM-DD-YYYY"; // Part 1 was constant month (e.g. 09)
    } else if (part2Counts.size < part1Counts.size) {
      return "DD-MM-YYYY"; // Part 2 was constant month (e.g. 09)
    }
  }

  return "DD-MM-YYYY"; // Standard Indian/UK biometric format fallback
}

/**
 * Converts varying date formats and time strings into a standardized ISO 8601 string
 */
function normalizeToIso(dateStr, timeStr, preferredFormat = "DD-MM-YYYY") {
  try {
    const cleanDate = dateStr.replace(/[/.]/g, "-");
    const dateParts = cleanDate.split("-");
    let year, month, day;

    if (dateParts[0].length === 4) {
      // YYYY-MM-DD
      year = parseInt(dateParts[0], 10);
      month = parseInt(dateParts[1], 10);
      day = parseInt(dateParts[2], 10);
    } else if (dateParts[2]?.length === 4) {
      const part1 = parseInt(dateParts[0], 10);
      const part2 = parseInt(dateParts[1], 10);
      year = parseInt(dateParts[2], 10);

      if (part1 > 12 && part2 <= 12) {
        day = part1;
        month = part2;
      } else if (part2 > 12 && part1 <= 12) {
        month = part1;
        day = part2;
      } else if (preferredFormat === "MM-DD-YYYY") {
        month = part1;
        day = part2;
      } else {
        day = part1;
        month = part2;
      }
    } else {
      return null;
    }

    // Time normalization
    let cleanTime = timeStr.trim();
    let isPM = false;
    let isAM = false;

    if (/[AaPp][Mm]$/i.test(cleanTime)) {
      isPM = /[Pp][Mm]$/i.test(cleanTime);
      isAM = /[Aa][Mm]$/i.test(cleanTime);
      cleanTime = cleanTime.replace(/[AaPp][Mm]/gi, "").trim();
    }

    const timeParts = cleanTime.split(":");
    let hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1] || "0", 10);
    const seconds = parseInt(timeParts[2] || "0", 10);

    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const pad = (n) => String(n).padStart(2, "0");
    const isoString = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.000Z`;
    const parsedDate = new Date(isoString);

    if (isNaN(parsedDate.getTime())) return null;

    return {
      isoString,
      dateOnly: `${year}-${pad(month)}-${pad(day)}`,
      timeOnly: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
      timestampMs: parsedDate.getTime(),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Checks if a line is a pure column header row
 */
function isPureHeader(line) {
  // If line contains a valid date or time, it cannot be a pure header
  if (DATE_REGEX.test(line) || TIME_REGEX.test(line)) {
    return false;
  }
  return /^(?:no|id|userid|user\s*id|badgenumber|timestamp|cardno|card_id|datetime|date|time|sn|serial|status|state|device|emp\s*id|employee\s*id)\b/i.test(
    line.trim()
  );
}

/**
 * Extracts biometric code, date, and time from a single line
 */
function extractFromLine(line, delimiter, preferredFormat = "DD-MM-YYYY") {
  if (isPureHeader(line)) {
    return null;
  }

  const dateMatch = line.match(DATE_REGEX);
  const timeMatch = line.match(TIME_REGEX);
  if (!dateMatch || !timeMatch) return null;

  const rawDateStr = dateMatch[0];
  const rawTimeStr = timeMatch[0];

  let biometricCode = "";

  // 1. Check for labeled patterns like 'ID: 104', 'Emp: 104', 'Pin: 104'
  const labeledMatch = line.match(/\b(?:id|emp|pin|userid|user|no|code)[\s:=]+([A-Za-z0-9_-]+)\b/i);
  if (labeledMatch && labeledMatch[1]) {
    biometricCode = labeledMatch[1];
  }

  // 2. Tokenize using delimiter
  if (!biometricCode) {
    const tokens = line
      .split(delimiter)
      .map((t) => t.replace(/["':]/g, "").trim())
      .filter(Boolean);

    for (const token of tokens) {
      if (
        !DATE_REGEX.test(token) &&
        !TIME_REGEX.test(token) &&
        /^[A-Za-z0-9_-]+$/.test(token) &&
        !isPureHeader(token)
      ) {
        biometricCode = token;
        break;
      }
    }
  }

  // 3. Fallback: match alphanumeric before date
  if (!biometricCode) {
    const beforeDate = line.substring(0, line.indexOf(rawDateStr)).trim();
    const subMatch = beforeDate.match(/[A-Za-z0-9_-]+/);
    if (subMatch) biometricCode = subMatch[0];
  }

  if (!biometricCode) return null;

  const normalized = normalizeToIso(rawDateStr, rawTimeStr, preferredFormat);
  if (!normalized) return null;

  return {
    biometricCode: String(biometricCode).trim(),
    timestamp: normalized.isoString,
    dateOnly: normalized.dateOnly,
    timeOnly: normalized.timeOnly,
    timestampMs: normalized.timestampMs,
    rawLine: line,
  };
}

/**
 * Parses raw file content handling both single-line and two-line split formats
 */
function parseUniversalFile(rawContent) {
  const lines = sanitizeLines(rawContent);
  if (lines.length === 0) {
    return {
      success: false,
      error: "Uploaded file is empty or contains no readable lines",
      punches: [],
    };
  }

  const delimiter = detectDelimiter(lines);
  const dateFormat = detectFileDateFormat(lines);
  const punches = [];
  let skippedHeaderCount = 0;
  let malformedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const nxt = lines[i + 1] || "";

    // Check if line is a header
    if (isPureHeader(cur)) {
      skippedHeaderCount++;
      continue;
    }

    // Two-line format detection:
    // Line i contains biometric code and date, line i+1 contains time
    const curHasDate = DATE_REGEX.test(cur);
    const curHasTime = TIME_REGEX.test(cur);
    const nxtHasTime = TIME_REGEX.test(nxt);

    if (curHasDate && !curHasTime && nxtHasTime && !DATE_REGEX.test(nxt)) {
      const mergedLine = `${cur} ${nxt}`;
      const record = extractFromLine(mergedLine, delimiter, dateFormat);
      if (record) {
        punches.push(record);
        i++; // skip next line because it was consumed
        continue;
      }
    }

    // Standard Single-Line parsing
    const record = extractFromLine(cur, delimiter, dateFormat);
    if (record) {
      punches.push(record);
    } else {
      malformedCount++;
    }
  }

  return {
    success: punches.length > 0,
    totalLines: lines.length,
    validPunchesCount: punches.length,
    skippedHeaderCount,
    malformedCount,
    delimiterDetected: typeof delimiter === "string" ? delimiter : "regex-space",
    dateFormatDetected: dateFormat,
    punches,
  };
}

/**
 * Multi-layer Deduplication:
 * Applies a 60-second sliding debounce filter per employee to drop double-swipes
 */
function applyDebounceFilter(punches, windowSeconds = 60) {
  const windowMs = windowSeconds * 1000;
  const codeGroups = new Map();

  for (const p of punches) {
    if (!codeGroups.has(p.biometricCode)) {
      codeGroups.set(p.biometricCode, []);
    }
    codeGroups.get(p.biometricCode).push(p);
  }

  const debounced = [];
  let droppedDuplicatesCount = 0;

  for (const [code, items] of codeGroups.entries()) {
    items.sort((a, b) => a.timestampMs - b.timestampMs);
    let lastRecordedMs = -Infinity;

    for (const item of items) {
      if (item.timestampMs - lastRecordedMs >= windowMs) {
        debounced.push(item);
        lastRecordedMs = item.timestampMs;
      } else {
        droppedDuplicatesCount++;
      }
    }
  }

  // Re-sort chronologically
  debounced.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    debouncedPunches: debounced,
    droppedDuplicatesCount,
    retainedCount: debounced.length,
  };
}

/**
 * Computes deterministic cryptographic signature for a punch
 */
function createPunchHash(tenantId, biometricCode, timestampIso) {
  return crypto
    .createHash("sha256")
    .update(`${tenantId}#${biometricCode}#${timestampIso}`)
    .digest("hex");
}

module.exports = {
  sanitizeLines,
  detectDelimiter,
  normalizeToIso,
  extractFromLine,
  parseUniversalFile,
  applyDebounceFilter,
  createPunchHash,
};
