const express = require("express");
const router = express.Router();
const DeviceModel = require("../models/deviceModel");
const EmployeeModel = require("../models/employeeModel");
const AttendanceModel = require("../models/attendanceModel");
const CompanyModel = require("../models/companyModel");
const AdmsService = require("../models/admsService");

// Disable HTTP caching so clients always get fresh DynamoDB state
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

/**
 * ============================================================================
 * 1. BioMax / eSSL / ZKTeco ADMS Cloud Protocol Endpoints
 * ============================================================================
 */

// ADMS Handshake (GET /cdata or /iclock/cdata)
router.get(["/cdata", "/iclock/cdata"], async (req, res) => {
  try {
    const result = await AdmsService.handleHandshake(req);
    res.set("Content-Type", result.contentType);
    return res.status(200).send(result.body);
  } catch (err) {
    console.error("[ADMS Handshake Error]", err);
    res.set("Content-Type", "text/plain");
    return res.status(200).send("OK");
  }
});

// ADMS Punch & Data Push (POST /cdata or /iclock/cdata)
router.post(["/cdata", "/iclock/cdata", "/fdata", "/push"], async (req, res) => {
  try {
    const result = await AdmsService.handleDataPush(req);
    res.set("Content-Type", result.contentType);
    return res.status(200).send(result.body);
  } catch (err) {
    console.error("[ADMS Push Error]", err);
    res.set("Content-Type", "text/plain");
    return res.status(200).send("OK");
  }
});

// ADMS Device Polling (GET /getrequest or /iclock/getrequest)
router.get(["/getrequest", "/iclock/getrequest", "/ping", "/registry"], async (req, res) => {
  try {
    const result = await AdmsService.handleGetRequest(req);
    res.set("Content-Type", result.contentType);
    return res.status(200).send(result.body);
  } catch (err) {
    console.error("[ADMS Polling Error]", err);
    res.set("Content-Type", "text/plain");
    return res.status(200).send("OK");
  }
});

// ADMS Device Command Reply (POST /devicecmd)
router.post(["/devicecmd", "/iclock/devicecmd"], (req, res) => {
  res.set("Content-Type", "text/plain");
  return res.status(200).send("OK");
});

/**
 * ============================================================================
 * 2. REST API for Attendance, Punches & Analytics
 * ============================================================================
 */

// GET /api/attendance/logs
router.get("/api/attendance/logs", async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.companyId || req.headers["x-tenant-id"] || req.headers["x-company-id"];
    const result = await AttendanceModel.queryLogs({
      tenantId,
      employeeId: req.query.employeeId,
      deviceSerial: req.query.deviceSerial,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      state: req.query.state,
      limit: req.query.limit,
      page: req.query.page,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("[GET /api/attendance/logs Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/attendance/stats
router.get("/api/attendance/stats", async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.companyId || req.headers["x-tenant-id"] || req.headers["x-company-id"];
    const stats = await AttendanceModel.getAttendanceStats(tenantId);
    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("[GET /api/attendance/stats Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/attendance/punch (Hardware agent / local bridge punch ingestion)
router.post("/api/attendance/punch", async (req, res) => {
  try {
    const { deviceSerial, employeeId, timestamp, state, punchType, rawData, photoBase64, tenantId: bodyTenantId } = req.body;
    let tenantId = bodyTenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"];

    if (!deviceSerial || !employeeId) {
      return res.status(400).json({ success: false, error: "deviceSerial and employeeId are required" });
    }

    // Lookup device to resolve tenantId if not provided
    const device = await DeviceModel.upsertHeartbeat({ serialNumber: deviceSerial });
    if (!tenantId && device.tenantId && device.tenantId !== "unassigned") {
      tenantId = device.tenantId;
    }

    if (!tenantId || tenantId === "unassigned") {
      return res.status(200).json({
        success: true,
        message: `Punch received for device ${deviceSerial} but device is unassigned to a company tenant.`,
      });
    }

    // Auto-upsert employee
    const employee = await EmployeeModel.upsertFromDevice(tenantId, employeeId);

    const result = await AttendanceModel.recordPunch({
      tenantId,
      employeeId,
      deviceSerial,
      deviceId: device.id,
      employeeDbId: employee.id,
      employeeName: employee.name,
      timestamp,
      state,
      punchType,
      rawData,
      photoBase64,
    });

    return res.status(result.isDuplicate ? 200 : 201).json({
      success: true,
      isDuplicate: result.isDuplicate,
      message: result.isDuplicate ? "Duplicate punch ignored" : "Punch recorded successfully",
      data: result.log,
    });
  } catch (error) {
    console.error("[POST /api/attendance/punch Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/attendance/sync-users (Biometric user enrollment synchronization)
router.post("/api/attendance/sync-users", async (req, res) => {
  try {
    const { deviceSerial, users, tenantId: bodyTenantId } = req.body;
    let tenantId = bodyTenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"];

    if (!deviceSerial || !Array.isArray(users)) {
      return res.status(400).json({ success: false, error: "deviceSerial and users array are required" });
    }

    const device = await DeviceModel.upsertHeartbeat({ serialNumber: deviceSerial });
    if (!tenantId && device.tenantId && device.tenantId !== "unassigned") {
      tenantId = device.tenantId;
    }

    if (!tenantId || tenantId === "unassigned") {
      return res.status(200).json({
        success: true,
        message: `Device ${deviceSerial} is currently unassigned to a tenant. Users queued until assigned.`,
      });
    }

    const syncResult = await EmployeeModel.syncBatchFromDevice(tenantId, users);
    return res.status(200).json({
      success: true,
      count: syncResult.syncedCount,
      message: `Successfully synced ${syncResult.syncedCount} user profiles from device ${deviceSerial}`,
    });
  } catch (error) {
    console.error("[POST /api/attendance/sync-users Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ============================================================================
 * 3. Device Management REST APIs
 * ============================================================================
 */

// GET /api/devices
router.get("/api/devices", async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.companyId || req.headers["x-tenant-id"] || req.headers["x-company-id"];
    const devices = await DeviceModel.listByTenant(tenantId);
    return res.status(200).json({ success: true, data: devices });
  } catch (error) {
    console.error("[GET /api/devices Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/devices/register
router.post("/api/devices/register", async (req, res) => {
  try {
    const { serialNumber, name, tenantId, model, ipAddress } = req.body;
    if (!serialNumber || !tenantId) {
      return res.status(400).json({ success: false, error: "serialNumber and tenantId are required" });
    }

    const device = await DeviceModel.create({
      tenantId,
      serialNumber,
      name,
      model,
      ipAddress,
    });

    return res.status(201).json({ success: true, data: device });
  } catch (error) {
    console.error("[POST /api/devices/register Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/devices/:id
router.put("/api/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.body.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"];
    if (!tenantId) return res.status(400).json({ success: false, error: "tenantId required" });

    const updated = await DeviceModel.update(tenantId, id, req.body);
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[PUT /api/devices/:id Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/devices/:id
router.delete("/api/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.query.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"];
    if (!tenantId) return res.status(400).json({ success: false, error: "tenantId required" });

    await DeviceModel.delete(tenantId, id);
    return res.status(200).json({ success: true, message: "Device deleted successfully" });
  } catch (error) {
    console.error("[DELETE /api/devices/:id Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ============================================================================
 * 4. Universal Cloud-Native Biometric USB Ingestion & Matrix Engine
 * ============================================================================
 */
const BiometricUsbModel = require("../models/biometricUsbModel");
const {
  parseUniversalFile,
  applyDebounceFilter,
  createPunchHash,
} = require("../utils/universalBiometricParser");

// POST /api/attendance/usb/parse-preview
router.post("/api/attendance/usb/parse-preview", async (req, res) => {
  try {
    const { fileContent, fileName, targetMonth } = req.body;
    const tenantId = req.body.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"] || "default";

    if (!fileContent) {
      return res.status(400).json({ success: false, error: "fileContent is required" });
    }

    // Decode base64 if sent as data URI or base64 string
    let rawText = fileContent;
    if (fileContent.startsWith("data:") || fileContent.includes(";base64,")) {
      const base64Data = fileContent.split(";base64,").pop();
      rawText = Buffer.from(base64Data, "base64").toString("utf-8");
    }

    // 1. Universal Multi-Format Parsing & Sanitation
    const parseResult = parseUniversalFile(rawText);
    if (!parseResult.success || parseResult.punches.length === 0) {
      return res.status(400).json({
        success: false,
        error: parseResult.error || "No valid biometric punch records detected in file",
        meta: parseResult,
      });
    }

    // 2. Multi-layer Deduplication: Layer 1 - 60s Sliding Debounce
    const debounced = applyDebounceFilter(parseResult.punches, 60);

    // 3. Multi-layer Deduplication: Layer 2 - Exact Cryptographic Punch Signatures
    const punchesWithHash = debounced.debouncedPunches.map((p) => {
      const hash = createPunchHash(tenantId, p.biometricCode, p.timestamp);
      return { ...p, hash };
    });

    const allHashes = punchesWithHash.map((p) => p.hash);
    const existingHashes = await BiometricUsbModel.checkExistingSignatures(tenantId, allHashes);

    // 4. Smart Employee Code Mapping & Matrix Aggregation
    // Calculate monthly attendance using all valid debounced punches from the file
    const matrixResult = await BiometricUsbModel.computeMonthlyAttendanceMatrix(
      tenantId,
      punchesWithHash,
      targetMonth
    );

    // Only new hashes that are not yet stored in DynamoDB dedup ledger need to be queued
    const newSignatures = punchesWithHash
      .filter((p) => !existingHashes.has(p.hash))
      .map((p) => p.hash);

    return res.status(200).json({
      success: true,
      ...matrixResult,
      metrics: {
        fileName: fileName || "biometric_upload.txt",
        delimiterDetected: parseResult.delimiterDetected,
        dateFormatDetected: parseResult.dateFormatDetected,
        totalLinesParsed: parseResult.totalLines,
        rawPunchesCount: parseResult.validPunchesCount,
        debouncedPunchesCount: debounced.retainedCount,
        debouncedDroppedCount: debounced.droppedDuplicatesCount,
        existingDuplicateHashesCount: existingHashes.size,
        cleanPunchesProcessed: punchesWithHash.length,
        newHashesCount: newSignatures.length,
      },
      newPunchSignatures: newSignatures,
    });
  } catch (error) {
    console.error("[POST /api/attendance/usb/parse-preview Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/attendance/usb/mappings
router.get("/api/attendance/usb/mappings", async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"] || "default";
    const { mappingList } = await BiometricUsbModel.getMappings(tenantId);
    return res.status(200).json({ success: true, mappings: mappingList });
  } catch (error) {
    console.error("[GET /api/attendance/usb/mappings Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/attendance/usb/save-mappings
router.post("/api/attendance/usb/save-mappings", async (req, res) => {
  try {
    const { mappings, adminId } = req.body;
    const tenantId = req.body.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"] || "default";

    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ success: false, error: "mappings array is required" });
    }

    const result = await BiometricUsbModel.saveMappings(tenantId, mappings, adminId || "HR_ADMIN");
    return res.status(200).json({
      success: true,
      savedCount: result.savedCount,
      message: `Successfully registered ${result.savedCount} employee biometric code mappings.`,
    });
  } catch (error) {
    console.error("[POST /api/attendance/usb/save-mappings Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/attendance/usb/confirm-save
router.post("/api/attendance/usb/confirm-save", async (req, res) => {
  try {
    const { matrixRows, punchSignatures, adminId } = req.body;
    const tenantId = req.body.tenantId || req.headers["x-tenant-id"] || req.headers["x-company-id"] || "default";

    if (!Array.isArray(matrixRows) || matrixRows.length === 0) {
      return res.status(400).json({ success: false, error: "matrixRows array is required" });
    }

    const result = await BiometricUsbModel.commitAttendanceBatch(
      tenantId,
      matrixRows,
      punchSignatures || [],
      adminId || "HR_ADMIN"
    );

    return res.status(200).json({
      success: true,
      message: `Successfully saved ${result.writtenAttendanceCount} attendance records and registered ${result.writtenDedupHashesCount} cryptographic deduplication signatures to AWS.`,
      result,
    });
  } catch (error) {
    console.error("[POST /api/attendance/usb/confirm-save Error]", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
