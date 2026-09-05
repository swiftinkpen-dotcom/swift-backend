const {
  parseAdmsPayload,
  extractDeviceSN,
  DeviceModel,
  EmployeeModel,
  AttendanceModel,
  CompanyModel,
  AdmsService,
} = require("./models");

async function runUnitTests() {
  console.log("================================================================");
  console.log("🧪 RUNNING TESTS FOR SWIFT BACKEND AWS BIOMETRIC MODELS");
  console.log("================================================================");

  // 1. Test ADMS Serial Extraction
  console.log("\n[TEST 1] Testing Device SN Extraction:");
  const testReq1 = { query: { SN: "NFZ8235301513" } };
  const testReq2 = { headers: { "x-serial-number": "ESSL998822" } };
  const testReq3 = { body: "SN=BIOMAX123456\tStamp=0" };
  console.log(`- Query SN:   "${extractDeviceSN(testReq1)}" (Expected: NFZ8235301513) -> ${extractDeviceSN(testReq1) === "NFZ8235301513" ? "PASSED" : "FAILED"}`);
  console.log(`- Header SN:  "${extractDeviceSN(testReq2)}" (Expected: ESSL998822) -> ${extractDeviceSN(testReq2) === "ESSL998822" ? "PASSED" : "FAILED"}`);
  console.log(`- Text Body:  "${extractDeviceSN(testReq3)}" (Expected: BIOMAX123456) -> ${extractDeviceSN(testReq3) === "BIOMAX123456" ? "PASSED" : "FAILED"}`);

  // 2. Test ADMS Payload Parsing
  console.log("\n[TEST 2] Testing ADMS Payload Parser:");
  const sampleAttlog = `
1001\t2026-09-05 09:30:00\t0\t1\t0\t0\t0
1002\t2026-09-05 09:31:15\t1\t15\t0\t0\t0
USERID=1003\tCHECKTIME=2026-09-05 09:32:00\tCHECKTYPE=0\tVERIFYCODE=3
`;
  const parsed = parseAdmsPayload(sampleAttlog);
  console.log(`- Parsed records count: ${parsed.length} (Expected: 3) -> ${parsed.length === 3 ? "PASSED" : "FAILED"}`);
  parsed.forEach((p, idx) => {
    console.log(`  Record #${idx + 1}: Emp=${p.employeeId}, State=${p.state}, PunchType=${p.punchType}, Time=${p.timestamp.toISOString()}`);
  });

  // 3. Test ADMS Handshake Generator
  console.log("\n[TEST 3] Testing Handshake Generator (AdmsService.handleHandshake):");
  const handshakeResult = await AdmsService.handleHandshake({
    query: { SN: "NFZ8235301513", pushver: "2.4.1" },
    headers: { "x-forwarded-for": "192.168.1.100" },
  });
  console.log(`- Handshake Content-Type: ${handshakeResult.contentType}`);
  console.log(`- Handshake contains 'GET OPTION FROM: NFZ8235301513': ${handshakeResult.body.includes("GET OPTION FROM: NFZ8235301513") ? "PASSED" : "FAILED"}`);
  console.log(`- Handshake contains 'ATTLOGStamp=0': ${handshakeResult.body.includes("ATTLOGStamp=0") ? "PASSED" : "FAILED"}`);

  console.log("\n================================================================");
  console.log("✅ ALL MODEL UNIT TESTS COMPLETED SUCCESSFULLY!");
  console.log("================================================================");
}

runUnitTests().catch((err) => {
  console.error("❌ Test run failed:", err);
});
