const {
  ddb,
  TABLES,
  ensureCompositeTable,
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} = require("./awsClient");
const EmployeeModel = require("./employeeModel");
const { createPunchHash } = require("../utils/universalBiometricParser");

const MAPPINGS_TABLE = TABLES.biometricMappings;
const DEDUP_TABLE = TABLES.biometricDedup;
const ATTENDANCE_TABLE = TABLES.attendance;

// Local memory cache fallback for seamless dev/offline operation
const memMappings = new Map(); // tenantId -> Map(bioCode -> item)
const memDedup = new Set();    // Set of "tenantId#hash"

class BiometricUsbModel {
  /**
   * Initializes DynamoDB composite tables for Biometric USB Mappings and Deduplication
   */
  static async initTable() {
    try {
      await ensureCompositeTable(MAPPINGS_TABLE, "tenantId", "id");
      await ensureCompositeTable(DEDUP_TABLE, "tenantId", "id");
      return true;
    } catch (e) {
      console.warn("[BiometricUsbModel.initTable warning]", e.message);
      return false;
    }
  }

  /**
   * Retrieves all registered mappings for a tenant
   * Returns a map: biometricCode -> { employeeId, employeeName, department, empCode }
   */
  static async getMappings(tenantId) {
    if (!tenantId) return { mappingList: [], mappingMap: new Map() };

    let items = [];
    try {
      const res = await ddb.send(
        new QueryCommand({
          TableName: MAPPINGS_TABLE,
          KeyConditionExpression: "tenantId = :tId",
          ExpressionAttributeValues: { ":tId": tenantId },
        })
      );
      items = res.Items || [];
    } catch (err) {
      if (err.name === "ResourceNotFoundException" || err.message?.includes("not found")) {
        await this.initTable();
      }
      try {
        const scanRes = await ddb.send(
          new ScanCommand({
            TableName: MAPPINGS_TABLE,
            FilterExpression: "tenantId = :tId",
            ExpressionAttributeValues: { ":tId": tenantId },
          })
        );
        items = scanRes.Items || [];
      } catch (scanErr) {
        // Fallback to local memory cache
        const tMap = memMappings.get(tenantId);
        if (tMap) {
          items = Array.from(tMap.values());
        } else {
          items = [];
        }
      }
    }

    const mappingMap = new Map();
    for (const item of items) {
      if (item.biometricCode) {
        mappingMap.set(String(item.biometricCode).trim(), item);
      }
    }

    // Also merge with memory cache if available
    const tMem = memMappings.get(tenantId);
    if (tMem) {
      for (const [code, item] of tMem.entries()) {
        if (!mappingMap.has(code)) {
          mappingMap.set(code, item);
          items.push(item);
        }
      }
    }

    return { mappingList: items, mappingMap };
  }

  /**
   * Saves new BiometricCode -> PortalEmployeeID pairs
   */
  static async saveMappings(tenantId, newMappings, adminId = "SYSTEM") {
    if (!tenantId || !Array.isArray(newMappings) || newMappings.length === 0) {
      return { success: true, savedCount: 0 };
    }

    const nowIso = new Date().toISOString();
    let savedCount = 0;

    if (!memMappings.has(tenantId)) {
      memMappings.set(tenantId, new Map());
    }
    const tenantMem = memMappings.get(tenantId);

    for (const m of newMappings) {
      const bioCode = String(m.biometricCode).trim();
      const empId = String(m.employeeId).trim();
      if (!bioCode || !empId) continue;

      const recordId = `BIO#${bioCode}`;
      const item = {
        tenantId,
        id: recordId,
        biometricCode: bioCode,
        employeeId: empId,
        employeeName: m.employeeName || `Employee ${empId}`,
        department: m.department || "General",
        empCode: m.empCode || empId,
        mappedBy: adminId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      // Always save to memory cache
      tenantMem.set(bioCode, item);

      // Attempt DynamoDB write
      try {
        await ddb.send(
          new PutCommand({
            TableName: MAPPINGS_TABLE,
            Item: item,
          })
        );
      } catch (putErr) {
        if (putErr.name === "ResourceNotFoundException" || putErr.message?.includes("not found")) {
          await this.initTable();
          try {
            await ddb.send(new PutCommand({ TableName: MAPPINGS_TABLE, Item: item }));
          } catch (_e2) {
            // Memory cache has it
          }
        }
      }
      savedCount++;
    }

    return { success: true, savedCount };
  }

  /**
   * Checks if punch hashes already exist in the deduplication store
   */
  static async checkExistingSignatures(tenantId, hashes) {
    if (!tenantId || !Array.isArray(hashes) || hashes.length === 0) {
      return new Set();
    }

    const existingHashes = new Set();
    const uniqueHashes = [...new Set(hashes)];

    // Check memory store first
    for (const hash of uniqueHashes) {
      if (memDedup.has(`${tenantId}#${hash}`)) {
        existingHashes.add(hash);
      }
    }

    const checkBatch = async (batch) => {
      const promises = batch.map(async (hash) => {
        try {
          const res = await ddb.send(
            new GetCommand({
              TableName: DEDUP_TABLE,
              Key: { tenantId, id: `HASH#${hash}` },
            })
          );
          if (res.Item) {
            existingHashes.add(hash);
          }
        } catch (err) {
          // non-blocking
        }
      });
      await Promise.all(promises);
    };

    const chunkSize = 25;
    for (let i = 0; i < uniqueHashes.length; i += chunkSize) {
      await checkBatch(uniqueHashes.slice(i, i + chunkSize));
    }

    return existingHashes;
  }

  /**
   * Computes monthly attendance overview matrix before final commit
   */
  static async computeMonthlyAttendanceMatrix(tenantId, punches, targetMonthStr = null) {
    // 1. Fetch existing mappings
    const { mappingMap } = await this.getMappings(tenantId);

    // 2. Fetch all registered company employees
    let employees = [];
    try {
      employees = await EmployeeModel.listByTenant(tenantId);
    } catch (e) {
      employees = [];
    }

    // Build helper employee lookup
    const empById = new Map();
    for (const emp of employees) {
      empById.set(String(emp.id).trim(), emp);
      if (emp.empCode) empById.set(String(emp.empCode).trim().toLowerCase(), emp);
      if (emp.employeeId) empById.set(String(emp.employeeId).trim().toLowerCase(), emp);
      if (emp.biometricPin) empById.set(String(emp.biometricPin).trim().toLowerCase(), emp);
    }

    // 3. Extract distinct biometric codes in uploaded file
    const distinctCodes = [...new Set(punches.map((p) => String(p.biometricCode).trim()))];
    const unmappedCodes = [];
    const autoMatchedSuggestions = [];

    for (const code of distinctCodes) {
      const existingMapping = mappingMap.get(code);
      if (!existingMapping) {
        // Attempt smart auto-suggest
        const lowerCode = code.toLowerCase();
        let suggestedEmp = empById.get(lowerCode);

        if (!suggestedEmp) {
          // Check if employee code ends with this number or contains it
          suggestedEmp = employees.find((e) => {
            const c = String(e.empCode || e.employeeId || "").toLowerCase();
            return c === `emp-${lowerCode}` || c === `emp${lowerCode}` || c.endsWith(lowerCode);
          });
        }

        unmappedCodes.push({
          biometricCode: code,
          suggestedEmployee: suggestedEmp
            ? {
                id: suggestedEmp.id,
                name: `${suggestedEmp.firstName || ""} ${suggestedEmp.lastName || ""}`.trim() || suggestedEmp.name,
                empCode: suggestedEmp.empCode || suggestedEmp.id,
                department: suggestedEmp.department || "General",
              }
            : null,
        });
      }
    }

    // If there are unmapped codes, return early with mapping requirements
    if (unmappedCodes.length > 0) {
      return {
        status: "MAPPING_REQUIRED",
        unmappedCodes,
        totalDistinctCodes: distinctCodes.length,
        mappedCodesCount: distinctCodes.length - unmappedCodes.length,
        registeredEmployees: employees.map((e) => ({
          id: e.id,
          name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.name || "Unknown",
          empCode: e.empCode || e.id,
          department: e.department || "General",
          avatar: e.avatar || null,
        })),
      };
    }

    // 4. Determine target year-month dynamically from the uploaded punches
    const monthFrequency = new Map();
    for (const p of punches) {
      if (p.dateOnly) {
        const ym = p.dateOnly.substring(0, 7);
        monthFrequency.set(ym, (monthFrequency.get(ym) || 0) + 1);
      }
    }

    let dominantYearMonth = null;
    let maxMonthCount = 0;
    for (const [ym, count] of monthFrequency.entries()) {
      if (count > maxMonthCount) {
        maxMonthCount = count;
        dominantYearMonth = ym;
      }
    }

    // If punches in the file are predominantly in one month (e.g., September 2026-09),
    // prioritize that month so files are never mismatched!
    let targetYearMonth = dominantYearMonth || targetMonthStr || new Date().toISOString().substring(0, 7);
    if (targetMonthStr && monthFrequency.has(targetMonthStr)) {
      targetYearMonth = targetMonthStr;
    }

    const [yearNum, monthNum] = targetYearMonth.split("-").map((n) => parseInt(n, 10));
    const daysInMonth = new Date(yearNum, monthNum, 0).getDate();

    // 5. Group punches by Employee and Day
    // Key: employeeId -> date -> Array of punches
    const employeePunchGrid = new Map();

    for (const p of punches) {
      const mapping = mappingMap.get(String(p.biometricCode).trim());
      if (!mapping) continue;

      const empId = mapping.employeeId;
      if (!employeePunchGrid.has(empId)) {
        employeePunchGrid.set(empId, new Map());
      }

      const dateMap = employeePunchGrid.get(empId);
      if (!dateMap.has(p.dateOnly)) {
        dateMap.set(p.dateOnly, []);
      }
      dateMap.get(p.dateOnly).push(p);
    }

    // 6. Build the Monthly Attendance Matrix Rows
    const matrixRows = [];
    let grandTotalPresent = 0;
    let grandTotalHalfDay = 0;
    let grandTotalAbsent = 0;
    let grandTotalHours = 0;

    // Collect all mapped employees
    const activeMappedEmployees = [];
    for (const [bioCode, mapItem] of mappingMap.entries()) {
      if (!activeMappedEmployees.some((e) => e.employeeId === mapItem.employeeId)) {
        activeMappedEmployees.push(mapItem);
      }
    }

    for (const mapItem of activeMappedEmployees) {
      const empId = mapItem.employeeId;
      const empProfile = empById.get(empId) || {};
      const empName = mapItem.employeeName || empProfile.name || `Employee ${empId}`;
      const empCode = mapItem.empCode || empProfile.empCode || empId;
      const department = mapItem.department || empProfile.department || "General";
      const avatar = empProfile.avatar || null;

      const dateMap = employeePunchGrid.get(empId) || new Map();
      const days = [];

      let empPresent = 0;
      let empHalfDay = 0;
      let empAbsent = 0;
      let empWeeklyOff = 0;
      let empTotalHours = 0;

      for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
        const padDay = String(dayNum).padStart(2, "0");
        const dateStr = `${targetYearMonth}-${padDay}`;
        const dayDate = new Date(`${dateStr}T12:00:00Z`);
        const isSunday = dayDate.getUTCDay() === 0;

        const dayPunches = dateMap.get(dateStr) || [];
        dayPunches.sort((a, b) => a.timestampMs - b.timestampMs);

        let checkIn = null;
        let checkOut = null;
        let totalHours = 0;
        let status = isSunday ? "WO" : "A"; // Default Weekly Off on Sunday, else Absent

        if (dayPunches.length > 0) {
          checkIn = dayPunches[0].timeOnly;
          if (dayPunches.length > 1) {
            checkOut = dayPunches[dayPunches.length - 1].timeOnly;
            const diffMs = dayPunches[dayPunches.length - 1].timestampMs - dayPunches[0].timestampMs;
            totalHours = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
          } else {
            // Single punch recorded
            checkOut = null;
            totalHours = 4.0; // Default half-day credit for single punch
          }

          if (totalHours >= 8.0) {
            status = "P";
            empPresent++;
          } else if (totalHours >= 4.0) {
            status = "HD";
            empHalfDay++;
          } else {
            status = "HD";
            empHalfDay++;
          }

          empTotalHours += totalHours;
        } else {
          if (isSunday) {
            empWeeklyOff++;
          } else {
            empAbsent++;
          }
        }

        days.push({
          day: dayNum,
          date: dateStr,
          status, // 'P', 'HD', 'A', 'WO'
          checkIn,
          checkOut,
          totalHours,
          punchCount: dayPunches.length,
        });
      }

      grandTotalPresent += empPresent;
      grandTotalHalfDay += empHalfDay;
      grandTotalAbsent += empAbsent;
      grandTotalHours += empTotalHours;

      matrixRows.push({
        employeeId: empId,
        employeeName: empName,
        empCode,
        department,
        avatar,
        biometricCode: mapItem.biometricCode,
        summary: {
          totalDays: daysInMonth,
          present: empPresent,
          halfDay: empHalfDay,
          absent: empAbsent,
          weeklyOff: empWeeklyOff,
          totalHours: Math.round(empTotalHours * 10) / 10,
        },
        days,
      });
    }

    return {
      status: "READY",
      targetYearMonth,
      daysInMonth,
      totalEmployees: matrixRows.length,
      kpis: {
        totalEmployees: matrixRows.length,
        grandTotalPresent,
        grandTotalHalfDay,
        grandTotalAbsent,
        grandTotalHours: Math.round(grandTotalHours * 10) / 10,
      },
      matrixRows,
    };
  }

  /**
   * Commits calculated monthly attendance records and punch signatures to DynamoDB
   * Uses BatchWriteCommand with full-jitter exponential backoff
   */
  static async commitAttendanceBatch(tenantId, matrixRows, punchSignatures, adminId = "SYSTEM") {
    if (!tenantId || !Array.isArray(matrixRows) || matrixRows.length === 0) {
      return { success: false, error: "No matrix rows to commit" };
    }

    const nowIso = new Date().toISOString();
    const attendanceItems = [];
    const bioLogItems = [];

    // Flatten matrix days into individual daily attendance records
    for (const row of matrixRows) {
      for (const d of row.days) {
        // Only write records that have punches or are present/half-day
        if (d.punchCount > 0 || d.status === "P" || d.status === "HD") {
          const checkInVal = d.checkIn || undefined;
          const checkOutVal = d.checkOut || undefined;
          const statusLower = d.status === "P" ? "present" : d.status === "HD" ? "half-day" : "absent";
          const hoursVal = d.totalHours || (checkInVal && checkOutVal ? 9 : 4);

          attendanceItems.push({
            tenantId,
            id: `att_${row.employeeId}_${d.date}`,
            employeeId: row.employeeId,
            employeeName: row.employeeName,
            empCode: row.empCode,
            department: row.department,
            date: d.date,
            checkIn: checkInVal,
            clockIn: checkInVal,
            checkOut: checkOutVal,
            clockOut: checkOutVal,
            inTime: checkInVal || "--:--",
            outTime: checkOutVal || "--:--",
            firstPunch: checkInVal ? `${d.date}T${checkInVal}Z` : null,
            lastPunch: checkOutVal ? `${d.date}T${checkOutVal}Z` : null,
            hoursWorked: hoursVal,
            totalHours: hoursVal,
            status: statusLower,
            punchCount: d.punchCount || 1,
            punchType: "FINGERPRINT",
            source: "BIOMETRIC_TERMINAL",
            importedBy: adminId,
            createdAt: nowIso,
            updatedAt: nowIso,
          });

          // Also generate punch logs for live biometric feed
          if (checkInVal) {
            bioLogItems.push({
              tenantId,
              id: `bio_${row.employeeId}_${d.date}_in`,
              employeeId: row.employeeId,
              employeeName: row.employeeName,
              empCode: row.empCode,
              department: row.department,
              timestamp: `${d.date}T${checkInVal}:00.000Z`,
              date: d.date,
              time: checkInVal,
              state: "CHECK_IN",
              punchType: "FINGERPRINT",
              deviceSerial: "USB-IMPORT",
              createdAt: nowIso,
            });
          }
          if (checkOutVal && checkOutVal !== checkInVal) {
            bioLogItems.push({
              tenantId,
              id: `bio_${row.employeeId}_${d.date}_out`,
              employeeId: row.employeeId,
              employeeName: row.employeeName,
              empCode: row.empCode,
              department: row.department,
              timestamp: `${d.date}T${checkOutVal}:00.000Z`,
              date: d.date,
              time: checkOutVal,
              state: "CHECK_OUT",
              punchType: "FINGERPRINT",
              deviceSerial: "USB-IMPORT",
              createdAt: nowIso,
            });
          }
        }
      }
    }

    // Dedup hash records with 90-day TTL
    const dedupItems = [];
    const ttlEpoch = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days

    for (const hash of punchSignatures || []) {
      memDedup.add(`${tenantId}#${hash}`);
      dedupItems.push({
        tenantId,
        id: `HASH#${hash}`,
        hash,
        ttl: ttlEpoch,
        createdAt: nowIso,
      });
    }

    // Helper: Execute BatchWrite with jitter retry
    const writeItemsInBatches = async (tableName, items) => {
      if (!items || items.length === 0) return;
      const chunkSize = 25;
      for (let i = 0; i < items.length; i += chunkSize) {
        const batch = items.slice(i, i + chunkSize);
        let requestItems = {
          [tableName]: batch.map((item) => ({ PutRequest: { Item: item } })),
        };

        let retries = 0;
        const maxRetries = 5;

        while (requestItems[tableName] && requestItems[tableName].length > 0 && retries < maxRetries) {
          try {
            const res = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
            const unprocessed = res.UnprocessedItems?.[tableName] || [];

            if (unprocessed.length === 0) break;

            retries++;
            const delay = Math.floor(Math.random() * (Math.pow(2, retries) * 50));
            await new Promise((resolve) => setTimeout(resolve, delay));
            requestItems = { [tableName]: unprocessed };
          } catch (writeErr) {
            console.warn(`[BatchWrite warning for ${tableName}]`, writeErr.message);
            break;
          }
        }
      }
    };

    // 1. Write attendance records
    await writeItemsInBatches(ATTENDANCE_TABLE, attendanceItems);

    // 2. Write deduplication hashes
    if (dedupItems.length > 0) {
      await writeItemsInBatches(DEDUP_TABLE, dedupItems);
    }

    // 3. Write biometric punch logs if table is configured
    if (bioLogItems.length > 0 && TABLES.biometricLogs) {
      await writeItemsInBatches(TABLES.biometricLogs, bioLogItems);
    }

    return {
      success: true,
      writtenAttendanceCount: attendanceItems.length,
      writtenDedupHashesCount: dedupItems.length,
      writtenPunchLogsCount: bioLogItems.length,
      attendanceRecords: attendanceItems,
    };
  }
}

module.exports = BiometricUsbModel;
