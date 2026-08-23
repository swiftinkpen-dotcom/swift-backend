require("dotenv").config();
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};
const region = process.env.AWS_REGION || "ap-south-1";

const client = new DynamoDBClient({ region, credentials });
const ddb = DynamoDBDocumentClient.from(client);

async function testGetTenantItems() {
  const tableName = "swift_company_employees";
  console.log("=== TESTING SCAN VS QUERY FOR TABLE:", tableName);
  const scanRes = await ddb.send(new ScanCommand({ TableName: tableName }));
  console.log("Scan items count:", scanRes.Items?.length);
  if (scanRes.Items?.length) {
    console.log("First item keys:", Object.keys(scanRes.Items[0]));
    console.log("First item sample:", scanRes.Items[0]);
  }
}

testGetTenantItems();
