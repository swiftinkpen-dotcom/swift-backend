const {
  ddb,
  TABLES,
  ensureTable,
  PutCommand,
  GetCommand,
  DeleteCommand,
  ScanCommand,
} = require("./awsClient");

const TABLE_NAME = TABLES.tenants;

/**
 * Company / Tenant Model on AWS DynamoDB for multi-tenant isolation.
 */
class CompanyModel {
  /**
   * Initializes DynamoDB table for Tenants
   */
  static async initTable() {
    return await ensureTable(TABLE_NAME, "id");
  }

  /**
   * Retrieves tenant by tenant ID
   * @param {string} tenantId
   * @returns {Promise<object|null>}
   */
  static async findById(tenantId) {
    if (!tenantId) return null;

    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { id: tenantId },
        })
      );
      return res.Item || null;
    } catch (err) {
      console.error(`[CompanyModel.findById] Error fetching tenant ${tenantId}:`, err.message);
      return null;
    }
  }

  /**
   * Finds a company by unique company code (e.g. "SWIFT", "TECHCORP")
   * @param {string} code
   */
  static async findByCode(code) {
    if (!code) return null;
    const cleanCode = String(code).trim().toUpperCase();

    try {
      const all = await this.listAll();
      return all.find((c) => (c.code || c.companyCode || "").toUpperCase() === cleanCode) || null;
    } catch (err) {
      console.error(`[CompanyModel.findByCode] Error finding code ${cleanCode}:`, err.message);
      return null;
    }
  }

  /**
   * Lists all companies/tenants in the platform
   */
  static async listAll() {
    try {
      const scanRes = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
      return scanRes.Items || [];
    } catch (err) {
      console.error(`[CompanyModel.listAll] Error scanning tenants:`, err.message);
      return [];
    }
  }

  /**
   * Creates a new company tenant
   */
  static async create(companyData) {
    const { name, code, email, phone, planId, description } = companyData;
    if (!name || !code) {
      throw new Error("name and code are required to create a Company");
    }

    const cleanCode = String(code).trim().toUpperCase();
    const existing = await this.findByCode(cleanCode);
    if (existing) {
      throw new Error(`Company with code "${cleanCode}" already exists`);
    }

    const now = new Date().toISOString();
    const id = companyData.id || `tenant_${cleanCode.toLowerCase()}_${Date.now().toString(36)}`;

    const newCompany = {
      id,
      name: name.trim(),
      code: cleanCode,
      email: email?.trim().toLowerCase() || "",
      phone: phone?.trim() || "",
      planId: planId || "plan-starter",
      description: description?.trim() || "",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: newCompany,
      })
    );

    return newCompany;
  }

  /**
   * Updates an existing company tenant
   */
  static async update(tenantId, updateData) {
    const existing = await this.findById(tenantId);
    if (!existing) {
      throw new Error(`Tenant "${tenantId}" not found`);
    }

    const updated = {
      ...existing,
      ...updateData,
      id: tenantId,
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
   * Deletes a tenant
   */
  static async delete(tenantId) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id: tenantId },
      })
    );
    return { success: true };
  }
}

module.exports = CompanyModel;
