const awsClient = require("./awsClient");
const admsParser = require("./admsParser");
const DeviceModel = require("./deviceModel");
const EmployeeModel = require("./employeeModel");
const AttendanceModel = require("./attendanceModel");
const CompanyModel = require("./companyModel");
const AdmsService = require("./admsService");

/**
 * Initializes all required AWS DynamoDB tables for the Swift Biometric & Attendance engine
 */
async function initBiometricDatabase() {
  console.log("⚡ [AWS DynamoDB] Initializing Swift Biometric & Attendance Tables...");
  await CompanyModel.initTable();
  await DeviceModel.initTable();
  await EmployeeModel.initTable();
  await AttendanceModel.initTable();
  console.log("✅ [AWS DynamoDB] All Biometric Tables initialized successfully.");
}

module.exports = {
  ...awsClient,
  ...admsParser,
  DeviceModel,
  EmployeeModel,
  AttendanceModel,
  CompanyModel,
  AdmsService,
  initBiometricDatabase,
};
