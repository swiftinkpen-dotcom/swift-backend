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

const TABLE_NAME = TABLES.devices;

/**
 * Device Model for managing BioMax, eSSL, and ZKTeco biometric terminals on AWS DynamoDB.
 */
class DeviceModel {
  /**
   * Initializes DynamoDB composite table for Devices
   */
  static async initTable() {
    return await ensureCompositeTable(TABLE_NAME, "tenantId", "id");
  }

  /**
   * Finds a device across all tenants or unassigned pool by serial number
   * @param {string} serialNumber - Biometric hardware serial number
   * @returns {Promise<object|null>}
   */
  static async findBySerialNumber(serialNumber) {
    if (!serialNumber) return null;
    const cleanSN = String(serialNumber).trim();

    try {
      const scanRes = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "serialNumber = :sn",
          ExpressionAttributeValues: { ":sn": cleanSN },
        })
      );

      if (scanRes.Items && scanRes.Items.length > 0) {
        return scanRes.Items[0];
      }
      return null;
    } catch (err) {
      console.error(`[DeviceModel.findBySerialNumber] Error scanning for SN "${cleanSN}":`, err.message);
      return null;
    }
  }

  /**
   * Retrieves a device by tenantId and deviceId
   * @param {string} tenantId
   * @param {string} deviceId
   */
  static async findById(tenantId, deviceId) {
    if (!tenantId || !deviceId) return null;

    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { tenantId, id: deviceId },
        })
      );
      return res.Item || null;
    } catch (err) {
      console.error(`[DeviceModel.findById] Error fetching device ${deviceId}:`, err.message);
      return null;
    }
  }

  /**
   * Lists all devices for a given company tenant with real-time computed online/offline status
   * @param {string} tenantId - Company tenant identifier
   * @returns {Promise<Array<object>>}
   */
  static async listByTenant(tenantId) {
    if (!tenantId) return [];

    let items = [];
    try {
      const queryRes = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "tenantId = :tId",
          ExpressionAttributeValues: { ":tId": tenantId },
        })
      );
      items = queryRes.Items || [];
    } catch (queryErr) {
      console.warn(`[DeviceModel.listByTenant] Query failed, falling back to Scan:`, queryErr.message);
      const scanRes = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "tenantId = :tId",
          ExpressionAttributeValues: { ":tId": tenantId },
        })
      );
      items = scanRes.Items || [];
    }

    // Compute online status based on 10-minute heartbeat threshold
    const thresholdMinutes = 10;
    const now = Date.now();

    return items.map((dev) => {
      let liveStatus = dev.status || "OFFLINE";
      if (dev.lastHeartbeat) {
        const diffMinutes = (now - new Date(dev.lastHeartbeat).getTime()) / (1000 * 60);
        liveStatus = diffMinutes <= thresholdMinutes ? "ONLINE" : "OFFLINE";
      } else {
        liveStatus = "OFFLINE";
      }

      return {
        ...dev,
        computedStatus: liveStatus,
      };
    });
  }

  /**
   * Records or updates a device heartbeat upon ADMS handshake or punch push
   * @param {object} params
   * @param {string} params.serialNumber
   * @param {string} [params.ipAddress]
   * @param {string} [params.pushVersion]
   * @param {string} [params.tenantId]
   * @returns {Promise<object>}
   */
  static async upsertHeartbeat({ serialNumber, ipAddress, pushVersion, tenantId }) {
    if (!serialNumber) throw new Error("serialNumber is required");
    const cleanSN = String(serialNumber).trim();

    // Check if device already registered
    const existing = await this.findBySerialNumber(cleanSN);
    const now = new Date().toISOString();

    if (existing) {
      const updated = {
        ...existing,
        lastHeartbeat: now,
        status: "ONLINE",
        ipAddress: ipAddress || existing.ipAddress || "127.0.0.1",
        pushVersion: pushVersion || existing.pushVersion || "2.4.1",
        tenantId: tenantId || existing.tenantId || "unassigned",
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

    // Auto-create new device entry
    const newDevice = {
      id: `dev_${cleanSN.toLowerCase()}`,
      tenantId: tenantId || "unassigned",
      serialNumber: cleanSN,
      name: `BioMax Terminal (${cleanSN})`,
      model: "BioMax / eSSL ADMS",
      ipAddress: ipAddress || "127.0.0.1",
      pushVersion: pushVersion || "2.4.1",
      status: "ONLINE",
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: newDevice,
      })
    );

    return newDevice;
  }

  /**
   * Registers or updates a device explicitly under a tenant
   * @param {object} deviceData
   */
  static async create(deviceData) {
    const { tenantId, serialNumber, name, model, ipAddress } = deviceData;
    if (!tenantId || !serialNumber) {
      throw new Error("tenantId and serialNumber are required");
    }

    const cleanSN = String(serialNumber).trim();
    const existing = await this.findBySerialNumber(cleanSN);
    const now = new Date().toISOString();

    // If existing under another key/tenant, delete old key to prevent duplicate SNs
    if (existing && (existing.tenantId !== tenantId || existing.id !== (deviceData.id || `dev_${cleanSN.toLowerCase()}`))) {
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { tenantId: existing.tenantId, id: existing.id },
          })
        );
      } catch (delErr) {
        console.warn(`[DeviceModel.create] Failed to prune old record:`, delErr.message);
      }
    }

    const id = deviceData.id || (existing ? existing.id : `dev_${cleanSN.toLowerCase()}`);
    const deviceItem = {
      id,
      tenantId,
      serialNumber: cleanSN,
      name: name?.trim() || `BioMax Terminal (${cleanSN})`,
      model: model || "BioMax / eSSL ADMS",
      ipAddress: ipAddress || existing?.ipAddress || "127.0.0.1",
      status: existing?.status || "OFFLINE",
      lastHeartbeat: existing?.lastHeartbeat || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: deviceItem,
      })
    );

    return deviceItem;
  }

  /**
   * Updates device attributes
   */
  static async update(tenantId, deviceId, updateData) {
    const existing = await this.findById(tenantId, deviceId);
    if (!existing) {
      throw new Error(`Device "${deviceId}" not found in tenant "${tenantId}"`);
    }

    const updated = {
      ...existing,
      ...updateData,
      id: deviceId,
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
   * Deletes a device from DynamoDB
   */
  static async delete(tenantId, deviceId) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { tenantId, id: deviceId },
      })
    );
    return { success: true };
  }
}

module.exports = DeviceModel;
