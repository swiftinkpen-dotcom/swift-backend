const { extractDeviceSN, parseAdmsPayload } = require("./admsParser");
const DeviceModel = require("./deviceModel");
const EmployeeModel = require("./employeeModel");
const AttendanceModel = require("./attendanceModel");
const CompanyModel = require("./companyModel");

/**
 * ADMS Cloud Service for handling BioMax, eSSL, and ZKTeco biometric push protocol over AWS DynamoDB.
 */
class AdmsService {
  /**
   * GET /iclock/cdata or /cdata
   * Handshake & Configuration responder for biometric hardware on boot / interval.
   */
  static async handleHandshake(req) {
    const serialNumber = extractDeviceSN(req);
    const clientIp = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";
    const pushVer = req.query?.pushver || req.query?.PushProtVer || "2.4.1";

    console.log(`[ADMS AWS Handshake] SN: ${serialNumber} | IP: ${clientIp} | PushVer: ${pushVer}`);

    if (serialNumber && serialNumber !== "UNKNOWN") {
      try {
        await DeviceModel.upsertHeartbeat({
          serialNumber,
          ipAddress: String(clientIp),
          pushVersion: String(pushVer),
        });
      } catch (err) {
        console.error(`[ADMS Handshake] Heartbeat update error:`, err.message);
      }
    }

    // Standard ADMS protocol handshake response
    const responseConfig = [
      `GET OPTION FROM: ${serialNumber}`,
      `Stamp=0`,
      `OpStamp=0`,
      `PhotoStamp=0`,
      `ATTLOGStamp=0`,
      `OPERLOGStamp=0`,
      `BIODATAStamp=0`,
      `ErrorDelay=60`,
      `Delay=10`,
      `TransInterval=1`,
      `TransFlag=1111000000`,
      `TimeZone=330`,
      `Realtime=1`,
      `Encrypt=0`,
      `ServerVersion=3.4.1`,
      `PushProtVer=2.4.1`,
      `PushOptionsFlag=1`,
      `ServerName=Swift ADMS AWS Cloud Server`,
    ].join("\n");

    return {
      contentType: "text/plain",
      body: responseConfig,
    };
  }

  /**
   * POST /iclock/cdata or /cdata
   * Ingests real-time punch logs and device data pushed by hardware.
   */
  static async handleDataPush(req) {
    const serialNumber = extractDeviceSN(req);
    const table = String(req.query?.table || req.query?.TableName || "ATTLOG").toUpperCase();
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || "");
    const clientIp = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";

    console.log(`[ADMS AWS Push] SN: ${serialNumber} | Table: ${table} | Bytes: ${rawBody.length}`);

    if (!serialNumber || serialNumber === "UNKNOWN") {
      return { contentType: "text/plain", body: "OK" };
    }

    // 1. Upsert Device in DynamoDB
    const device = await DeviceModel.upsertHeartbeat({
      serialNumber,
      ipAddress: String(clientIp),
    });

    // 2. Ignore non-attendance tables
    if (table === "OPTIONS" || table === "OPERLOG" || table === "BIODATA") {
      return { contentType: "text/plain", body: "OK" };
    }

    // 3. Multi-tenant assignment check
    const tenantId = device.tenantId;
    if (!tenantId || tenantId === "unassigned") {
      console.warn(`⚠️ [ADMS Warning] Device ${serialNumber} is unassigned. Punches acknowledged but unassigned.`);
      return { contentType: "text/plain", body: "OK: 0" };
    }

    // 4. Parse punch records
    const parsedRecords = parseAdmsPayload(rawBody);
    let savedCount = 0;

    for (const rec of parsedRecords) {
      try {
        // Auto-provision or update Employee
        const employee = await EmployeeModel.upsertFromDevice(
          tenantId,
          rec.employeeId,
          `Employee #${rec.employeeId}`
        );

        // Record punch in DynamoDB + S3
        const punchRes = await AttendanceModel.recordPunch({
          tenantId,
          employeeId: rec.employeeId,
          deviceSerial: serialNumber,
          deviceId: device.id,
          employeeDbId: employee.id,
          employeeName: employee.name,
          timestamp: rec.timestamp,
          state: rec.state,
          punchType: rec.punchType,
          rawData: rec.rawLine || rawBody,
        });

        if (punchRes.success && !punchRes.isDuplicate) {
          savedCount++;
        }
      } catch (err) {
        console.error(`[ADMS Push Item Error] ${rec.employeeId}:`, err.message);
      }
    }

    console.log(`✅ [ADMS Push Saved] ${savedCount} punches saved to DynamoDB for Tenant: ${tenantId}`);
    return {
      contentType: "text/plain",
      body: `OK: ${savedCount}`,
    };
  }

  /**
   * GET /iclock/getrequest or /getrequest
   * Polling endpoint for biometric hardware remote command execution
   */
  static async handleGetRequest(req) {
    const serialNumber = extractDeviceSN(req);
    const clientIp = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";

    if (serialNumber && serialNumber !== "UNKNOWN") {
      try {
        await DeviceModel.upsertHeartbeat({
          serialNumber,
          ipAddress: String(clientIp),
        });
      } catch (err) {
        // Heartbeat non-fatal
      }
    }

    return {
      contentType: "text/plain",
      body: "OK",
    };
  }
}

module.exports = AdmsService;
