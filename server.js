require("dotenv").config();
const express = require("express");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, IndexFacesCommand, SearchFacesByImageCommand, CreateCollectionCommand, DescribeCollectionCommand } = require("@aws-sdk/client-rekognition");

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning", "x-tenant-id", "x-company-id"],
  })
);
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const PORT = process.env.PORT || 5000;

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};
const region = process.env.AWS_REGION || "ap-south-1";

// AWS SDK Connection
const client = new DynamoDBClient({ region, credentials });
const ddb = DynamoDBDocumentClient.from(client);

const s3 = new S3Client({ region, credentials });
const rekognition = new RekognitionClient({ region, credentials });

// Default SaaS Data definitions for seeding
const defaultWhiteLabel = {
  id: "whitelabel",
  brandName: "SWIFT AI",
  tagline: "Enterprise HR, Payroll & Compliance",
  primaryColor: "#4f46e5",
  secondaryColor: "#0ea5e9",
  pdfHeader: "Powered by SWIFT AI",
  pdfFooter: "Confidential — for internal use only",
  emailFromName: "SWIFT AI",
  emailFromAddress: "no-reply@swift.ai",
  supportEmail: "support@swift.ai",
  supportPhone: "+91 00000 00000",
  smtpHost: "smtp.swift.ai",
  smsGateway: "MSG91",
  whatsappGateway: "Gupshup",
  paymentGateway: "Razorpay",
  storageProvider: "Cloudflare R2",
  aiProvider: "OpenAI ChatGPT",
};

const defaultUpi = {
  id: "upi",
  payeeName: "SWIFT AI Technologies",
  upiId: "swiftai@icici",
  instructions: "Scan the QR with any UPI app (GPay, PhonePe, Paytm, BHIM). After payment, upload the screenshot for verification.",
  bankName: "ICICI Bank",
  accountNumber: "1234567890",
  ifsc: "ICIC0001234",
};

const defaultReminderConfig = {
  id: "reminder_config",
  advanceDays: [30, 15, 7, 3, 1],
  channels: { email: true, sms: false, whatsapp: false, push: true, banner: true },
  gracePeriodDays: 5,
  autoSuspend: true,
  penaltyPct: 2,
};

const defaultPlans = [
  {
    id: "plan-starter",
    name: "Starter",
    description: "Small teams getting started",
    cycle: "monthly",
    pricing: "per_employee",
    basePrice: 999,
    perEmployeePrice: 49,
    gstPct: 18,
    trialDays: 14,
    gracePeriodDays: 5,
    modules: {
      company: "enabled", employees: "enabled", attendance: "enabled",
      leave: "enabled", dashboard: "enabled", notifications: "enabled",
      payroll: "trial", ai_chat: "trial",
      ai_documents: "locked", ai_compliance: "locked", ai_payroll: "locked",
      performance: "locked", recruitment: "locked", api: "locked",
    },
    featureFlags: { "attendance.gps": true, "attendance.shifts": true, "attendance.ot": true },
    limits: { employees: 25, branches: 1, hrUsers: 2, adminUsers: 1, departments: 5, storageMB: 500, aiCredits: 100, pdfDownloads: 50, reports: 20, apiCalls: 0, notifications: 500, smsCredits: 100, emailCredits: 500, whatsappCredits: 50, ocrCredits: 20, documents: 100, attendanceDevices: 1 },
    active: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "plan-professional",
    name: "Professional",
    description: "Growing companies with multi-branch teams",
    cycle: "monthly",
    pricing: "per_employee",
    basePrice: 2499,
    perEmployeePrice: 79,
    gstPct: 18,
    trialDays: 14,
    gracePeriodDays: 5,
    modules: {
      company: "enabled", employees: "enabled", attendance: "enabled",
      leave: "enabled", dashboard: "enabled", notifications: "enabled",
      payroll: "enabled", ai_chat: "enabled", ai_documents: "enabled",
      ai_compliance: "trial", api: "trial", recruitment: "enabled",
      performance: "enabled", asset: "enabled",
    },
    featureFlags: { "attendance.gps": true, "attendance.shifts": true, "attendance.ot": true, "attendance.face": true, "api.access": true },
    limits: { employees: 150, branches: 5, hrUsers: 5, adminUsers: 3, departments: 20, storageMB: 5000, aiCredits: 1000, pdfDownloads: 500, reports: 200, apiCalls: 10000, notifications: 5000, smsCredits: 1000, emailCredits: 5000, whatsappCredits: 500, ocrCredits: 200, documents: 1000, attendanceDevices: 5 },
    active: true,
    createdAt: new Date().toISOString(),
  },
];

const defaultCoupons = [
  { id: "cpn-welcome", code: "WELCOME10", kind: "percent", value: 10, maxUses: -1, used: 0, active: true },
  { id: "cpn-launch", code: "LAUNCH25", kind: "percent", value: 25, maxUses: 100, used: 0, active: true, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
];

const defaultReferralPrograms = [
  {
    id: "ref-standard",
    name: "Standard Referral",
    active: true,
    tiers: [
      { referrals: 1, rewardKind: "discount_pct", value: 5 },
      { referrals: 5, rewardKind: "discount_pct", value: 10 },
      { referrals: 10, rewardKind: "discount_pct", value: 20 },
      { referrals: 25, rewardKind: "ai_credits", value: 5000 },
    ],
  },
];

const defaultCompanyRoles = (tenantId) => [
  {
    id: "role-hr-manager",
    tenantId,
    name: "HR Manager",
    description: "Full access to employee management, leaves, attendance, documents, and onboarding.",
    isSystemDefault: true,
    createdAt: new Date().toISOString(),
    permissions: {
      leaveApproval: true,
      attendanceApproval: true,
      payrollDashboard: true,
      employeeManagement: true,
      expenseHandloanApproval: true,
      documentsApproval: true,
      documentTypes: {
        offerLetter: true,
        appointmentLetter: true,
        incrementLetter: true,
        promotionLetter: true,
        relievingLetter: true,
        experienceLetter: true,
        salaryCertificate: true,
        warningLetter: true,
        showCauseNotice: true,
      },
      invoiceApproval: true,
      resignationApproval: true,
      assetManagement: true,
      noticesAnnouncements: true,
      performanceReviews: true,
      auditLogView: true,
    },
  },
  {
    id: "role-team-lead",
    tenantId,
    name: "Team Lead / Reporting Manager",
    description: "Leave approval, attendance verification, performance reviews, and document approvals.",
    isSystemDefault: true,
    createdAt: new Date().toISOString(),
    permissions: {
      leaveApproval: true,
      attendanceApproval: true,
      payrollDashboard: false,
      employeeManagement: false,
      expenseHandloanApproval: true,
      documentsApproval: true,
      documentTypes: {
        offerLetter: false,
        appointmentLetter: false,
        incrementLetter: true,
        promotionLetter: true,
        relievingLetter: true,
        experienceLetter: true,
        salaryCertificate: false,
        warningLetter: true,
        showCauseNotice: false,
      },
      invoiceApproval: false,
      resignationApproval: true,
      assetManagement: false,
      noticesAnnouncements: true,
      performanceReviews: true,
      auditLogView: false,
    },
  },
  {
    id: "role-finance-manager",
    tenantId,
    name: "Finance / Payroll Manager",
    description: "Payroll dashboard access, expense & handloan approvals, and invoice approvals.",
    isSystemDefault: true,
    createdAt: new Date().toISOString(),
    permissions: {
      leaveApproval: false,
      attendanceApproval: false,
      payrollDashboard: true,
      employeeManagement: false,
      expenseHandloanApproval: true,
      documentsApproval: true,
      documentTypes: {
        offerLetter: false,
        appointmentLetter: false,
        incrementLetter: true,
        promotionLetter: false,
        relievingLetter: false,
        experienceLetter: false,
        salaryCertificate: true,
        warningLetter: false,
        showCauseNotice: false,
      },
      invoiceApproval: true,
      resignationApproval: false,
      assetManagement: false,
      noticesAnnouncements: false,
      performanceReviews: false,
      auditLogView: true,
    },
  },
  {
    id: "role-general-employee",
    tenantId,
    name: "General Employee",
    description: "Standard self-service employee access.",
    isSystemDefault: true,
    createdAt: new Date().toISOString(),
    permissions: {
      leaveApproval: false,
      attendanceApproval: false,
      payrollDashboard: false,
      employeeManagement: false,
      expenseHandloanApproval: false,
      documentsApproval: false,
      documentTypes: {
        offerLetter: false,
        appointmentLetter: false,
        incrementLetter: false,
        promotionLetter: false,
        relievingLetter: false,
        experienceLetter: false,
        salaryCertificate: false,
        warningLetter: false,
        showCauseNotice: false,
      },
      invoiceApproval: false,
      resignationApproval: false,
      assetManagement: false,
      noticesAnnouncements: false,
      performanceReviews: false,
      auditLogView: false,
    },
  },
];

const defaultCompanyHolidays = (tenantId) => [
  { id: "hol-1", tenantId, name: "Republic Day", date: "2026-01-26", type: "National Holiday", branchIds: ["all"], isMandatory: true, description: "National Republic Day Celebration" },
  { id: "hol-2", tenantId, name: "Holi", date: "2026-03-25", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Festival of Colors" },
  { id: "hol-3", tenantId, name: "Good Friday", date: "2026-04-10", type: "Public Holiday", branchIds: ["all"], isMandatory: true, description: "Christian Public Holiday" },
  { id: "hol-4", tenantId, name: "Tamil New Year / Ambedkar Jayanti", date: "2026-04-14", type: "Public Holiday", branchIds: ["all"], isMandatory: true, description: "State & National Holiday" },
  { id: "hol-5", tenantId, name: "Labor Day / May Day", date: "2026-05-01", type: "Public Holiday", branchIds: ["all"], isMandatory: true, description: "International Workers' Day" },
  { id: "hol-6", tenantId, name: "Bakrid / Eid al-Adha", date: "2026-06-17", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Islamic Festival of Sacrifice" },
  { id: "hol-7", tenantId, name: "Independence Day", date: "2026-08-15", type: "National Holiday", branchIds: ["all"], isMandatory: true, description: "National Independence Day celebration" },
  { id: "hol-8", tenantId, name: "Ganesh Chaturthi", date: "2026-09-04", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Vinayaka Chaturthi Festival" },
  { id: "hol-9", tenantId, name: "Gandhi Jayanti", date: "2026-10-02", type: "National Holiday", branchIds: ["all"], isMandatory: true, description: "Mahatma Gandhi's Birthday" },
  { id: "hol-10", tenantId, name: "Ayudha Pooja / Vijaya Dashami", date: "2026-10-20", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Dussehra Celebrations" },
  { id: "hol-11", tenantId, name: "Diwali (Deepavali)", date: "2026-11-01", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Festival of Lights" },
  { id: "hol-12", tenantId, name: "Christmas Day", date: "2026-12-25", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Christmas Day Celebration" },
  { id: "hol-13", tenantId, name: "New Year's Day", date: "2027-01-01", type: "Optional Holiday", branchIds: ["all"], isMandatory: false, description: "New Year Day (Floating / Optional Holiday)" },
  { id: "hol-14", tenantId, name: "Pongal / Makar Sankranti", date: "2027-01-14", type: "Festival Holiday", branchIds: ["all"], isMandatory: true, description: "Traditional Harvest Festival" },
];

// Helper to check and create DynamoDB table
async function ensureTable(tableName, keyName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`[DynamoDB] Table "${tableName}" checked successfully.`);
  } catch (err) {
    if (err.name === "ResourceNotFoundException" || err.__type?.includes("ResourceNotFoundException")) {
      console.log(`[DynamoDB] Table "${tableName}" not found. Creating...`);
      const params = {
        TableName: tableName,
        KeySchema: [{ AttributeName: keyName, KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: keyName, AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      };
      await client.send(new CreateTableCommand(params));
      console.log(`[DynamoDB] Table "${tableName}" created.`);
    } else {
      console.error(`[DynamoDB] Error verifying table "${tableName}":`, err);
      throw err;
    }
  }
}

// Database Initialization Checklist
const TABLES = {
  tickets: "swift_super_admin_tickets",
  touchpoints: "swift_super_admin_touchpoints",
  checklists: "swift_super_admin_checklists",
  impersonations: "swift_super_admin_impersonations",
  settings: "swift_super_admin_settings",
  payments: "swift_super_admin_payments",
  plans: "swift_super_admin_plans",
  subscriptions: "swift_super_admin_subscriptions",
  invoices: "swift_super_admin_invoices",
  audit: "swift_super_admin_audit",
  reminder_log: "swift_super_admin_reminder_log",
  coupons: "swift_super_admin_coupons",
  referrals: "swift_super_admin_referrals",
  referral_programs: "swift_super_admin_referral_programs",
  tenants: "swift_super_admin_tenants",
};

const COMPANY_TABLES = {
  config: "swift_company_config",
  employees: "swift_company_employees",
  attendance: "swift_company_attendance",
  leaves: "swift_company_leaves",
  payrolls: "swift_company_payrolls",
  assets: "swift_company_assets",
  assetAssignments: "swift_company_asset_assignments",
  docLibrary: "swift_company_doc_library",
  journeys: "swift_company_journeys",
  notices: "swift_company_notices",
  docAssets: "swift_company_doc_assets",
  roles: "swift_company_roles",
  docRequests: "swift_company_doc_requests",
  holidays: "swift_company_holidays",
  roster: "swift_company_roster",
};

// Helper to check and create a composite key table (HASH + RANGE)
async function ensureCompositeTable(tableName, partitionKeyName, sortKeyName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`[DynamoDB] Table "${tableName}" checked successfully.`);
  } catch (err) {
    if (err.name === "ResourceNotFoundException" || err.__type?.includes("ResourceNotFoundException")) {
      console.log(`[DynamoDB] Table "${tableName}" not found. Creating composite table...`);
      const params = {
        TableName: tableName,
        KeySchema: [
          { AttributeName: partitionKeyName, KeyType: "HASH" },
          { AttributeName: sortKeyName, KeyType: "RANGE" }
        ],
        AttributeDefinitions: [
          { AttributeName: partitionKeyName, AttributeType: "S" },
          { AttributeName: sortKeyName, AttributeType: "S" }
        ],
        BillingMode: "PAY_PER_REQUEST",
      };
      await client.send(new CreateTableCommand(params));
      console.log(`[DynamoDB] Composite table "${tableName}" created.`);
    } else {
      console.error(`[DynamoDB] Error verifying composite table "${tableName}":`, err);
      throw err;
    }
  }
}

async function initDB() {
  console.log("[DynamoDB] Connecting and verifying tables...");
  await ensureTable(TABLES.tickets, "id");
  await ensureTable(TABLES.touchpoints, "id");
  await ensureTable(TABLES.checklists, "tenantId");
  await ensureTable(TABLES.impersonations, "id");
  await ensureTable(TABLES.settings, "id");
  await ensureTable(TABLES.payments, "id");
  await ensureTable(TABLES.plans, "id");
  await ensureTable(TABLES.subscriptions, "id");
  await ensureTable(TABLES.invoices, "id");
  await ensureTable(TABLES.audit, "id");
  await ensureTable(TABLES.reminder_log, "id");
  await ensureTable(TABLES.coupons, "id");
  await ensureTable(TABLES.referrals, "tenantId");
  await ensureTable(TABLES.referral_programs, "id");
  await ensureTable(TABLES.tenants, "id");

  // Verify composite tables for Company Admin Portal
  for (const table of Object.values(COMPANY_TABLES)) {
    await ensureCompositeTable(table, "tenantId", "id");
  }
  console.log("[DynamoDB] Database structure is healthy.");
}

// Company Admin Helpers & Endpoints
async function getTenantItems(tableName, tenantId) {
  try {
    const command = new QueryCommand({
      KeyConditionExpression: "tenantId = :tId",
      ExpressionAttributeValues: { ":tId": tenantId },
      TableName: tableName,
    });
    const res = await ddb.send(command);
    const items = res.Items || [];
    return items.filter(item => item.tenantId === tenantId);
  } catch (err) {
    console.warn(`[DynamoDB] QueryCommand failed on ${tableName}:`, err?.message || err);
    try {
      const scanRes = await ddb.send(new ScanCommand({ TableName: tableName }));
      const items = scanRes.Items || [];
      return items.filter(item => item.tenantId === tenantId);
    } catch (scanErr) {
      console.warn(`[DynamoDB] Fallback ScanCommand failed on ${tableName}:`, scanErr?.message || scanErr);
    }
  }
  return [];
}

const BUCKET_NAME = process.env.AWS_S3_BUCKET || "swift-hrms-uploads";

let bucketChecked = false;
async function ensureS3Bucket() {
  if (bucketChecked || !process.env.AWS_ACCESS_KEY_ID) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    bucketChecked = true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404 || err.Code === "NoSuchBucket" || err.name === "NoSuchBucket") {
      console.log(`[S3] Bucket "${BUCKET_NAME}" not found. Creating bucket...`);
      try {
        const createParams = { Bucket: BUCKET_NAME };
        if (region !== "us-east-1") {
          createParams.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createParams));
        console.log(`[S3] Bucket "${BUCKET_NAME}" created successfully.`);
        bucketChecked = true;
      } catch (createErr) {
        console.error(`[S3] Error creating bucket "${BUCKET_NAME}":`, createErr?.message || createErr);
      }
    } else {
      console.warn(`[S3] Bucket check warning:`, err?.message || err);
      bucketChecked = true;
    }
  }
}

async function uploadToS3(key, base64Data) {
  if (!base64Data || !base64Data.startsWith("data:")) {
    return base64Data; // Already a URL or empty
  }
  await ensureS3Bucket();
  try {
    const base64Body = base64Data.split(";base64,").pop();
    const buffer = Buffer.from(base64Body, "base64");
    const mimeType = base64Data.substring(5, base64Data.indexOf(";"));

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });

    await s3.send(command);
    return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
  } catch (error) {
    console.error("[S3] Upload failed, falling back to inline base64:", error);
    return base64Data;
  }
}

async function ensureCollection(collectionId) {
  if (!process.env.AWS_ACCESS_KEY_ID) return;
  try {
    await rekognition.send(new DescribeCollectionCommand({ CollectionId: collectionId }));
  } catch (err) {
    if (err.name === "ResourceNotFoundException") {
      console.log(`[Rekognition] Creating face collection: ${collectionId}`);
      await rekognition.send(new CreateCollectionCommand({ CollectionId: collectionId }));
    } else {
      throw err;
    }
  }
}

// 1. Initial State Load
app.get("/api/companies/initial-state", async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  try {
    const [
      config, employees, attendance, leaves, payrolls,
      assets, assignments, docLibrary, journeys, notices, docAssets, roles, docRequests, holidays, roster
    ] = await Promise.all([
      getTenantItems(COMPANY_TABLES.config, tenantId),
      getTenantItems(COMPANY_TABLES.employees, tenantId),
      getTenantItems(COMPANY_TABLES.attendance, tenantId),
      getTenantItems(COMPANY_TABLES.leaves, tenantId),
      getTenantItems(COMPANY_TABLES.payrolls, tenantId),
      getTenantItems(COMPANY_TABLES.assets, tenantId),
      getTenantItems(COMPANY_TABLES.assetAssignments, tenantId),
      getTenantItems(COMPANY_TABLES.docLibrary, tenantId),
      getTenantItems(COMPANY_TABLES.journeys, tenantId),
      getTenantItems(COMPANY_TABLES.notices, tenantId),
      getTenantItems(COMPANY_TABLES.docAssets, tenantId),
      getTenantItems(COMPANY_TABLES.roles, tenantId),
      getTenantItems(COMPANY_TABLES.docRequests, tenantId),
      getTenantItems(COMPANY_TABLES.holidays, tenantId),
      getTenantItems(COMPANY_TABLES.roster, tenantId),
    ]);

    let companyConfig = config.find((c) => c.id === "config") || null;
    let companyDocAssets = docAssets.find((d) => d.id === "doc_assets") || docAssets[0] || null;
    if (!companyConfig) {
      console.log(`[Database] Seeding default company config for tenant: ${tenantId}`);
      let tenantName = "SWIFT Company";
      let tenantAddress = "";
      try {
        const tenantRes = await ddb.send(new GetCommand({ TableName: TABLES.tenants, Key: { id: tenantId } }));
        if (tenantRes.Item) {
          tenantName = tenantRes.Item.name || "SWIFT Company";
          tenantAddress = tenantRes.Item.address || "";
        }
      } catch (err) {
        console.warn(`[Database] Failed to fetch tenant details:`, err.message);
      }

      companyConfig = {
        id: "config",
        tenantId,
        name: tenantName,
        legalName: tenantName,
        address: tenantAddress,
        branches: [
          {
            id: "br-hq",
            name: "Head Office",
            code: "HQ",
            isHead: true,
            radiusMeters: 100,
            lat: 11.305639,
            lng: 77.703474,
            weeklyOff: [],
            wifiSSIDs: [],
            ipAllowlist: [],
            geofenceDisabled: false,
          }
        ],
        shifts: [
          { id: "gen", name: "General", start: "09:00", end: "18:00", allowancePerDay: 0 }
        ],
        leaveTypes: [
          { id: "cl", name: "Casual Leave", days: 12 },
          { id: "sl", name: "Sick Leave", days: 12 },
          { id: "el", name: "Earned Leave", days: 15 }
        ],
        attendanceDefaults: [
          {
            id: "apd-default",
            name: "Default (All Employees)",
            priority: 0,
            match: {},
            shiftId: "gen",
            weeklyOff: ["Sun"],
            leaveTypeIds: ["cl", "sl", "el"],
            geofenceFromBranch: true,
            payrollGroup: "Monthly",
            costCentre: "General",
            holidayCalendar: "India-Standard"
          }
        ]
      };
      await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.config, Item: companyConfig }));
    }

    let tenantRoles = roles;
    if (!tenantRoles || tenantRoles.length === 0) {
      console.log(`[Database] Seeding default roles for tenant: ${tenantId}`);
      tenantRoles = defaultCompanyRoles(tenantId);
      for (const r of tenantRoles) {
        try {
          await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.roles, Item: r }));
        } catch (err) {
          console.warn(`[Database] Error seeding role "${r.name}":`, err.message);
        }
      }
    }

    let tenantHolidays = holidays;
    if (!tenantHolidays || tenantHolidays.length === 0) {
      console.log(`[Database] Seeding default company holidays for tenant: ${tenantId}`);
      tenantHolidays = defaultCompanyHolidays(tenantId);
      for (const h of tenantHolidays) {
        try {
          await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.holidays, Item: h }));
        } catch (err) {
          console.warn(`[Database] Error seeding holiday "${h.name}":`, err.message);
        }
      }
    }

    res.json({
      config: companyConfig,
      docAssets: companyDocAssets,
      employees,
      attendance,
      leaves,
      payrolls,
      assets,
      assignments,
      docLibrary,
      journeys,
      notices,
      roles: tenantRoles,
      docRequests,
      holidays: tenantHolidays,
      roster: roster || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper to check if a role permissions allow approving a given document type
function canRoleApproveDoc(role, letterKey) {
  if (!role || !role.permissions) return false;
  if (!role.permissions.documentsApproval) return false;
  const docTypes = role.permissions.documentTypes;
  if (!docTypes) return true;

  const key = (letterKey || "").toLowerCase().replace(/[^a-z]/g, "");
  if (key.includes("offer")) return !!docTypes.offerLetter;
  if (key.includes("appoint")) return !!docTypes.appointmentLetter;
  if (key.includes("increment")) return !!docTypes.incrementLetter;
  if (key.includes("promot")) return !!docTypes.promotionLetter;
  if (key.includes("reliev")) return !!docTypes.relievingLetter;
  if (key.includes("experien")) return !!docTypes.experienceLetter;
  if (key.includes("salary") || key.includes("certif")) return !!docTypes.salaryCertificate;
  if (key.includes("warn")) return !!docTypes.warningLetter;
  if (key.includes("show") || key.includes("cause")) return !!docTypes.showCauseNotice;

  return true;
}

// Helper function to format numbers to Indian English Words
function numberToWordsIndianBackend(num) {
  const val = Math.round(num || 0);
  if (val <= 0) return "Rupees Zero Only";

  const a = ["", "One ", "Two ", "Three ", "Four ", "Five ", "Six ", "Seven ", "Eight ", "Nine ", "Ten ", "Eleven ", "Twelve ", "Thirteen ", "Fourteen ", "Fifteen ", "Sixteen ", "Seventeen ", "Eighteen ", "Nineteen "];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const inWords = (n) => {
    let str = "";
    if (n > 99) { str += a[Math.floor(n / 100)] + "Hundred "; n %= 100; }
    if (n > 19) { str += b[Math.floor(n / 10)] + (n % 10 !== 0 ? " " + a[n % 10] : " "); }
    else if (n > 0) { str += a[n]; }
    return str;
  };

  let temp = val;
  const crore = Math.floor(temp / 10000000); temp %= 10000000;
  const lakh = Math.floor(temp / 100000); temp %= 100000;
  const thousand = Math.floor(temp / 1000); temp %= 1000;
  const remainder = Math.floor(temp);

  let res = "";
  if (crore > 0) res += inWords(crore) + "Crore ";
  if (lakh > 0) res += inWords(lakh) + "Lakh ";
  if (thousand > 0) res += inWords(thousand) + "Thousand ";
  if (remainder > 0) res += inWords(remainder);

  return "Rupees " + res.trim() + " Only";
}

// 1a-2. Download Official Payslip Binary PDF for Device Storage
app.get("/api/payroll/download-payslip", async (req, res) => {
  const { tenantId, employeeId, month } = req.query;
  if (!tenantId || !employeeId) {
    return res.status(400).send("tenantId and employeeId required");
  }

  try {
    const [employees, config, payrolls, attendance] = await Promise.all([
      getTenantItems(COMPANY_TABLES.employees, tenantId),
      getTenantItems(COMPANY_TABLES.config, tenantId),
      getTenantItems(COMPANY_TABLES.payrolls, tenantId),
      getTenantItems(COMPANY_TABLES.attendance, tenantId),
    ]);

    const employee = employees.find((e) => e.id === employeeId || e.empCode === employeeId || e.name === employeeId) || employees[0];
    const company = config.find((c) => c.id === "config") || {};
    const monthStr = month || new Date().toISOString().slice(0, 7);

    let p = payrolls.find((pr) => (pr.employeeId === employeeId || pr.employeeId === employee?.empCode) && pr.month === monthStr);

    let gross = 0, net = 0, totalDeductions = 0, daysWorked = 26, earningsList = [], deductions = {};
    if (p && p.computed) {
      gross = p.computed.gross;
      net = p.computed.net;
      totalDeductions = p.computed.totalDeductions;
      daysWorked = p.daysWorked || 26;
      earningsList = p.computed.earningsList || [];
      deductions = p.computed.deductions || {};
    } else {
      const wd = company.workingDaysPerMonth || 26;
      const userLogs = attendance.filter((a) => (a.employeeId === employee?.id || a.employeeName === employee?.name) && a.date && a.date.startsWith(monthStr));
      const presentDays = userLogs.filter((a) => a.status === "present").length;
      daysWorked = userLogs.length > 0 ? presentDays : wd;
      const prorateFactor = wd > 0 ? daysWorked / wd : 1;

      const fixedGross = employee?.basic || employee?.fixedSalary || 45000;
      const hourly = fixedGross / (wd * 8);
      const otHours = userLogs.reduce((s, a) => s + (Number(a.otHours) || 0), 0);
      const otPay = Math.round(hourly * otHours * 1.5);

      const basicPct = company.basicPct || 20;
      const earnedBasic = Math.round(fixedGross * (basicPct / 100) * prorateFactor);

      const daPct = company.daPct || 13.33;
      const earnedDA = company.daEnabled !== false ? Math.round(fixedGross * (daPct / 100) * prorateFactor) : 0;

      const hraPct = company.hraPct || 16.67;
      const earnedHRA = company.hraEnabled !== false ? Math.round(fixedGross * (hraPct / 100) * prorateFactor) : 0;

      const oaPct = company.oaPct || 16.67;
      const earnedOA = company.oaEnabled !== false ? Math.round(fixedGross * (oaPct / 100) * prorateFactor) : 0;

      const caPct = company.caPct || 16.67;
      const earnedCA = company.caEnabled !== false ? Math.round(fixedGross * (caPct / 100) * prorateFactor) : 0;

      const ltaPct = company.ltaPct || 16.67;
      const earnedLTA = company.ltaEnabled !== false ? Math.round(fixedGross * (ltaPct / 100) * prorateFactor) : 0;

      gross = earnedBasic + earnedDA + earnedHRA + earnedOA + earnedCA + earnedLTA + otPay;

      const pf = employee?.pfEligible !== false ? Math.min(1800, Math.round(earnedBasic * 0.12)) : 0;
      const esi = employee?.esiEligible !== false && fixedGross <= 21000 ? Math.round(gross * 0.0075) : 0;
      const pt = employee?.ptEligible !== false ? (gross > 20000 ? 200 : gross > 15000 ? 150 : 0) : 0;
      const tds = employee?.tdsEligible !== false ? Math.round(gross * 0.05) : 0;

      totalDeductions = pf + esi + pt + tds;
      net = Math.max(0, gross - totalDeductions);

      earningsList = [
        { name: "Basic Pay", amount: earnedBasic },
        ...(earnedDA > 0 ? [{ name: "Dearness Allowance (DA)", amount: earnedDA }] : []),
        ...(earnedHRA > 0 ? [{ name: "House Rent Allowance (HRA)", amount: earnedHRA }] : []),
        ...(earnedOA > 0 ? [{ name: "Special Allowance", amount: earnedOA }] : []),
        ...(earnedCA > 0 ? [{ name: "Conveyance Allowance (CA)", amount: earnedCA }] : []),
        ...(earnedLTA > 0 ? [{ name: "Leave Travel Allowance (LTA)", amount: earnedLTA }] : []),
        ...(otPay > 0 ? [{ name: "Overtime Pay Bonus", amount: otPay }] : []),
      ];

      deductions = { employeePF: pf, employeeESI: esi, professionalTax: pt, tds };
    }

    // Set genuine PDF binary response headers so Android OS saves file to device storage
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Payslip_${employee?.empCode || "EMP"}_${monthStr}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 30 });
    doc.pipe(res);

    // 1. Corporate Navy Header Bar (#0F172A)
    doc.rect(0, 0, 595.28, 70).fill("#0F172A");

    doc.fillColor("#FFFFFF").fontSize(16).font("Helvetica-Bold").text((company.companyName || "SWIFT HRMS").toUpperCase(), 30, 18);
    doc.fillColor("#CBD5E1").fontSize(9).font("Helvetica").text(company.legalName || company.companyName || "Corporate Enterprise Ltd", 30, 38);

    doc.fillColor("#FFFFFF").fontSize(14).font("Helvetica-Bold").text("SALARY PAYSLIP", 380, 18, { align: "right", width: 185 });
    doc.fillColor("#38BDF8").fontSize(10).font("Helvetica-Bold").text(monthStr.toUpperCase(), 380, 38, { align: "right", width: 185 });

    let y = 90;

    // 2. Metadata Box Table
    doc.rect(30, y, 535.28, 95).fillAndStroke("#F8FAFC", "#CBD5E1");
    doc.fillColor("#0F172A");

    const metaRows = [
      [{ label: "EMPLOYEE NAME", val: employee?.name || "Employee" }, { label: "EMPLOYEE CODE", val: employee?.empCode || "SW001" }],
      [{ label: "DESIGNATION", val: employee?.designation || "Software Engineer" }, { label: "DEPARTMENT", val: employee?.department || "Engineering" }],
      [{ label: "DATE OF JOINING", val: employee?.joiningDate || employee?.doj || "Jan 15, 2024" }, { label: "PAN NUMBER", val: employee?.panNumber || employee?.pan || "ABCDE1234F" }],
      [{ label: "BANK ACCOUNT", val: employee?.bankAccount || "Registered Salary A/C" }, { label: "BANK IFSC", val: employee?.bankIfsc || "HDFC0001234" }],
      [{ label: "WORKING DAYS", val: `${company.workingDaysPerMonth || 26} Days` }, { label: "PRESENT DAYS", val: `${daysWorked} Days` }],
    ];

    let metaY = y + 8;
    for (const row of metaRows) {
      doc.fillColor("#64748B").fontSize(8).font("Helvetica-Bold").text(row[0].label, 40, metaY);
      doc.fillColor("#0F172A").fontSize(9).font("Helvetica-Bold").text(row[0].val, 130, metaY);

      doc.fillColor("#64748B").fontSize(8).font("Helvetica-Bold").text(row[1].label, 310, metaY);
      doc.fillColor("#0F172A").fontSize(9).font("Helvetica-Bold").text(row[1].val, 410, metaY);

      metaY += 17;
    }

    y += 115;

    // 3. Itemized Tables Header
    doc.rect(30, y, 260, 22).fill("#0F172A");
    doc.fillColor("#FFFFFF").fontSize(9).font("Helvetica-Bold").text("EARNINGS COMPONENT", 38, y + 6);
    doc.text("AMOUNT", 220, y + 6, { align: "right", width: 60 });

    doc.rect(305, y, 260, 22).fill("#0F172A");
    doc.fillColor("#FFFFFF").fontSize(9).font("Helvetica-Bold").text("DEDUCTION COMPONENT", 313, y + 6);
    doc.text("AMOUNT", 495, y + 6, { align: "right", width: 60 });

    y += 26;

    // Itemized Rows
    const dedList = [];
    if (deductions.employeePF > 0) dedList.push({ name: "Provident Fund (PF)", amount: deductions.employeePF });
    if (deductions.employeeESI > 0) dedList.push({ name: "Employee State Insurance (ESI)", amount: deductions.employeeESI });
    if (deductions.professionalTax > 0) dedList.push({ name: "Professional Tax (PT)", amount: deductions.professionalTax });
    if (deductions.tds > 0) dedList.push({ name: "Income Tax (TDS)", amount: deductions.tds });

    const maxRows = Math.max(earningsList.length, dedList.length, 1);
    for (let i = 0; i < maxRows; i++) {
      const earn = earningsList[i];
      const ded = dedList[i];

      if (earn) {
        doc.fillColor("#334155").fontSize(9).font("Helvetica").text(earn.name, 38, y);
        doc.fillColor("#0F172A").fontSize(9).font("Helvetica-Bold").text(`Rs. ${Math.round(earn.amount).toLocaleString('en-IN')}`, 210, y, { align: "right", width: 70 });
      }

      if (ded) {
        doc.fillColor("#334155").fontSize(9).font("Helvetica").text(ded.name, 313, y);
        doc.fillColor("#E11D48").fontSize(9).font("Helvetica-Bold").text(`-Rs. ${Math.round(ded.amount).toLocaleString('en-IN')}`, 485, y, { align: "right", width: 70 });
      }

      y += 18;
    }

    y += 10;

    // Summary Bar
    doc.rect(30, y, 535.28, 25).fillAndStroke("#F1F5F9", "#CBD5E1");
    doc.fillColor("#0F172A").fontSize(10).font("Helvetica-Bold").text(`Total Gross Earnings: Rs. ${Math.round(gross).toLocaleString('en-IN')}`, 40, y + 7);
    doc.fillColor("#E11D48").fontSize(10).font("Helvetica-Bold").text(`Total Deductions: -Rs. ${Math.round(totalDeductions).toLocaleString('en-IN')}`, 320, y + 7, { align: "right", width: 235 });

    y += 38;

    // 4. Net Salary Payable Box (#0F172A)
    doc.rect(30, y, 535.28, 55).fill("#0F172A");
    doc.fillColor("#94A3B8").fontSize(10).font("Helvetica-Bold").text("NET TAKE-HOME SALARY PAYABLE", 45, y + 12);
    doc.fillColor("#FFFFFF").fontSize(18).font("Helvetica-Bold").text(`Rs. ${Math.round(net).toLocaleString('en-IN')}`, 320, y + 10, { align: "right", width: 230 });

    doc.fillColor("#CBD5E1").fontSize(9).font("Helvetica-Oblique").text(`Amount in Words: ${numberToWordsIndianBackend(net)}`, 45, y + 36);

    y += 75;

    // 5. Compliance Disclaimer Footer
    doc.moveTo(30, y).lineTo(565.28, y).strokeColor("#CBD5E1").stroke();
    y += 10;

    doc.fillColor("#64748B").fontSize(8).font("Helvetica").text("This is an official computer-generated payslip issued via SWIFT HRMS and does not require a physical signature.", 30, y, { align: "center", width: 535 });
    doc.fillColor("#94A3B8").fontSize(7.5).font("Helvetica").text(`Generated on ${new Date().toLocaleString()} · Confidential & Privileged Document`, 30, y + 14, { align: "center", width: 535 });

    doc.end();
  } catch (err) {
    res.status(500).send("Error generating payslip: " + err.message);
  }
});

// Helper to emit real-time company notices
async function createCompanyNotice(tenantId, { title, description, category, targetRole, targetEmployeeId, link }) {
  try {
    const noticeItem = {
      id: "notic-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
      tenantId,
      title,
      description,
      category: category || "announcement",
      targetRole: targetRole || "all",
      targetEmployeeId: targetEmployeeId || null,
      link: link || null,
      date: new Date().toISOString().split("T")[0],
      createdAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.notices, Item: noticeItem }));
    return noticeItem;
  } catch (err) {
    console.warn("[Notice] Failed to create company notice:", err.message);
  }
}

// 1b. Create Document Approval Request
app.post("/api/documents/request", async (req, res) => {
  const { tenantId, letterKey, letterTitle, employeeId, templateBody, format, requestedBy, note, approvalChain } = req.body;
  if (!tenantId || !letterKey || !employeeId) {
    return res.status(400).json({ error: "Missing required fields: tenantId, letterKey, employeeId" });
  }

  try {
    const chain = Array.isArray(approvalChain) && approvalChain.length > 0 ? approvalChain : ["HR Manager"];
    const steps = chain.map((approver) => ({
      approver,
      status: "pending",
    }));

    const docReq = {
      id: crypto.randomUUID(),
      tenantId,
      letterKey,
      letterTitle: letterTitle || letterKey,
      employeeId,
      templateBody: templateBody || "",
      format: format || "pdf",
      requestedBy: requestedBy || "Admin",
      requestedAt: new Date().toISOString(),
      steps,
      currentStep: 0,
      status: "pending",
      note: note || "",
    };

    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.docRequests, Item: docReq }));

    // Generate real-time notification
    await createCompanyNotice(tenantId, {
      title: "Document Approval Requested",
      description: `New ${letterTitle || letterKey} request submitted by ${requestedBy || "Admin"} for employee (${employeeId}).`,
      category: "approval",
      targetRole: steps[0]?.approver || "HR Manager",
    });

    res.json({ success: true, item: docReq });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1c. Approve / Reject Document Step (Strict Role-Based Permission Enforced)
app.post("/api/documents/act", async (req, res) => {
  const { tenantId, requestId, action, comment, actorId, actorName, actorRole } = req.body;
  if (!tenantId || !requestId || !action) {
    return res.status(400).json({ error: "Missing required fields: tenantId, requestId, action" });
  }

  try {
    // 1. Fetch document request
    const docRes = await ddb.send(new GetCommand({
      TableName: COMPANY_TABLES.docRequests,
      Key: { tenantId, id: requestId }
    }));
    const docReq = docRes.Item;
    if (!docReq) return res.status(404).json({ error: "Document request not found" });

    if (docReq.status !== "pending") {
      return res.status(400).json({ error: `This request has already been ${docReq.status}.` });
    }

    // 2. Fetch actor's role permissions
    let allowedToApprove = true;
    if (actorRole && actorRole !== "Admin" && actorRole !== "Super Admin" && actorRole !== "CEO / Super Admin") {
      const rolesRes = await getTenantItems(COMPANY_TABLES.roles, tenantId);
      const matchedRole = rolesRes.find((r) => r.id === actorRole || r.name === actorRole);
      if (matchedRole) {
        allowedToApprove = canRoleApproveDoc(matchedRole, docReq.letterKey);
      } else {
        allowedToApprove = false;
      }
    }

    if (!allowedToApprove) {
      return res.status(403).json({
        error: "Access Denied: Your assigned role does not have permission to approve this category of document.",
      });
    }

    // 3. Update approval step
    const steps = [...(docReq.steps || [])];
    const idx = docReq.currentStep || 0;
    if (idx < steps.length) {
      steps[idx] = {
        ...steps[idx],
        status: action === "approve" ? "approved" : "rejected",
        comment: comment || "",
        actedAt: new Date().toISOString(),
        actedBy: actorName || "Approver",
      };
    }

    let nextStatus = "pending";
    let nextStep = idx;

    if (action === "reject") {
      nextStatus = "rejected";
    } else {
      const nextIdx = idx + 1;
      if (nextIdx >= steps.length) {
        nextStatus = "approved";
      } else {
        nextStep = nextIdx;
      }
    }

    const updatedDocReq = {
      ...docReq,
      steps,
      currentStep: nextStep,
      status: nextStatus,
    };

    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.docRequests, Item: updatedDocReq }));

    // Generate real-time notification
    await createCompanyNotice(tenantId, {
      title: action === "approve" ? "Document Request Approved" : "Document Request Rejected",
      description: `Your ${docReq.letterTitle} was ${action === "approve" ? (nextStatus === "approved" ? "fully approved and is ready for signature" : "approved at step " + (idx + 1)) : "rejected"} by ${actorName || "Approver"}${comment ? ": " + comment : "."}`,
      category: "document",
      targetEmployeeId: docReq.employeeId,
    });

    res.json({ success: true, item: updatedDocReq });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1e. Approve & Forward Document to Another Role / CEO
app.post("/api/documents/forward", async (req, res) => {
  const { tenantId, requestId, toRole, comment, actorId, actorName, actorRole } = req.body;
  if (!tenantId || !requestId || !toRole) {
    return res.status(400).json({ error: "Missing required fields: tenantId, requestId, toRole" });
  }

  try {
    const docRes = await ddb.send(new GetCommand({
      TableName: COMPANY_TABLES.docRequests,
      Key: { tenantId, id: requestId }
    }));
    const docReq = docRes.Item;
    if (!docReq) return res.status(404).json({ error: "Document request not found" });

    if (docReq.status !== "pending") {
      return res.status(400).json({ error: `This request has already been ${docReq.status}.` });
    }

    // Role permission verification
    let allowedToApprove = true;
    if (actorRole && actorRole !== "Admin" && actorRole !== "Super Admin" && actorRole !== "CEO / Super Admin") {
      const rolesRes = await getTenantItems(COMPANY_TABLES.roles, tenantId);
      const matchedRole = rolesRes.find((r) => r.id === actorRole || r.name === actorRole);
      if (matchedRole) {
        allowedToApprove = canRoleApproveDoc(matchedRole, docReq.letterKey);
      } else {
        allowedToApprove = false;
      }
    }

    if (!allowedToApprove) {
      return res.status(403).json({
        error: "Access Denied: Your assigned role does not have permission to approve/forward this document.",
      });
    }

    const steps = [...(docReq.steps || [])];
    const idx = docReq.currentStep || 0;
    if (idx < steps.length) {
      steps[idx] = {
        ...steps[idx],
        status: "approved",
        comment: `Approved & Forwarded to ${toRole}${comment ? " · " + comment : ""}`,
        actedAt: new Date().toISOString(),
        actedBy: actorName || "Approver",
      };
    }

    // Insert the new forward step immediately following current step
    steps.splice(idx + 1, 0, {
      approver: toRole,
      status: "pending",
      forwardedFrom: actorName || "Approver",
    });

    const updatedDocReq = {
      ...docReq,
      steps,
      currentStep: idx + 1,
      status: "pending",
    };

    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.docRequests, Item: updatedDocReq }));

    // Real-time notification for target role
    await createCompanyNotice(tenantId, {
      title: "Document Forwarded For Approval",
      description: `${docReq.letterTitle} was approved and forwarded to ${toRole} by ${actorName || "Approver"}. Action required.`,
      category: "approval",
      targetRole: toRole,
    });

    res.json({ success: true, item: updatedDocReq });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1d. Employee Document Acceptance & E-Signing
app.post("/api/documents/accept", async (req, res) => {
  const { tenantId, requestId, employeeId, signatureDataUrl } = req.body;
  if (!tenantId || !requestId || !employeeId) {
    return res.status(400).json({ error: "Missing required fields: tenantId, requestId, employeeId" });
  }

  try {
    const docRes = await ddb.send(new GetCommand({
      TableName: COMPANY_TABLES.docRequests,
      Key: { tenantId, id: requestId }
    }));
    const docReq = docRes.Item;
    if (!docReq) return res.status(404).json({ error: "Document request not found" });

    // Verify employee owns this document
    if (docReq.employeeId !== employeeId) {
      return res.status(403).json({ error: "You are only permitted to accept and sign your own documents." });
    }

    const updatedDocReq = {
      ...docReq,
      employeeAccepted: true,
      employeeAcceptedAt: new Date().toISOString(),
      employeeSignature: signatureDataUrl || undefined,
    };

    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.docRequests, Item: updatedDocReq }));

    // Generate real-time notice for HR
    await createCompanyNotice(tenantId, {
      title: "Document E-Signed & Accepted",
      description: `${docReq.letterTitle} has been e-signed and accepted by employee (${employeeId}).`,
      category: "document",
      targetRole: "HR Manager",
    });

    res.json({ success: true, item: updatedDocReq });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1f. Approve / Reject Leave or Permission Request
app.post("/api/leaves/act", async (req, res) => {
  const { tenantId, leaveId, action, comment, actorId, actorName, actorRole } = req.body;
  if (!tenantId || !leaveId || !action) {
    return res.status(400).json({ error: "Missing required fields: tenantId, leaveId, action" });
  }

  try {
    const leaveRes = await ddb.send(new GetCommand({
      TableName: COMPANY_TABLES.leaves,
      Key: { tenantId, id: leaveId }
    }));
    const leaveReq = leaveRes.Item;
    if (!leaveReq) return res.status(404).json({ error: "Leave request not found" });

    const normalizedAction = action === "approve" || action === "Approved" ? "Approved" : "Rejected";

    const updatedLeaveReq = {
      ...leaveReq,
      status: normalizedAction,
      actedBy: actorName || "Approver",
      actedById: actorId,
      actedByRole: actorRole || "Manager",
      approverComment: comment || "",
      actedAt: new Date().toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.leaves, Item: updatedLeaveReq }));

    // Generate real-time notice for the employee
    await createCompanyNotice(tenantId, {
      title: normalizedAction === "Approved" ? "Leave / Permission Request Approved" : "Leave / Permission Request Rejected",
      description: `Your ${leaveReq.type} request (${leaveReq.startDate || ""}) has been ${normalizedAction.toLowerCase()} by ${actorName || "Manager"}${comment ? ": " + comment : "."}`,
      category: "leave",
      targetEmployeeId: leaveReq.employeeId,
    });

    res.json({ success: true, item: updatedLeaveReq });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Generic Mutation Route
app.post("/api/companies/mutate", async (req, res) => {
  const { table, item } = req.body;
  if (!table || !item || !item.tenantId || !item.id) {
    return res.status(400).json({ error: "Missing required params: table, item, tenantId, id" });
  }
  const tableName = COMPANY_TABLES[table];
  if (!tableName) return res.status(404).json({ error: "Table not found" });

  try {
    await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Assign Shift Roster
app.post("/api/roster/bulk-assign", async (req, res) => {
  const { tenantId, assignments } = req.body;
  if (!tenantId || !assignments || !Array.isArray(assignments)) {
    return res.status(400).json({ error: "Missing required params: tenantId, assignments (array)" });
  }

  try {
    const saved = [];
    for (const item of assignments) {
      const record = {
        ...item,
        tenantId,
        id: item.id || `ros-${item.employeeId}-${item.date}`,
        updatedAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: COMPANY_TABLES.roster, Item: record }));
      saved.push(record);
    }
    res.json({ success: true, count: saved.length, assignments: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Generic Delete Route
app.post("/api/companies/delete", async (req, res) => {
  const { table, tenantId, id } = req.body;
  if (!table || !tenantId || !id) {
    return res.status(400).json({ error: "Missing required params: table, tenantId, id" });
  }
  const tableName = COMPANY_TABLES[table];
  if (!tableName) return res.status(404).json({ error: "Table not found" });

  try {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { tenantId, id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. File Upload Endpoint
app.post("/api/companies/upload", async (req, res) => {
  const { tenantId, path, fileDataUrl } = req.body;
  if (!tenantId || !path || !fileDataUrl) {
    return res.status(400).json({ error: "Missing required params: tenantId, path, fileDataUrl" });
  }

  try {
    const s3Url = await uploadToS3(`${tenantId}/${path}`, fileDataUrl);
    res.json({ success: true, url: s3Url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Face Registration
app.post("/api/companies/face-register", async (req, res) => {
  const { tenantId, employeeId, photoDataUrl } = req.body;
  if (!tenantId || !employeeId || !photoDataUrl) {
    return res.status(400).json({ error: "Missing tenantId, employeeId, or photoDataUrl" });
  }

  try {
    const key = `${tenantId}/employee-profiles/${employeeId}_avatar.png`;
    const s3Url = await uploadToS3(key, photoDataUrl);

    if (process.env.AWS_ACCESS_KEY_ID && photoDataUrl.startsWith("data:")) {
      const collectionId = `swift_collection_${tenantId}`;
      await ensureCollection(collectionId);

      const base64Body = photoDataUrl.split(";base64,").pop();
      const buffer = Buffer.from(base64Body, "base64");

      const indexCommand = new IndexFacesCommand({
        CollectionId: collectionId,
        Image: { Bytes: buffer },
        ExternalImageId: employeeId,
        MaxFaces: 1,
        DetectionAttributes: ["DEFAULT"],
      });

      await rekognition.send(indexCommand);
    }

    res.json({ success: true, url: s3Url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Face Verification
app.post("/api/companies/face-verify", async (req, res) => {
  const { tenantId, employeeId, photoDataUrl } = req.body;
  if (!tenantId || !photoDataUrl) {
    return res.status(400).json({ error: "Missing tenantId or photoDataUrl" });
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !photoDataUrl.startsWith("data:")) {
    // Demo/offline fallback: verify for requested employeeId or fallback to demo-emp-1
    return res.json({ success: true, employeeId: employeeId || "demo-emp-1", similarity: 100 });
  }

  try {
    const collectionId = `swift_collection_${tenantId}`;
    await ensureCollection(collectionId);

    const base64Body = photoDataUrl.split(";base64,").pop();
    const buffer = Buffer.from(base64Body, "base64");

    const searchCommand = new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: buffer },
      MaxFaces: 1,
      FaceMatchThreshold: 85,
    });

    const matchRes = await rekognition.send(searchCommand);
    const matches = matchRes.FaceMatches || [];

    if (matches.length > 0 && matches[0].Face && matches[0].Face.ExternalImageId) {
      const matchedEmpId = matches[0].Face.ExternalImageId;
      if (employeeId && matchedEmpId !== employeeId) {
        return res.json({
          success: false,
          reason: `Facial mismatch: Captured face matches employee "${matchedEmpId}", not the logged-in employee`,
          matchedEmployeeId: matchedEmpId,
          similarity: matches[0].Similarity,
        });
      }
      res.json({
        success: true,
        employeeId: matchedEmpId,
        similarity: matches[0].Similarity,
      });
    } else {
      res.json({ success: false, reason: "No registered matching face found in Rekognition collection" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1. Initial State Load (seeds tables if empty)
app.get("/api/initial-state", async (req, res) => {
  try {
    // Scan Settings to check if seeded
    const settingsScan = await ddb.send(new ScanCommand({ TableName: TABLES.settings }));
    let settingsList = settingsScan.Items || [];

    let whitelabel = settingsList.find((s) => s.id === "whitelabel");
    let upi = settingsList.find((s) => s.id === "upi");
    let reminderConfig = settingsList.find((s) => s.id === "reminder_config");

    if (!whitelabel || !upi || !reminderConfig) {
      console.log("[Database] Seeding default settings...");
      whitelabel = defaultWhiteLabel;
      upi = defaultUpi;
      reminderConfig = defaultReminderConfig;
      await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: whitelabel }));
      await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: upi }));
      await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: reminderConfig }));
    }

    // Scan Plans
    const plansScan = await ddb.send(new ScanCommand({ TableName: TABLES.plans }));
    let plans = plansScan.Items || [];
    if (plans.length === 0) {
      console.log("[Database] Seeding default plans...");
      for (const p of defaultPlans) {
        await ddb.send(new PutCommand({ TableName: TABLES.plans, Item: p }));
      }
      plans = defaultPlans;
    }

    // Scan Coupons
    const couponsScan = await ddb.send(new ScanCommand({ TableName: TABLES.coupons }));
    let coupons = couponsScan.Items || [];
    if (coupons.length === 0) {
      console.log("[Database] Seeding default coupons...");
      for (const c of defaultCoupons) {
        await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: c }));
      }
      coupons = defaultCoupons;
    }

    // Scan Referral Programs
    const refProgScan = await ddb.send(new ScanCommand({ TableName: TABLES.referral_programs }));
    let referralPrograms = refProgScan.Items || [];
    if (referralPrograms.length === 0) {
      console.log("[Database] Seeding default referral programs...");
      for (const rp of defaultReferralPrograms) {
        await ddb.send(new PutCommand({ TableName: TABLES.referral_programs, Item: rp }));
      }
      referralPrograms = defaultReferralPrograms;
    }

    // Scan Tenants
    const tenantsScan = await ddb.send(new ScanCommand({ TableName: TABLES.tenants }));
    let tenants = tenantsScan.Items || [];
    if (tenants.length === 0) {
      console.log("[Database] Seeding default tenants...");
      for (const t of defaultTenants) {
        await ddb.send(new PutCommand({ TableName: TABLES.tenants, Item: t }));
      }
      tenants = defaultTenants;
    }

    // Scan Other Tables
    const tickets = (await ddb.send(new ScanCommand({ TableName: TABLES.tickets }))).Items || [];
    const touchpoints = (await ddb.send(new ScanCommand({ TableName: TABLES.touchpoints }))).Items || [];
    const checklistsList = (await ddb.send(new ScanCommand({ TableName: TABLES.checklists }))).Items || [];
    const impersonation = (await ddb.send(new ScanCommand({ TableName: TABLES.impersonations }))).Items || [];
    const paymentSubmissions = (await ddb.send(new ScanCommand({ TableName: TABLES.payments }))).Items || [];
    const subscriptions = (await ddb.send(new ScanCommand({ TableName: TABLES.subscriptions }))).Items || [];
    const invoices = (await ddb.send(new ScanCommand({ TableName: TABLES.invoices }))).Items || [];
    const referrals = (await ddb.send(new ScanCommand({ TableName: TABLES.referrals }))).Items || [];
    const audit = (await ddb.send(new ScanCommand({ TableName: TABLES.audit }))).Items || [];
    const reminderLog = (await ddb.send(new ScanCommand({ TableName: TABLES.reminder_log }))).Items || [];

    // Map checklists array back to key-value record
    const checklists = {};
    checklistsList.forEach((c) => {
      checklists[c.tenantId] = c.checklist;
    });

    res.json({
      tickets,
      touchpoints,
      checklists,
      impersonation,
      whiteLabel: whitelabel,
      upi,
      paymentSubmissions,
      plans,
      coupons,
      referralPrograms,
      subscriptions,
      invoices,
      referrals,
      audit,
      reminderConfig,
      reminderLog,
      tenants,
    });
  } catch (error) {
    console.error("[API Error] load initial state:", error);
    res.status(500).json({ error: error.message });
  }
});

// Tickets REST API
app.post("/api/tickets", async (req, res) => {
  try {
    const item = { ...req.body, id: req.body.id || require("crypto").randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), notes: [] };
    await ddb.send(new PutCommand({ TableName: TABLES.tickets, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/tickets/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.tickets, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Ticket not found" });
    const updated = { ...getRes.Item, ...req.body, updatedAt: new Date().toISOString() };
    await ddb.send(new PutCommand({ TableName: TABLES.tickets, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tickets/:id/notes", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.tickets, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Ticket not found" });
    const ticket = getRes.Item;
    const note = { ...req.body, id: require("crypto").randomUUID(), ts: new Date().toISOString() };
    ticket.notes = [note, ...(ticket.notes || [])];
    ticket.updatedAt = new Date().toISOString();
    await ddb.send(new PutCommand({ TableName: TABLES.tickets, Item: ticket }));
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/tickets/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.tickets, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Touchpoints REST API
app.post("/api/touchpoints", async (req, res) => {
  try {
    const item = { ...req.body, id: require("crypto").randomUUID(), ts: new Date().toISOString() };
    await ddb.send(new PutCommand({ TableName: TABLES.touchpoints, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/touchpoints/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.touchpoints, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Checklists REST API
app.put("/api/checklists/:tenantId", async (req, res) => {
  try {
    const { checklist } = req.body;
    const item = { tenantId: req.params.tenantId, checklist };
    await ddb.send(new PutCommand({ TableName: TABLES.checklists, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Impersonations API
app.post("/api/impersonations", async (req, res) => {
  try {
    const item = { ...req.body, id: require("crypto").randomUUID(), ts: new Date().toISOString() };
    await ddb.send(new PutCommand({ TableName: TABLES.impersonations, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Whitelabel and UPI Settings API
app.put("/api/settings/whitelabel", async (req, res) => {
  try {
    const item = { ...req.body, id: "whitelabel" };
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings/whitelabel/reset", async (req, res) => {
  try {
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: defaultWhiteLabel }));
    res.json(defaultWhiteLabel);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/settings/upi", async (req, res) => {
  try {
    const item = { ...req.body, id: "upi" };
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings/upi/reset", async (req, res) => {
  try {
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: defaultUpi }));
    res.json(defaultUpi);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Payments API
app.post("/api/payments", async (req, res) => {
  try {
    const item = { ...req.body, id: require("crypto").randomUUID(), submittedAt: new Date().toISOString(), status: "pending" };
    await ddb.send(new PutCommand({ TableName: TABLES.payments, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/payments/:id/verify", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.payments, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Payment not found" });
    const updated = { ...getRes.Item, status: "verified", verifiedAt: new Date().toISOString(), verifiedBy: req.body.verifiedBy };
    await ddb.send(new PutCommand({ TableName: TABLES.payments, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/payments/:id/reject", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.payments, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Payment not found" });
    const updated = { ...getRes.Item, status: "rejected", verifiedAt: new Date().toISOString(), verifiedBy: req.body.verifiedBy, rejectionReason: req.body.reason };
    await ddb.send(new PutCommand({ TableName: TABLES.payments, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/payments/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.payments, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Plans API
app.post("/api/plans", async (req, res) => {
  try {
    const item = { ...req.body, id: req.body.id || require("crypto").randomUUID(), createdAt: new Date().toISOString() };
    await ddb.send(new PutCommand({ TableName: TABLES.plans, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/plans/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.plans, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Plan not found" });
    const updated = { ...getRes.Item, ...req.body, limits: { ...getRes.Item.limits, ...(req.body.limits || {}) } };
    await ddb.send(new PutCommand({ TableName: TABLES.plans, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/plans/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.plans, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Subscriptions API
app.post("/api/subscriptions/ensure", async (req, res) => {
  try {
    const { tenantId, planId } = req.body;
    const subsScan = await ddb.send(new ScanCommand({ TableName: TABLES.subscriptions }));
    const existing = (subsScan.Items || []).find((s) => s.tenantId === tenantId);
    if (existing) return res.json({ subscription: existing });

    // Fetch plan
    const plansScan = await ddb.send(new ScanCommand({ TableName: TABLES.plans }));
    const plan = (plansScan.Items || []).find((p) => p.id === planId) || defaultPlans[0];
    const cycle = plan.cycle || "monthly";
    const now = new Date();
    const days = cycle === "yearly" ? 365 : 30; // standard days fallback
    const expires = new Date(now.getTime() + days * 86400_000);

    const sub = {
      id: require("crypto").randomUUID(),
      tenantId,
      planId: plan.id,
      cycle,
      status: (plan.trialDays || 0) > 0 ? "trial" : "active",
      activatedAt: now.toISOString(),
      renewalAt: expires.toISOString(),
      expiresAt: expires.toISOString(),
      paymentStatus: "pending",
      moduleOverrides: {},
      featureOverrides: {},
      limitOverrides: {},
      usage: { aiConversations: 0, docs: 0, loginCount: 0, reports: 0, pdfDownloads: 0, smsCredits: 0, emailCredits: 0, whatsappCredits: 0, storageMB: 0, employees: 0 },
      history: [{ ts: now.toISOString(), actor: "system", kind: "activation", toPlanId: plan.id, note: "Subscription initialised" }],
      reminderChannels: { email: true, sms: false, whatsapp: false, push: true, banner: true },
    };

    const code = "SWIFT-" + tenantId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase();
    const ledger = { tenantId, code, invited: [], registered: [], activated: [], paid: [], rewardsEarned: 0 };

    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    await ddb.send(new PutCommand({ TableName: TABLES.referrals, Item: ledger }));

    res.json({ subscription: sub, referral: ledger });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.subscriptions, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Subscription not found" });
    const updated = { ...getRes.Item, ...req.body };
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update specific fields on subscriptions
app.put("/api/subscriptions/:id/module", async (req, res) => {
  try {
    const { module, status } = req.body;
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.subscriptions, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Subscription not found" });
    const sub = getRes.Item;
    if (status === null) {
      delete sub.moduleOverrides[module];
    } else {
      sub.moduleOverrides[module] = status;
    }
    sub.history = [{ ts: new Date().toISOString(), actor: "admin", kind: status ? "feature_unlock" : "feature_lock", note: `Module ${module} → ${status ?? "reset"}` }, ...(sub.history || [])];
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/:id/feature", async (req, res) => {
  try {
    const { key, value } = req.body;
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.subscriptions, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Subscription not found" });
    const sub = getRes.Item;
    if (value === null) delete sub.featureOverrides[key];
    else sub.featureOverrides[key] = value;
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/:id/limit", async (req, res) => {
  try {
    const { key, value } = req.body;
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.subscriptions, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Subscription not found" });
    const sub = getRes.Item;
    if (value === null) delete sub.limitOverrides[key];
    else sub.limitOverrides[key] = value;
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/usage/bump", async (req, res) => {
  try {
    const { tenantId, key, by } = req.body;
    const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.subscriptions }));
    const sub = (scanRes.Items || []).find((s) => s.tenantId === tenantId);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    sub.usage = sub.usage || {};
    sub.usage[key] = (sub.usage[key] || 0) + (by || 1);
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/usage/set", async (req, res) => {
  try {
    const { tenantId, patch } = req.body;
    const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.subscriptions }));
    const sub = (scanRes.Items || []).find((s) => s.tenantId === tenantId);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    sub.usage = { ...(sub.usage || {}), ...patch };
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Transactional Billing APIs
app.post("/api/billing/upgrade", async (req, res) => {
  try {
    const { invoice, subscription, coupon, auditEntry } = req.body;
    await ddb.send(new PutCommand({ TableName: TABLES.invoices, Item: invoice }));
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: subscription }));
    if (coupon) {
      await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: coupon }));
    }
    await ddb.send(new PutCommand({ TableName: TABLES.audit, Item: auditEntry }));
    res.json({ success: true, invoice, subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/billing/downgrade", async (req, res) => {
  try {
    const { subscription, auditEntry } = req.body;
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: subscription }));
    await ddb.send(new PutCommand({ TableName: TABLES.audit, Item: auditEntry }));
    res.json({ success: true, subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/billing/renew", async (req, res) => {
  try {
    const { invoice, subscription, coupon, auditEntry } = req.body;
    await ddb.send(new PutCommand({ TableName: TABLES.invoices, Item: invoice }));
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: subscription }));
    if (coupon) {
      await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: coupon }));
    }
    await ddb.send(new PutCommand({ TableName: TABLES.audit, Item: auditEntry }));
    res.json({ success: true, invoice, subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/invoices/:id/pay", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.invoices, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Invoice not found" });
    const updated = { ...getRes.Item, status: "paid", paymentMethod: req.body.method };
    await ddb.send(new PutCommand({ TableName: TABLES.invoices, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Coupons APIs
app.post("/api/coupons", async (req, res) => {
  try {
    const item = { ...req.body, id: req.body.id || require("crypto").randomUUID() };
    await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/coupons/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.coupons, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Coupon not found" });
    const updated = { ...getRes.Item, ...req.body };
    await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/coupons/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.coupons, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Referrals APIs
app.post("/api/referrals/programs", async (req, res) => {
  try {
    const item = { ...req.body, id: req.body.id || require("crypto").randomUUID() };
    await ddb.send(new PutCommand({ TableName: TABLES.referral_programs, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/referrals/programs/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.referral_programs, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Program not found" });
    const updated = { ...getRes.Item, ...req.body };
    await ddb.send(new PutCommand({ TableName: TABLES.referral_programs, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/referrals/programs/:id", async (req, res) => {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLES.referral_programs, Key: { id: req.params.id } }));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/referrals/record", async (req, res) => {
  try {
    const { referralsList } = req.body;
    for (const ref of referralsList) {
      await ddb.send(new PutCommand({ TableName: TABLES.referrals, Item: ref }));
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reminder config APIs
app.put("/api/settings/reminder-config", async (req, res) => {
  try {
    const item = { ...req.body, id: "reminder_config" };
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/subscriptions/:id/reminder-channels", async (req, res) => {
  try {
    const { reminderChannels } = req.body;
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.subscriptions, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Subscription not found" });
    const sub = getRes.Item;
    sub.reminderChannels = reminderChannels;
    await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/billing/scheduler/run", async (req, res) => {
  try {
    const { logEntries, updatedSubscriptions } = req.body;
    for (const log of logEntries) {
      await ddb.send(new PutCommand({ TableName: TABLES.reminder_log, Item: log }));
    }
    for (const sub of updatedSubscriptions) {
      await ddb.send(new PutCommand({ TableName: TABLES.subscriptions, Item: sub }));
    }
    res.json({ success: true, logEntries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/billing/scheduler/log", async (req, res) => {
  try {
    const subId = req.query.subId;
    if (subId) {
      const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.reminder_log }));
      const logsToDelete = (scanRes.Items || []).filter((l) => l.subscriptionId === subId);
      for (const log of logsToDelete) {
        await ddb.send(new DeleteCommand({ TableName: TABLES.reminder_log, Key: { id: log.id } }));
      }
    } else {
      const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.reminder_log }));
      for (const log of scanRes.Items || []) {
        await ddb.send(new DeleteCommand({ TableName: TABLES.reminder_log, Key: { id: log.id } }));
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tenants REST API
app.get("/api/tenants", async (req, res) => {
  try {
    const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.tenants }));
    res.json(scanRes.Items || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tenants", async (req, res) => {
  try {
    const item = {
      ...req.body,
      id: req.body.id || require("crypto").randomUUID(),
      createdAt: req.body.createdAt || new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: TABLES.tenants, Item: item }));
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/tenants/:id", async (req, res) => {
  try {
    const getRes = await ddb.send(new GetCommand({ TableName: TABLES.tenants, Key: { id: req.params.id } }));
    if (!getRes.Item) return res.status(404).json({ error: "Tenant not found" });
    const updated = { ...getRes.Item, ...req.body };
    await ddb.send(new PutCommand({ TableName: TABLES.tenants, Item: updated }));
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/companies/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (email === "admin@demo" && password === "demo123") {
      const demoTenant = {
        id: "demo-tenant-1",
        name: "SWIFT Demo Pvt Ltd",
        slug: "demo",
        legal_name: "SWIFT Demo Private Limited",
        address: "123 Business Ave, Suite 100, Bangalore, India",
        gstin: "29ABCDE1234F1Z5",
        plan: "growth",
        status: "active",
        created_at: new Date().toISOString()
      };
      return res.json({
        user: { id: "demo-user-1", email },
        memberships: [{ tenant_id: "demo-tenant-1", role: "owner", tenant: demoTenant }]
      });
    }

    const scanRes = await ddb.send(new ScanCommand({ TableName: TABLES.tenants }));
    const tenants = scanRes.Items || [];
    const matchedTenant = tenants.find(t => t.adminEmail === email && t.adminPassword === password);

    if (!matchedTenant) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const tenantInfo = {
      id: matchedTenant.id,
      name: matchedTenant.name,
      slug: matchedTenant.slug,
      legal_name: matchedTenant.legalName || matchedTenant.name,
      address: matchedTenant.address || null,
      gstin: matchedTenant.gstin || null,
      plan: matchedTenant.plan,
      status: matchedTenant.status,
      created_at: matchedTenant.createdAt
    };

    res.json({
      user: { id: `user-${matchedTenant.id}`, email },
      memberships: [{ tenant_id: matchedTenant.id, role: "owner", tenant: tenantInfo }]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/employee/login", async (req, res) => {
  try {
    const { empCode, password } = req.body;
    if (!empCode || !password) {
      return res.status(400).json({ error: "Employee Code and password are required" });
    }

    const searchCode = String(empCode).trim().toLowerCase();

    // Check demo employee fallbacks
    if ((searchCode === "swf001" || searchCode === "aarav@demo.swift" || searchCode === "aarav@demo") && (password === "demo123" || password === "password123")) {
      const demoEmp = {
        id: "demo-emp-1",
        empCode: "SWF001",
        name: "Aarav Sharma",
        email: "aarav@demo.swift",
        phone: "+91 98765 43210",
        department: "Engineering",
        designation: "Senior Engineer",
        roleId: "role-general-employee",
        roleName: "General Employee",
        doj: "2023-04-01",
        basic: 45000,
        faceRegistered: true,
        status: "active",
        tenantId: "demo-tenant-1",
        branchId: "branch-hq",
        branchIds: ["branch-hq"]
      };
      return res.json({
        success: true,
        employee: demoEmp,
        tenantId: "demo-tenant-1",
        companyName: "SWIFT HRMS"
      });
    }

    if ((searchCode === "hr001" || searchCode === "hr@demo.swift" || searchCode === "hr@demo" || searchCode === "priya@demo.swift") && (password === "demo123" || password === "password123")) {
      const hrEmp = {
        id: "demo-emp-hr",
        empCode: "HR001",
        name: "Priya Iyer",
        email: "hr@demo.swift",
        phone: "+91 98765 11223",
        department: "Human Resources",
        designation: "HR Manager",
        roleId: "role-hr-manager",
        roleName: "HR Manager",
        doj: "2022-01-15",
        basic: 65000,
        faceRegistered: true,
        status: "active",
        tenantId: "demo-tenant-1",
        branchId: "branch-hq",
        branchIds: ["branch-hq"]
      };
      return res.json({
        success: true,
        employee: hrEmp,
        tenantId: "demo-tenant-1",
        companyName: "SWIFT HRMS"
      });
    }

    if ((searchCode === "tl001" || searchCode === "lead@demo.swift" || searchCode === "lead@demo" || searchCode === "vikram@demo.swift") && (password === "demo123" || password === "password123")) {
      const tlEmp = {
        id: "demo-emp-tl",
        empCode: "TL001",
        name: "Vikram Rao",
        email: "lead@demo.swift",
        phone: "+91 98765 99887",
        department: "Engineering",
        designation: "Team Lead / Reporting Manager",
        roleId: "role-team-lead",
        roleName: "Team Lead / Reporting Manager",
        doj: "2022-06-01",
        basic: 70000,
        faceRegistered: true,
        status: "active",
        tenantId: "demo-tenant-1",
        branchId: "branch-hq",
        branchIds: ["branch-hq"]
      };
      return res.json({
        success: true,
        employee: tlEmp,
        tenantId: "demo-tenant-1",
        companyName: "SWIFT HRMS"
      });
    }

    if ((searchCode === "admin001" || searchCode === "ceo@demo.swift" || searchCode === "admin@demo.swift" || searchCode === "ceo@demo") && (password === "demo123" || password === "password123")) {
      const ceoEmp = {
        id: "demo-emp-ceo",
        empCode: "ADMIN001",
        name: "Rajesh Menon",
        email: "ceo@demo.swift",
        phone: "+91 98765 00001",
        department: "Executive",
        designation: "Director & CEO",
        roleId: "role-hr-manager",
        roleName: "CEO / Super Admin",
        doj: "2020-01-01",
        basic: 150000,
        faceRegistered: true,
        status: "active",
        tenantId: "demo-tenant-1",
        branchId: "branch-hq",
        branchIds: ["branch-hq"]
      };
      return res.json({
        success: true,
        employee: ceoEmp,
        tenantId: "demo-tenant-1",
        companyName: "SWIFT HRMS"
      });
    }

    // Query swift_company_employees
    const scanRes = await ddb.send(new ScanCommand({ TableName: COMPANY_TABLES.employees }));
    const employees = scanRes.Items || [];
    const matched = employees.find(
      (e) =>
        (String(e.empCode || "").toLowerCase() === searchCode || String(e.email || "").toLowerCase() === searchCode) &&
        (e.password === password || (!e.password && (password === "demo123" || password === "password123")))
    );

    if (!matched) {
      return res.status(401).json({ error: "Invalid Employee Code or Password" });
    }

    let companyName = "SWIFT HRMS";
    const tenantIdToLookup = matched.tenantId || "demo-tenant-1";
    try {
      const tenantRes = await ddb.send(new GetCommand({ TableName: TABLES.tenants, Key: { id: tenantIdToLookup } }));
      if (tenantRes.Item) {
        companyName = tenantRes.Item.name || tenantRes.Item.companyName || tenantRes.Item.legalName || companyName;
      }
    } catch (e) {
      console.error("[Login] Tenant lookup error:", e.message);
    }

    const employeeBranchIds = Array.isArray(matched.branchIds) && matched.branchIds.length > 0
      ? matched.branchIds
      : (matched.branchId ? [matched.branchId] : []);

    res.json({
      success: true,
      employee: {
        ...matched,
        branchId: matched.branchId || employeeBranchIds[0] || undefined,
        branchIds: employeeBranchIds.length > 0 ? employeeBranchIds : undefined,
      },
      tenantId: tenantIdToLookup,
      companyName: companyName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset databases API (clears everything and re-seeds)
app.post("/api/billing/reset", async (req, res) => {
  try {
    console.log("[Database] Reset requested. Clearing tables...");
    const clearTable = async (tableName, keyName) => {
      const scanRes = await ddb.send(new ScanCommand({ TableName: tableName }));
      for (const item of scanRes.Items || []) {
        await ddb.send(new DeleteCommand({ TableName: tableName, Key: { [keyName]: item[keyName] } }));
      }
    };

    for (const key of Object.keys(TABLES)) {
      const tName = TABLES[key];
      const keyName = key === "checklists" || key === "referrals" ? "tenantId" : "id";
      await clearTable(tName, keyName);
    }

    console.log("[Database] Re-seeding defaults...");
    // Put settings
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: defaultWhiteLabel }));
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: defaultUpi }));
    await ddb.send(new PutCommand({ TableName: TABLES.settings, Item: defaultReminderConfig }));

    // Put plans
    for (const p of defaultPlans) {
      await ddb.send(new PutCommand({ TableName: TABLES.plans, Item: p }));
    }

    // Put coupons
    for (const c of defaultCoupons) {
      await ddb.send(new PutCommand({ TableName: TABLES.coupons, Item: c }));
    }

    // Put referral programs
    for (const rp of defaultReferralPrograms) {
      await ddb.send(new PutCommand({ TableName: TABLES.referral_programs, Item: rp }));
    }

    // Put tenants
    for (const t of defaultTenants) {
      await ddb.send(new PutCommand({ TableName: TABLES.tenants, Item: t }));
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// App Startup Initializer
async function startServer() {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Super Admin backend API running at http://0.0.0.0:${PORT}`);
  });

  try {
    await initDB();
  } catch (err) {
    console.error("[Server] Database initialization warning:", err?.message || err);
  }
}

startServer();
