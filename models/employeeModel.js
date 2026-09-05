const {
  ddb,
  TABLES,
  ensureCompositeTable,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} = require("./awsClient");

const TABLE_NAME = TABLES.employees;

/**
 * Employee Model for managing staff records and biometric synchronization on AWS DynamoDB.
 */
class EmployeeModel {
  /**
   * Initializes DynamoDB composite table for Employees
   */
  static async initTable() {
    return await ensureCompositeTable(TABLE_NAME, "tenantId", "id");
  }

  /**
   * Finds an employee by employee code within a tenant
   * @param {string} tenantId - Company tenant identifier
   * @param {string} empCode - Employee code / device user ID
   * @returns {Promise<object|null>}
   */
  static async findByEmpCode(tenantId, empCode) {
    if (!tenantId || !empCode) return null;
    const cleanCode = String(empCode).trim();

    try {
      const items = await this.listByTenant(tenantId);
      const match = items.find((emp) => {
        const c = String(emp.empCode || emp.code || emp.employeeId || emp.id || "").trim().toLowerCase();
        return c === cleanCode.toLowerCase();
      });
      return match || null;
    } catch (err) {
      console.error(`[EmployeeModel.findByEmpCode] Error finding employee "${cleanCode}":`, err.message);
      return null;
    }
  }

  /**
   * Retrieves an employee by composite key (tenantId, id)
   */
  static async findById(tenantId, id) {
    if (!tenantId || !id) return null;

    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { tenantId, id },
        })
      );
      return res.Item || null;
    } catch (err) {
      console.error(`[EmployeeModel.findById] Error fetching employee "${id}":`, err.message);
      return null;
    }
  }

  /**
   * Lists all employees for a company tenant
   */
  static async listByTenant(tenantId) {
    if (!tenantId) return [];

    try {
      const queryRes = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "tenantId = :tId",
          ExpressionAttributeValues: { ":tId": tenantId },
        })
      );
      return queryRes.Items || [];
    } catch (queryErr) {
      const scanRes = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "tenantId = :tId",
          ExpressionAttributeValues: { ":tId": tenantId },
        })
      );
      return scanRes.Items || [];
    }
  }

  /**
   * Auto-provisions or updates an employee from ADMS punch/sync streams
   * @param {string} tenantId - Company tenant identifier
   * @param {string} empCode - Employee ID from machine
   * @param {string} [name] - Optional name
   * @param {string} [cardNo] - Optional RFID Card No
   * @param {string} [department] - Default 'Operations'
   * @param {string} [designation] - Default 'Staff'
   */
  static async upsertFromDevice(tenantId, empCode, name, cardNo, department = "Operations", designation = "Staff") {
    if (!tenantId || !empCode) throw new Error("tenantId and empCode are required");
    const cleanCode = String(empCode).trim();

    const existing = await this.findByEmpCode(tenantId, cleanCode);
    const now = new Date().toISOString();

    if (existing) {
      let cleanName = name ? String(name).replace(/\0/g, "").trim() : "";
      const shouldUpdateName = cleanName && (!cleanName.startsWith("Employee #") || existing.name?.startsWith("Employee #"));
      const cleanCardNo = cardNo && cardNo !== "0" ? String(cardNo).trim() : existing.cardNo;

      const updated = {
        ...existing,
        name: shouldUpdateName ? cleanName : existing.name,
        cardNo: cleanCardNo,
        updatedAt: now,
      };

      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: updated,
        })
      );
      return updated;
    }

    // Create new employee profile
    const id = `emp_${cleanCode.toLowerCase().replace(/[^a-z0-9_-]/g, "")}_${Date.now().toString(36)}`;
    const newEmp = {
      id,
      tenantId,
      empCode: cleanCode,
      employeeId: cleanCode,
      name: name?.trim() || `Employee #${cleanCode}`,
      department: department || "Operations",
      designation: designation || "Staff",
      cardNo: cardNo && cardNo !== "0" ? String(cardNo).trim() : null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: newEmp,
      })
    );

    return newEmp;
  }

  /**
   * Batch synchronizes enrolled user profiles from biometric terminal
   * @param {string} tenantId
   * @param {Array<object>} users - Array of { employeeId, name, cardNo }
   */
  static async syncBatchFromDevice(tenantId, users) {
    if (!tenantId || !Array.isArray(users)) return { syncedCount: 0 };

    let syncedCount = 0;
    for (const u of users) {
      const cleanEmpId = String(u.employeeId || u.userId || u.uid || "").trim();
      if (!cleanEmpId) continue;

      const cleanName = u.name ? String(u.name).replace(/\0/g, "").trim() : "";
      const cardNo = u.cardNo || u.cardno || null;

      await this.upsertFromDevice(tenantId, cleanEmpId, cleanName, cardNo);
      syncedCount++;
    }

    return { syncedCount };
  }

  /**
   * Creates a new employee record
   */
  static async create(employeeData) {
    const { tenantId, empCode, name, email, department, designation, cardNo, phone, salary, role } = employeeData;
    if (!tenantId || !empCode || !name) {
      throw new Error("tenantId, empCode, and name are required");
    }

    const cleanCode = String(empCode).trim();
    const existing = await this.findByEmpCode(tenantId, cleanCode);
    if (existing) {
      throw new Error(`Employee with code "${cleanCode}" already exists for tenant "${tenantId}"`);
    }

    const now = new Date().toISOString();
    const id = employeeData.id || `emp_${cleanCode.toLowerCase().replace(/[^a-z0-9_-]/g, "")}_${Date.now().toString(36)}`;

    const newEmp = {
      id,
      tenantId,
      empCode: cleanCode,
      employeeId: cleanCode,
      name: name.trim(),
      email: email?.trim().toLowerCase() || "",
      department: department?.trim() || "General",
      designation: designation?.trim() || "Staff",
      cardNo: cardNo ? String(cardNo).trim() : null,
      phone: phone?.trim() || "",
      salary: salary || 0,
      role: role || "role-general-employee",
      status: employeeData.status || "active",
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: newEmp,
      })
    );

    return newEmp;
  }

  /**
   * Updates an employee record
   */
  static async update(tenantId, id, updateData) {
    const existing = await this.findById(tenantId, id);
    if (!existing) {
      throw new Error(`Employee "${id}" not found in tenant "${tenantId}"`);
    }

    const updated = {
      ...existing,
      ...updateData,
      id,
      tenantId,
      updatedAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: updated,
      })
    );

    return updated;
  }

  /**
   * Deletes an employee record
   */
  static async delete(tenantId, id) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { tenantId, id },
      })
    );
    return { success: true };
  }
}

module.exports = EmployeeModel;
