/**
 * Best Practice Demonstration for Fetching Attendance Logs
 */
const { AttendanceModel } = require("./models");

async function bestPracticeExample() {
  console.log("================================================================");
  console.log("🏆 BEST PRACTICE RECOMMENDATIONS FOR SWIFT BACKEND");
  console.log("================================================================");

  console.log("\n🥇 1. FOR FRONTEND / WEB DASHBOARD / MOBILE APP (BEST CHOICE):");
  console.log("   Use the HTTP REST API Endpoint: GET /api/attendance/logs?limit=5");
  console.log("   Why? It handles CORS, Tenant Isolation Headers, and JSON formatting cleanly.");
  console.log("\n   Frontend fetch example:");
  console.log(`   const res = await fetch("/api/attendance/logs?limit=5", {
     headers: { "x-tenant-id": "your_tenant_id" }
   });
   const data = await res.json();
   console.log(data.logs);`);

  console.log("\n🥈 2. FOR BACKEND INTERNAL CODE / CRON JOBS / REPORT GENERATORS:");
  console.log("   Use the direct Model: AttendanceModel.queryLogs({ limit: 5 })");
  console.log("   Why? Direct in-memory access with zero HTTP overhead.");
  console.log("\n   Backend code example:");
  console.log(`   const { AttendanceModel } = require("./models");
   const { logs } = await AttendanceModel.queryLogs({ limit: 5 });`);
  console.log("================================================================");
}

bestPracticeExample();
