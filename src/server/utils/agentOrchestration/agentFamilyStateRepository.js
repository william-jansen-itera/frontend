import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

function normalizeFamilyName(family) {
  return String(family ?? '').trim();
}

function normalizeReason(reason) {
  const normalizedReason = String(reason ?? '').trim();
  return normalizedReason || null;
}

function normalizeUpdatedBy(updatedBy) {
  return {
    updatedByObjectId: String(updatedBy?.updatedByObjectId ?? '').trim() || null,
    updatedByUserDetails: String(updatedBy?.updatedByUserDetails ?? '').trim() || null,
  };
}

function buildDefaultFamilyState(family) {
  return {
    family,
    isActive: true,
    reason: null,
    updatedAt: null,
    updatedByObjectId: null,
    updatedByUserDetails: null,
    isPersisted: false,
  };
}

function mapFamilyStateRow(row) {
  const family = normalizeFamilyName(row?.family);

  if (!family) {
    return null;
  }

  return {
    family,
    isActive: Boolean(row?.isActive),
    reason: normalizeReason(row?.reason),
    updatedAt: row?.updatedAt ?? null,
    updatedByObjectId: String(row?.updatedByObjectId ?? '').trim() || null,
    updatedByUserDetails: String(row?.updatedByUserDetails ?? '').trim() || null,
    isPersisted: true,
  };
}

export async function getAgentFamilyState(family) {
  const normalizedFamily = normalizeFamilyName(family);

  if (!normalizedFamily) {
    throw new Error('Agent family is required');
  }

  const applicationIdentifier = getRequiredApplicationIdentifier();

  return withSqlConnection(async (pool) => {
    const result = await pool.request()
      .input('application_identifier', sql.NVarChar(200), applicationIdentifier)
      .input('family', sql.NVarChar(100), normalizedFamily)
      .query(`
        SELECT TOP (1)
          family,
          is_active AS isActive,
          reason,
          updated_at AS updatedAt,
          updated_by_object_id AS updatedByObjectId,
          updated_by_user_details AS updatedByUserDetails
        FROM dbo.agent_family_state
        WHERE application_identifier = @application_identifier
          AND family = @family
      `);

    return mapFamilyStateRow(result.recordset?.[0]) ?? buildDefaultFamilyState(normalizedFamily);
  });
}

export async function listAgentFamilyStates() {
  const applicationIdentifier = getRequiredApplicationIdentifier();

  return withSqlConnection(async (pool) => {
    const result = await pool.request()
      .input('application_identifier', sql.NVarChar(200), applicationIdentifier)
      .query(`
        SELECT
          family,
          is_active AS isActive,
          reason,
          updated_at AS updatedAt,
          updated_by_object_id AS updatedByObjectId,
          updated_by_user_details AS updatedByUserDetails
        FROM dbo.agent_family_state
        WHERE application_identifier = @application_identifier
      `);

    return Array.isArray(result.recordset)
      ? result.recordset.map(mapFamilyStateRow).filter(Boolean)
      : [];
  });
}

export async function setAgentFamilyActiveState(family, { isActive, reason = null, updatedBy = null } = {}) {
  const normalizedFamily = normalizeFamilyName(family);

  if (!normalizedFamily) {
    throw new Error('Agent family is required');
  }

  if (typeof isActive !== 'boolean') {
    throw new Error('Agent family active state must be provided');
  }

  const applicationIdentifier = getRequiredApplicationIdentifier();
  const normalizedUpdatedBy = normalizeUpdatedBy(updatedBy);
  const normalizedReason = normalizeReason(reason);

  return withSqlConnection(async (pool) => {
    const result = await pool.request()
      .input('application_identifier', sql.NVarChar(200), applicationIdentifier)
      .input('family', sql.NVarChar(100), normalizedFamily)
      .input('is_active', sql.Bit, isActive)
      .input('reason', sql.NVarChar(500), normalizedReason)
      .input('updated_by_object_id', sql.NVarChar(100), normalizedUpdatedBy.updatedByObjectId)
      .input('updated_by_user_details', sql.NVarChar(320), normalizedUpdatedBy.updatedByUserDetails)
      .query(`
        UPDATE dbo.agent_family_state
        SET
          is_active = @is_active,
          reason = @reason,
          updated_by_object_id = @updated_by_object_id,
          updated_by_user_details = @updated_by_user_details
        WHERE application_identifier = @application_identifier
          AND family = @family;

        IF @@ROWCOUNT = 0
        BEGIN
          INSERT INTO dbo.agent_family_state (
            application_identifier,
            family,
            is_active,
            reason,
            updated_by_object_id,
            updated_by_user_details
          )
          VALUES (
            @application_identifier,
            @family,
            @is_active,
            @reason,
            @updated_by_object_id,
            @updated_by_user_details
          );
        END;

        SELECT TOP (1)
          family,
          is_active AS isActive,
          reason,
          updated_at AS updatedAt,
          updated_by_object_id AS updatedByObjectId,
          updated_by_user_details AS updatedByUserDetails
        FROM dbo.agent_family_state
        WHERE application_identifier = @application_identifier
          AND family = @family;
      `);

    return mapFamilyStateRow(result.recordset?.[0]) ?? buildDefaultFamilyState(normalizedFamily);
  });
}