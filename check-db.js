require("dotenv").config();
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};
const region = process.env.AWS_REGION || "ap-south-1";

const client = new DynamoDBClient({ region, credentials });
const ddb = DynamoDBDocumentClient.from(client);

async function checkDatabase() {
  try {
    console.log("=== SCANNING DYNAMODB TABLES FOR EMPLOYEES ===");
    const res = await ddb.send(new ScanCommand({ TableName: "swift_company_employees" }));
    console.log(`Found ${res.Items?.length || 0} total employee items in 'swift_company_employees':`);
    
    if (res.Items && res.Items.length > 0) {
      res.Items.forEach((item, i) => {
        console.log(`\n--- Employee #${i + 1} ---`);
        console.log(`ID:`, item.id);
        console.log(`TenantId:`, item.tenantId);
        console.log(`EmpCode / Code:`, item.empCode || item.code);
        console.log(`Name:`, item.name);
        console.log(`Email:`, item.email);
        console.log(`Password:`, item.password);
        console.log(`Status:`, item.status);
      });
    } else {
      console.log("No items found in DynamoDB table 'swift_company_employees'.");
    }

    const sw001Match = res.Items?.find(item => {
      const c = (item.empCode || item.code || item.id || "").toLowerCase();
      const e = (item.email || "").toLowerCase();
      const p = item.password;
      return (c === "sw001" || e === "sw001") && p === "1234";
    });

    console.log("\n=== SEARCH RESULT FOR 'SW001' with pass '1234' ===");
    if (sw001Match) {
      console.log("MATCH FOUND in DynamoDB:", JSON.stringify(sw001Match, null, 2));
    } else {
      console.log("NO MATCH FOUND for SW001 / 1234 in DynamoDB table.");
    }
  } catch (err) {
    console.error("Error scanning DynamoDB table:", err?.message || err);
  }
}

checkDatabase();
