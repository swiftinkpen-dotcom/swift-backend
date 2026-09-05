require("dotenv").config();
const { AttendanceModel, ddb, TABLES, ScanCommand } = require("./models");

async function fetchLast5Logs() {
  console.log("================================================================");
  console.log("📊 FETCHING LAST 5 ATTENDANCE / BIOMETRIC LOGS FROM AWS DYNAMODB");
  console.log("================================================================");

  try {
    // 1. Query via the AttendanceModel
    const result = await AttendanceModel.queryLogs({
      limit: 5,
    });

    console.log(`\n📋 Query Result via AttendanceModel (Total records found: ${result.pagination.total}):`);

    if (result.logs && result.logs.length > 0) {
      result.logs.forEach((log, index) => {
        console.log(`\n--- Log #${index + 1} ---`);
        console.log(`Log ID:         ${log.id}`);
        console.log(`Tenant ID:      ${log.tenantId}`);
        console.log(`Employee ID:    ${log.employeeId}`);
        console.log(`Employee Name:  ${log.employeeName || "N/A"}`);
        console.log(`Device Serial:  ${log.deviceSerial}`);
        console.log(`Timestamp:      ${log.timestamp}`);
        console.log(`State / Type:   ${log.state} (${log.punchType})`);
        if (log.photoUrl) console.log(`Photo URL:      ${log.photoUrl}`);
        if (log.rawData)  console.log(`Raw Line:       ${log.rawData}`);
      });
    } else {
      console.log("ℹ️ No biometric punch logs currently found in DynamoDB table 'swift_company_biometric_logs'.");

      // Check daily attendance table as well
      try {
        const attRes = await ddb.send(new ScanCommand({ TableName: TABLES.attendance, Limit: 5 }));
        if (attRes.Items && attRes.Items.length > 0) {
          console.log(`\nFound ${attRes.Items.length} daily attendance summary records in 'swift_company_attendance':`);
          attRes.Items.forEach((item, idx) => {
            console.log(`\n[Summary #${idx + 1}] ID: ${item.id} | Emp: ${item.employeeId} | Date: ${item.date} | In: ${item.inTime} | Out: ${item.outTime || "N/A"} | Status: ${item.status}`);
          });
        }
      } catch (attErr) {
        // Table may be empty or not yet seeded
      }
    }
    console.log("\n================================================================");
  } catch (err) {
    console.error("❌ Error fetching attendance logs:", err.message);
  }
}

fetchLast5Logs();
