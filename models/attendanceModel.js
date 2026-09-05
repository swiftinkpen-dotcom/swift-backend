const {
  ddb,
  TABLES,
  ensureCompositeTable,
  uploadToS3,
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
} = require("./awsClient");

const BIO_TABLE = TABLES.biometricLogs;
const ATTENDANCE_TABLE = TABLES.attendance;

/**
 * Attendance & Biometric Log Model on AWS DynamoDB + S3.
 * Manages raw punch ingestion, deduplication, daily attendance aggregation, and reporting.
 */
class AttendanceModel {
  /**
   * Initializes DynamoDB composite tables for Biometric Logs and Attendance
   */
  static async initTable() {
    await ensureCompositeTable(BIO_TABLE, "tenantId", "id");
    await ensureCompositeTable(ATTENDANCE_TABLE, "tenantId", "id");
    return true;
  }

  /**
   * Ingests a single biometric punch with deduplication and S3 photo snapshot storage
   * @param {object} punchData
   * @param {string} punchData.tenantId - Company tenant identifier
   * @param {string} punchData.employeeId - Employee code / device user ID
   * @param {string} punchData.deviceSerial - Machine serial number
   * @param {string} [punchData.deviceId] - Linked device record ID
   * @param {string} [punchData.employeeDbId] - Linked employee record ID
   * @param {string} [punchData.employeeName] - Employee name
   * @param {Date|string} [punchData.timestamp] - Punch timestamp
   * @param {string} [punchData.state] - CHECK_IN, CHECK_OUT, etc.
   * @param {string} [punchData.punchType] - FINGERPRINT, FACE_RECOGNITION, CARD_RFID, etc.
   * @param {string} [punchData.rawData] - Original ADMS text line
   * @param {string} [punchData.photoBase64] - Base64 captured face snapshot
   * @returns {Promise<{ success: boolean, isDuplicate?: boolean, log?: object }>}
   */
  static async recordPunch(punchData) {
    const {
      tenantId,
      employeeId,
      deviceSerial,
      deviceId,
      employeeDbId,
      employeeName,
      timestamp,
      state = "CHECK_IN",
      punchType = "FINGERPRINT",
      rawData,
      photoBase64,
    } = punchData;

    if (!tenantId || !employeeId || !deviceSerial) {
      throw new Error("tenantId, employeeId, and deviceSerial are required to record a punch");
    }

    const cleanEmpId = String(employeeId).trim();
    const cleanSN = String(deviceSerial).trim();
    const punchDate = timestamp ? new Date(timestamp) : new Date();
    const validPunchDate = !isNaN(punchDate.getTime()) ? punchDate : new Date();
    const punchIso = validPunchDate.toISOString();
    const punchTimeMs = validPunchDate.getTime();

    const dateStr = validPunchDate.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = validPunchDate.toTimeString().split(" ")[0]; // HH:mm:ss

    // 1. Deduplication Check: Look for existing punch within 30 seconds for same employee + device
    const recentLogs = await this.queryLogs({
      tenantId,
      employeeId: cleanEmpId,
      deviceSerial: cleanSN,
      startDate: new Date(punchTimeMs - 30 * 1000).toISOString(),
      endDate: new Date(punchTimeMs + 30 * 1000).toISOString(),
      limit: 5,
    });

    if (recentLogs.logs && recentLogs.logs.length > 0) {
      return {
        success: true,
        isDuplicate: true,
        message: "Duplicate punch ignored (already recorded within 30s window)",
        log: recentLogs.logs[0],
      };
    }

    // 2. Upload photo snapshot to AWS S3 if provided
    let photoUrl = null;
    if (photoBase64 && photoBase64.startsWith("data:")) {
      const s3Key = `punches/${tenantId}/${cleanEmpId}_${punchTimeMs}.jpg`;
      photoUrl = await uploadToS3(s3Key, photoBase64);
    }

    // 3. Persist Biometric Log to DynamoDB
    const logId = `bio_${punchTimeMs}_${Math.random().toString(36).substring(2, 7)}`;
    const biometricItem = {
      id: logId,
      tenantId,
      employeeId: cleanEmpId,
      employeeDbId: employeeDbId || null,
      employeeName: employeeName || `Employee #${cleanEmpId}`,
      deviceSerial: cleanSN,
      deviceId: deviceId || null,
      timestamp: punchIso,
      date: dateStr,
      time: timeStr,
      state: state.toUpperCase(),
      punchType: punchType.toUpperCase(),
      photoUrl,
      rawData: rawData || `${cleanEmpId}\t${punchIso}\t${state}\t${punchType}`,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: BIO_TABLE,
        Item: biometricItem,
      })
    );

    // 4. Asynchronously aggregate into Daily Attendance table
    try {
      await this.syncDailyAttendance(tenantId, cleanEmpId, validPunchDate, state, cleanSN);
    } catch (attErr) {
      console.warn(`[AttendanceModel] Daily attendance sync non-fatal warning:`, attErr.message);
    }

    return {
      success: true,
      isDuplicate: false,
      log: biometricItem,
    };
  }

  /**
   * Aggregates punch into the daily attendance summary record
   */
  static async syncDailyAttendance(tenantId, employeeId, punchDate, punchState, deviceSerial) {
    const dateStr = punchDate.toISOString().split("T")[0];
    const timeStr = punchDate.toTimeString().split(" ")[0];
    const dailyId = `att_${employeeId}_${dateStr}`;

    let dailyItem = null;
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: ATTENDANCE_TABLE,
          Key: { tenantId, id: dailyId },
        })
      );
      dailyItem = res.Item;
    } catch (err) {
      // Ignore not found
    }

    const nowIso = new Date().toISOString();

    if (!dailyItem) {
      dailyItem = {
        id: dailyId,
        tenantId,
        employeeId,
        date: dateStr,
        inTime: timeStr,
        outTime: timeStr,
        firstPunch: punchDate.toISOString(),
        lastPunch: punchDate.toISOString(),
        status: "Present",
        punchCount: 1,
        deviceSerial,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    } else {
      dailyItem.punchCount = (dailyItem.punchCount || 1) + 1;
      dailyItem.lastPunch = punchDate.toISOString();
      dailyItem.updatedAt = nowIso;

      if (punchState.toUpperCase().includes("OUT") || new Date(dailyItem.inTime) < punchDate) {
        dailyItem.outTime = timeStr;
      }
      if (punchState.toUpperCase().includes("IN") && (!dailyItem.inTime || dailyItem.inTime > timeStr)) {
        dailyItem.inTime = timeStr;
      }
    }

    await ddb.send(
      new PutCommand({
        TableName: ATTENDANCE_TABLE,
        Item: dailyItem,
      })
    );
  }

  /**
   * Batch records parsed punches from an ADMS push stream
   * @param {string} tenantId
   * @param {Array<object>} records
   * @returns {Promise<{ total: number, saved: number, duplicates: number }>}
   */
  static async recordBatchPunches(tenantId, records) {
    if (!tenantId || !Array.isArray(records)) {
      return { total: 0, saved: 0, duplicates: 0 };
    }

    let saved = 0;
    let duplicates = 0;

    for (const rec of records) {
      try {
        const res = await this.recordPunch({
          tenantId,
          employeeId: rec.employeeId,
          deviceSerial: rec.deviceSerial,
          deviceId: rec.deviceId,
          employeeDbId: rec.employeeDbId,
          employeeName: rec.employeeName,
          timestamp: rec.timestamp,
          state: rec.state,
          punchType: rec.punchType,
          rawData: rec.rawLine || rec.rawData,
        });

        if (res.isDuplicate) {
          duplicates++;
        } else if (res.success) {
          saved++;
        }
      } catch (err) {
        console.error(`[AttendanceModel.recordBatchPunches] Error saving punch for ${rec.employeeId}:`, err.message);
      }
    }

    return { total: records.length, saved, duplicates };
  }

  /**
   * Queries and filters biometric logs with pagination
   * @param {object} filter
   */
  static async queryLogs(filter = {}) {
    const {
      tenantId,
      employeeId,
      deviceSerial,
      startDate,
      endDate,
      state,
      limit = 100,
      page = 1,
    } = filter;

    let items = [];

    if (tenantId) {
      try {
        const queryRes = await ddb.send(
          new QueryCommand({
            TableName: BIO_TABLE,
            KeyConditionExpression: "tenantId = :tId",
            ExpressionAttributeValues: { ":tId": tenantId },
          })
        );
        items = queryRes.Items || [];
      } catch (err) {
        const scanRes = await ddb.send(
          new ScanCommand({
            TableName: BIO_TABLE,
            FilterExpression: "tenantId = :tId",
            ExpressionAttributeValues: { ":tId": tenantId },
          })
        );
        items = scanRes.Items || [];
      }
    } else {
      const scanRes = await ddb.send(new ScanCommand({ TableName: BIO_TABLE }));
      items = scanRes.Items || [];
    }

    // Apply In-Memory filters
    if (employeeId) {
      const empLower = String(employeeId).trim().toLowerCase();
      items = items.filter((log) => String(log.employeeId || "").trim().toLowerCase() === empLower);
    }

    if (deviceSerial) {
      const snLower = String(deviceSerial).trim().toLowerCase();
      items = items.filter((log) => String(log.deviceSerial || "").trim().toLowerCase() === snLower);
    }

    if (state) {
      const stateUpper = String(state).trim().toUpperCase();
      items = items.filter((log) => String(log.state || "").trim().toUpperCase() === stateUpper);
    }

    if (startDate || endDate) {
      const startMs = startDate ? new Date(startDate).getTime() : 0;
      const endMs = endDate ? new Date(endDate).getTime() : Infinity;

      items = items.filter((log) => {
        const t = new Date(log.timestamp).getTime();
        return t >= startMs && t <= endMs;
      });
    }

    // Sort descending by timestamp
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const take = Math.min(Number(limit) || 100, 500);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;
    const paginated = items.slice(skip, skip + take);

    return {
      pagination: {
        total: items.length,
        page: currentPage,
        limit: take,
        totalPages: Math.ceil(items.length / take) || 1,
      },
      logs: paginated,
    };
  }

  /**
   * Retrieves summary analytics for attendance dashboard
   * @param {string} tenantId
   */
  static async getAttendanceStats(tenantId) {
    const todayStr = new Date().toISOString().split("T")[0];

    const allLogs = await this.queryLogs({ tenantId, limit: 1000 });
    const logs = allLogs.logs || [];

    const todayLogs = logs.filter((l) => l.date === todayStr || (l.timestamp && l.timestamp.startsWith(todayStr)));

    // Extract unique active employees today
    const activeEmployeesToday = new Set(todayLogs.map((l) => l.employeeId)).size;
    const activeDevicesToday = new Set(todayLogs.map((l) => l.deviceSerial)).size;

    return {
      totalTodayPunches: todayLogs.length,
      activeEmployeesToday,
      activeDevicesToday,
      recentPunches: logs.slice(0, 10),
    };
  }
}

module.exports = AttendanceModel;
