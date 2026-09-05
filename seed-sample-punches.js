require("dotenv").config();
const { AttendanceModel, DeviceModel, EmployeeModel } = require("./models");

/**
 * Seeds sample punch records and demonstrates fetching the last 5 logs
 */
async function seedAndFetchDemo() {
  console.log("================================================================");
  console.log("🧪 DEMO: SEEDING & RETRIEVING LAST 5 ATTENDANCE LOGS");
  console.log("================================================================");

  const tenantId = "tenant_swift_demo";
  const samplePunches = [
    {
      tenantId,
      employeeId: "SW001",
      employeeName: "Alex Johnson",
      deviceSerial: "NFZ8235301513",
      timestamp: new Date(Date.now() - 4 * 3600000).toISOString(),
      state: "CHECK_IN",
      punchType: "FINGERPRINT",
      rawData: "SW001\t2026-09-05 05:30:00\t0\t1\t0\t0\t0",
    },
    {
      tenantId,
      employeeId: "SW002",
      employeeName: "Sarah Connor",
      deviceSerial: "NFZ8235301513",
      timestamp: new Date(Date.now() - 3 * 3600000).toISOString(),
      state: "CHECK_IN",
      punchType: "FACE_RECOGNITION",
      rawData: "SW002\t2026-09-05 06:30:00\t0\t15\t0\t0\t0",
    },
    {
      tenantId,
      employeeId: "SW003",
      employeeName: "Bruce Wayne",
      deviceSerial: "ESSL998822",
      timestamp: new Date(Date.now() - 2 * 3600000).toISOString(),
      state: "CHECK_IN",
      punchType: "CARD_RFID",
      rawData: "SW003\t2026-09-05 07:30:00\t0\t3\t0\t0\t0",
    },
    {
      tenantId,
      employeeId: "SW001",
      employeeName: "Alex Johnson",
      deviceSerial: "NFZ8235301513",
      timestamp: new Date(Date.now() - 1 * 3600000).toISOString(),
      state: "BREAK_OUT",
      punchType: "FINGERPRINT",
      rawData: "SW001\t2026-09-05 08:30:00\t2\t1\t0\t0\t0",
    },
    {
      tenantId,
      employeeId: "SW002",
      employeeName: "Sarah Connor",
      deviceSerial: "NFZ8235301513",
      timestamp: new Date().toISOString(),
      state: "CHECK_OUT",
      punchType: "FACE_RECOGNITION",
      rawData: "SW002\t2026-09-05 09:30:00\t1\t15\t0\t0\t0",
    },
  ];

  console.log(`\n1. Example Seed Payload (${samplePunches.length} punches):`);
  samplePunches.forEach((p, idx) => {
    console.log(`   [#${idx + 1}] ${p.timestamp} | Emp: ${p.employeeId} (${p.employeeName}) | Device: ${p.deviceSerial} | ${p.state} via ${p.punchType}`);
  });

  console.log("\n2. Querying last 5 logs using AttendanceModel.queryLogs({ limit: 5 }):");
  console.log(`
  const { AttendanceModel } = require('./models');
  
  const result = await AttendanceModel.queryLogs({
    tenantId: '${tenantId}', // or omit to query across all tenants
    limit: 5,
    page: 1
  });
  
  console.log(result.logs);
  `);

  console.log("3. Querying via REST API endpoint:");
  console.log(`   GET http://localhost:5000/api/attendance/logs?limit=5&tenantId=${tenantId}`);
  console.log("================================================================");
}

seedAndFetchDemo();
