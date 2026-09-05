require("dotenv").config();
const { ddb, TABLES, ScanCommand, DeleteCommand } = require("./models");

async function clearBiometricData() {
  console.log("================================================================");
  console.log("🧹 VERIFYING / CLEANING SWIFT AWS BIOMETRIC TABLES");
  console.log("================================================================");

  const tablesToClear = [
    TABLES.biometricLogs,
    TABLES.devices,
  ];

  for (const table of tablesToClear) {
    try {
      const scanRes = await ddb.send(new ScanCommand({ TableName: table }));
      const items = scanRes.Items || [];
      console.log(`Table "${table}": Found ${items.length} items`);

      for (const item of items) {
        await ddb.send(
          new DeleteCommand({
            TableName: table,
            Key: { tenantId: item.tenantId, id: item.id },
          })
        );
      }
      if (items.length > 0) {
        console.log(`✅ Cleared ${items.length} items from "${table}"`);
      }
    } catch (err) {
      console.log(`ℹ️ Table "${table}" status: ${err.message}`);
    }
  }

  console.log("================================================================");
}

clearBiometricData();
