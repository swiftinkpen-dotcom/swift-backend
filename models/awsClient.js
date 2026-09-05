const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  PutCommand, 
  DeleteCommand, 
  GetCommand, 
  QueryCommand, 
  BatchWriteCommand 
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient } = require("@aws-sdk/client-rekognition");
require("dotenv").config();

// AWS Credentials & Region Configuration
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "MOCK_KEY",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "MOCK_SECRET",
};
const region = process.env.AWS_REGION || "ap-south-1";
const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET || "swift-hrms-uploads";

// AWS SDK Clients
const ddbClient = new DynamoDBClient({ region, credentials });
const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true },
});
const s3 = new S3Client({ region, credentials });
const rekognition = new RekognitionClient({ region, credentials });

// DynamoDB Table Names Dictionary for Swift Platform
const TABLES = {
  // Super Admin Tables (Single Partition Key: id)
  tenants: "swift_super_admin_tenants",
  settings: "swift_super_admin_settings",
  plans: "swift_super_admin_plans",
  subscriptions: "swift_super_admin_subscriptions",

  // Multi-Tenant Company Tables (Composite Key: tenantId [HASH], id [RANGE])
  companyConfig: "swift_company_config",
  employees: "swift_company_employees",
  devices: "swift_company_devices",
  biometricLogs: "swift_company_biometric_logs",
  attendance: "swift_company_attendance",
  leaves: "swift_company_leaves",
  roles: "swift_company_roles",
};

/**
 * Ensures a single-key DynamoDB table exists (HASH key)
 */
async function ensureTable(tableName, keyName = "id") {
  try {
    await ddbClient.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === "ResourceNotFoundException" || err.__type?.includes("ResourceNotFoundException")) {
      console.log(`[DynamoDB] Table "${tableName}" not found. Creating table...`);
      const params = {
        TableName: tableName,
        KeySchema: [{ AttributeName: keyName, KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: keyName, AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      };
      await ddbClient.send(new CreateTableCommand(params));
      console.log(`[DynamoDB] Table "${tableName}" created successfully.`);
      return true;
    }
    console.error(`[DynamoDB] Error checking table "${tableName}":`, err.message);
    return false;
  }
}

/**
 * Ensures a composite-key DynamoDB table exists (HASH + RANGE keys)
 */
async function ensureCompositeTable(tableName, partitionKeyName = "tenantId", sortKeyName = "id") {
  try {
    await ddbClient.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === "ResourceNotFoundException" || err.__type?.includes("ResourceNotFoundException")) {
      console.log(`[DynamoDB] Composite table "${tableName}" not found. Creating table...`);
      const params = {
        TableName: tableName,
        KeySchema: [
          { AttributeName: partitionKeyName, KeyType: "HASH" },
          { AttributeName: sortKeyName, KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: partitionKeyName, AttributeType: "S" },
          { AttributeName: sortKeyName, AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      };
      await ddbClient.send(new CreateTableCommand(params));
      console.log(`[DynamoDB] Composite table "${tableName}" created successfully.`);
      return true;
    }
    console.error(`[DynamoDB] Error checking composite table "${tableName}":`, err.message);
    return false;
  }
}

/**
 * Upload base64 image (punch snapshot, employee avatar) to S3
 */
let bucketChecked = false;
async function uploadToS3(key, base64Data) {
  if (!base64Data || !base64Data.startsWith("data:")) {
    return base64Data; // Return as-is if already a URL or empty
  }

  if (!bucketChecked && process.env.AWS_ACCESS_KEY_ID) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET_NAME }));
      bucketChecked = true;
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404 || err.Code === "NoSuchBucket") {
        const createParams = { Bucket: S3_BUCKET_NAME };
        if (region !== "us-east-1") {
          createParams.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createParams));
        bucketChecked = true;
      }
    }
  }

  try {
    const base64Body = base64Data.split(";base64,").pop();
    const buffer = Buffer.from(base64Body, "base64");
    const mimeType = base64Data.substring(5, base64Data.indexOf(";"));

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );

    return `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
  } catch (error) {
    console.error("[S3] Upload failed, returning original data:", error.message);
    return base64Data;
  }
}

module.exports = {
  ddbClient,
  ddb,
  s3,
  rekognition,
  TABLES,
  S3_BUCKET_NAME,
  region,
  ensureTable,
  ensureCompositeTable,
  uploadToS3,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
};
