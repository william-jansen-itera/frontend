import { invokeSecretFunction } from '@/server/utils/secretFunctionClient';
import {
  ensurePersonalCacheLeafPath,
  findPersonalCacheLeafPathNode,
} from '@/server/utils/agent/personalCacheTreeRepository';
import { withSqlConnection } from '@/server/utils/sql';
import { queryTreeNodeDetailRecord, upsertTreeNodeDetails } from '@/server/utils/tree/treeRecordRepository';

function normalizeProviderLabel(provider) {
  const normalizedProvider = String(provider ?? '').trim();

  if (!normalizedProvider) {
    return 'Hover';
  }

  return normalizedProvider.charAt(0).toUpperCase() + normalizedProvider.slice(1);
}

function normalizeSecretMetadata(value) {
  const candidate = typeof value === 'string'
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })()
    : value;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const secretName = String(candidate.secretName ?? '').trim();

  if (!secretName) {
    return null;
  }

  return {
    provider: String(candidate.provider ?? 'azure_key_vault').trim() || 'azure_key_vault',
    secretName,
    version: String(candidate.version ?? '').trim() || null,
    vaultUrl: String(candidate.vaultUrl ?? '').trim() || null,
    displayLabel: String(candidate.displayLabel ?? '').trim() || secretName,
  };
}

function serializeSecretMetadata(secretMetadata) {
  return secretMetadata ? JSON.stringify(secretMetadata) : null;
}

const EMAIL_ACCOUNT_NODE_NAME = 'Account';

function buildProviderSecretPath(provider) {
  return ['Email', normalizeProviderLabel(provider), 'Secrets', EMAIL_ACCOUNT_NODE_NAME];
}

function toPositivePort(value, label) {
  const parsedValue = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsedValue;
}

function normalizeBasicAuthSection(value, defaults = {}) {
  const host = String(value?.host ?? defaults.host ?? '').trim();
  const user = String(value?.user ?? defaults.user ?? '').trim();
  const password = String(value?.password ?? defaults.password ?? '').trim();
  const authType = String(value?.authType ?? defaults.authType ?? 'basic').trim().toLowerCase() || 'basic';

  if (!host) {
    throw new Error('Email account host is required.');
  }

  if (!user) {
    throw new Error('Email account user is required.');
  }

  if (!password) {
    throw new Error('Email account password is required.');
  }

  if (authType !== 'basic') {
    throw new Error(`Unsupported auth type: ${authType}`);
  }

  return {
    host,
    port: toPositivePort(value?.port ?? defaults.port, `${host} port`),
    secure: value?.secure === undefined ? Boolean(defaults.secure ?? true) : Boolean(value.secure),
    authType,
    user,
    password,
  };
}

export function normalizeEmailAccountConfig(value) {
  const candidate = typeof value === 'string'
    ? JSON.parse(value)
    : value;
  const provider = String(candidate?.provider ?? 'hover').trim().toLowerCase() || 'hover';

  return {
    provider,
    label: normalizeProviderLabel(provider),
    imap: normalizeBasicAuthSection(candidate?.imap, {
      host: provider === 'hover' ? 'mail.hover.com' : undefined,
      port: provider === 'hover' ? 993 : undefined,
      secure: true,
    }),
    smtp: normalizeBasicAuthSection(candidate?.smtp, {
      host: provider === 'hover' ? 'mail.hover.com' : undefined,
      port: provider === 'hover' ? 465 : undefined,
      secure: true,
    }),
  };
}

export async function ensureEmailAccountConfigLeaf({ treeId, provider = 'hover' }) {
  return ensurePersonalCacheLeafPath({
    treeId,
    pathSegments: buildProviderSecretPath(provider),
  });
}

export async function storeEmailAccountConfig({ treeId, provider = 'hover', accountConfig, updatedBy = null }) {
  return withSqlConnection(async () => {
    const leafNode = await ensureEmailAccountConfigLeaf({ treeId, provider });
    const existingRecord = await queryTreeNodeDetailRecord(treeId, leafNode.id);
    const existingSecretMetadata = normalizeSecretMetadata(existingRecord?.secretMetadata);
    const normalizedConfig = normalizeEmailAccountConfig(accountConfig);
    const brokerResult = await invokeSecretFunction({
      action: 'set-secret',
      treeId: String(treeId),
      nodeId: String(leafNode.id),
      secretValue: JSON.stringify(normalizedConfig),
      secretMetadata: existingSecretMetadata,
    });
    const secretMetadata = normalizeSecretMetadata(brokerResult?.secretMetadata);

    await upsertTreeNodeDetails({
      nodeId: leafNode.id,
      notes: `${normalizeProviderLabel(provider)} email account config`,
      isSecret: true,
      secretMetadata: serializeSecretMetadata(secretMetadata),
      updatedBy,
    });

    return {
      nodeId: String(leafNode.id),
      provider: normalizedConfig.provider,
      label: normalizedConfig.label,
      secretMetadata,
    };
  });
}

export async function loadEmailAccountConfig({ treeId, provider = 'hover' }) {
  return withSqlConnection(async () => {
    const leafNode = await findPersonalCacheLeafPathNode({
      treeId,
      pathSegments: buildProviderSecretPath(provider),
    });

    if (!leafNode) {
      throw new Error(`Email account settings were not found for provider ${normalizeProviderLabel(provider)}.`);
    }

    const record = await queryTreeNodeDetailRecord(treeId, leafNode.id);
    const secretMetadata = normalizeSecretMetadata(record?.secretMetadata);

    if (!record?.isSecret || !secretMetadata) {
      throw new Error(`Email account secret is not configured for provider ${normalizeProviderLabel(provider)}.`);
    }

    const brokerResult = await invokeSecretFunction({
      action: 'get-secret',
      treeId: String(treeId),
      nodeId: String(leafNode.id),
      secretMetadata,
    });

    return {
      nodeId: String(leafNode.id),
      secretMetadata: normalizeSecretMetadata(brokerResult?.secretMetadata) ?? secretMetadata,
      accountConfig: normalizeEmailAccountConfig(brokerResult?.secretValue),
    };
  });
}