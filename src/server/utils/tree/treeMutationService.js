import {
  deleteNodeAttachmentBlobIfExists,
  restoreNodeAttachmentBlobIfDeleted,
  uploadNodeAttachment,
} from '@/server/utils/blobStorage';
import {
  generateChatLeafPathPlan,
  generateChildTitlesFromBreadcrumb,
  generateLeafNotesFromChatAnswer,
  generateLeafNotesDraft,
  selectChatLeafAnchorCandidate,
} from '@/server/utils/tree/treeGenerationService';
import { requestTreeSqlIndexerRun } from '@/server/utils/azureSearch';
import { logException, logTrace } from '@/server/utils/logging';
import { invokeSecretFunction } from '@/server/utils/secretFunctionClient';
import { sql, withSqlConnection } from '@/server/utils/sql';
import { listActiveTreeSubtreeAttachments, softDeleteTreeSubtree } from '@/server/utils/tree/treePathRepository';
import {
  applyAttachmentReviewStatus,
  applyTreeNodeReviewStatus,
  assertLeafNode,
  createAttachmentMetadataRecord,
  createTreeNodeRecord,
  ensureTreeNodeDetailsRow,
  getDescendantSecretMetadata,
  getNodeDetails,
  getNodeGenerationContext,
  getTreeMaxDepth,
  queryAttachmentDeleteRecord,
  queryAttachmentRecord,
  queryNodeDetails,
  queryTreeData,
  queryTreeNode,
  queryTreeNodeDetailRecord,
  queryTreeSummary,
  softDeleteAttachmentMetadataRecord,
  updateTreeNodeText,
  upsertTreeNodeDetails,
} from '@/server/utils/tree/treeRecordRepository';
import { assertTreeAccess, getAuditMetadata } from '@/server/utils/tree/treeCatalog';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const REVIEW_STATUS_DRAFT = 'draft';
const REVIEW_STATUS_SUBMITTED = 'submitted';
const REVIEW_STATUS_APPROVED = 'approved';
const REVIEW_STATUS_REJECTED = 'rejected';
const SECRET_PROVIDER_AZURE_KEY_VAULT = 'azure_key_vault';
const DEFAULT_SECRET_REFERENCE_LABEL = 'Stored Key Vault secret';
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.csv',
  '.doc',
  '.docx',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.json',
  '.md',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.txt',
  '.webp',
  '.xls',
  '.xlsx',
  '.yaml',
  '.yml',
]);

function createStatusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeReviewStatus(value, fallback = REVIEW_STATUS_DRAFT) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (
    normalizedValue === REVIEW_STATUS_DRAFT
    || normalizedValue === REVIEW_STATUS_SUBMITTED
    || normalizedValue === REVIEW_STATUS_APPROVED
    || normalizedValue === REVIEW_STATUS_REJECTED
  ) {
    return normalizedValue;
  }

  return fallback;
}

function normalizeRejectionComment(value, { required = false } = {}) {
  const normalizedValue = String(value ?? '').trim();

  if (!normalizedValue) {
    if (required) {
      throw createStatusError('A rejection comment is required', 400);
    }

    return null;
  }

  return normalizedValue.slice(0, 2000);
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

  const provider = String(candidate.provider ?? SECRET_PROVIDER_AZURE_KEY_VAULT).trim() || SECRET_PROVIDER_AZURE_KEY_VAULT;
  const secretName = String(candidate.secretName ?? '').trim();
  const version = String(candidate.version ?? '').trim() || null;
  const vaultUrl = String(candidate.vaultUrl ?? '').trim() || null;
  const displayLabel = String(candidate.displayLabel ?? '').trim() || secretName || null;

  if (!secretName) {
    return null;
  }

  return {
    provider,
    secretName,
    version,
    vaultUrl,
    displayLabel,
  };
}

function serializeSecretMetadata(value) {
  const normalizedMetadata = normalizeSecretMetadata(value);

  return normalizedMetadata ? JSON.stringify(normalizedMetadata) : null;
}

function buildSecretReference(secretMetadata) {
  const normalizedMetadata = normalizeSecretMetadata(secretMetadata);

  if (!normalizedMetadata) {
    return null;
  }

  return {
    provider: normalizedMetadata.provider,
    version: normalizedMetadata.version,
    displayLabel: DEFAULT_SECRET_REFERENCE_LABEL,
    hasStoredSecret: true,
  };
}

async function deleteStoredSecrets(treeInstanceId, secretRecords) {
  for (const secretRecord of secretRecords) {
    await invokeSecretFunction({
      action: 'delete-secret',
      treeId: String(treeInstanceId),
      nodeId: String(secretRecord.treeNodeId),
      secretMetadata: secretRecord.secretMetadata,
    });
  }
}

function resolveNextReviewStatus(currentStatus, reviewAction) {
  const normalizedAction = String(reviewAction ?? '').trim().toLowerCase();
  const normalizedStatus = normalizeReviewStatus(currentStatus, REVIEW_STATUS_DRAFT);

  if (normalizedAction === 'submit') {
    if (normalizedStatus === REVIEW_STATUS_DRAFT || normalizedStatus === REVIEW_STATUS_REJECTED) {
      return REVIEW_STATUS_SUBMITTED;
    }

    throw createStatusError(`Cannot submit a ${normalizedStatus} item for review`, 400);
  }

  if (normalizedAction === 'unsubmit') {
    if (normalizedStatus === REVIEW_STATUS_SUBMITTED) {
      return REVIEW_STATUS_DRAFT;
    }

    throw createStatusError(`Cannot unsubmit a ${normalizedStatus} item`, 400);
  }

  if (normalizedAction === 'approve') {
    if (normalizedStatus === REVIEW_STATUS_SUBMITTED) {
      return REVIEW_STATUS_APPROVED;
    }

    throw createStatusError(`Cannot approve a ${normalizedStatus} item`, 400);
  }

  if (normalizedAction === 'reject') {
    if (normalizedStatus === REVIEW_STATUS_SUBMITTED) {
      return REVIEW_STATUS_REJECTED;
    }

    throw createStatusError(`Cannot reject a ${normalizedStatus} item`, 400);
  }

  throw createStatusError('A valid review action is required', 400);
}

async function requestIndexerRefreshForMutation(treeInstanceId, mutationLabel) {
  try {
    const indexerRun = await requestTreeSqlIndexerRun();

    if (indexerRun.status === 'requested' || indexerRun.status === 'already-running') {
      await logTrace(`Requested Azure Search indexer refresh for tree ${treeInstanceId} after ${mutationLabel} (${indexerRun.status}).`);
    }

    return indexerRun;
  } catch (indexerError) {
    await logException(indexerError);

    return {
      status: 'failed',
      message: indexerError instanceof Error ? indexerError.message : 'Azure Search indexer request failed.',
    };
  }
}

function buildBreadcrumbByNodeId(flatData) {
  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const breadcrumbByNodeId = new Map();

  flatData.forEach((node) => {
    const breadcrumbParts = [];
    let currentNode = node;

    while (currentNode) {
      const currentName = String(currentNode.name ?? '').trim();
      if (currentName) {
        breadcrumbParts.unshift(currentName);
      }

      const parentId = currentNode.parent;
      currentNode = parentId === null || parentId === undefined ? null : nodeById.get(String(parentId)) ?? null;
    }

    breadcrumbByNodeId.set(String(node.id), breadcrumbParts.join(' > '));
  });

  return breadcrumbByNodeId;
}

function buildBreadcrumbTitlesByNodeId(flatData) {
  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const breadcrumbTitlesByNodeId = new Map();

  flatData.forEach((node) => {
    const breadcrumbTitles = [];
    let currentNode = node;

    while (currentNode) {
      const currentName = String(currentNode.name ?? '').trim();

      if (currentName) {
        breadcrumbTitles.unshift(currentName);
      }

      const parentId = currentNode.parent;
      currentNode = parentId === null || parentId === undefined ? null : nodeById.get(String(parentId)) ?? null;
    }

    breadcrumbTitlesByNodeId.set(String(node.id), breadcrumbTitles);
  });

  return breadcrumbTitlesByNodeId;
}

function buildResolvedBreadcrumb(anchorBreadcrumbTitles, generatedPathTitles) {
  return [...anchorBreadcrumbTitles, ...generatedPathTitles].filter(Boolean).join(' > ');
}

async function getChatLeafPlacementContext(treeInstanceId) {
  const [flatData, treeSummary, maxDepth] = await Promise.all([
    queryTreeData(treeInstanceId),
    queryTreeSummary(treeInstanceId),
    getTreeMaxDepth(treeInstanceId),
  ]);
  const breadcrumbByNodeId = buildBreadcrumbByNodeId(flatData);
  const breadcrumbTitlesByNodeId = buildBreadcrumbTitlesByNodeId(flatData);
  const candidates = flatData
    .filter((node) => !node.isLeafNode)
    .map((node) => {
      const depth = Number(node._depth);
      const remainingDepthBudget = Number.isFinite(maxDepth) ? maxDepth - depth : Number.NaN;

      return {
        nodeId: String(node.id),
        breadcrumb: breadcrumbByNodeId.get(String(node.id)) || String(node.name ?? '').trim(),
        breadcrumbTitles: breadcrumbTitlesByNodeId.get(String(node.id)) ?? [],
        depth,
        remainingDepthBudget,
        directLeafPossible: remainingDepthBudget === 1,
      };
    })
    .filter((candidate) => candidate.depth >= 0)
    .filter((candidate) => Number.isFinite(candidate.remainingDepthBudget) && candidate.remainingDepthBudget >= 1)
    .map((node) => ({
      nodeId: node.nodeId,
      breadcrumb: node.breadcrumb,
      breadcrumbTitles: node.breadcrumbTitles,
      depth: node.depth,
      remainingDepthBudget: node.remainingDepthBudget,
      directLeafPossible: node.directLeafPossible,
    }));

  return {
    treeName: treeSummary.treeName,
    maxDepth,
    candidates,
  };
}

async function resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer }) {
  const normalizedOriginalQuestion = String(originalQuestion ?? '').trim();
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();

  if (!normalizedOriginalQuestion || !normalizedBroaderAnswer) {
    throw new Error('The chat add action requires the original question and broader answer content.');
  }

  const { treeName, maxDepth, candidates } = await getChatLeafPlacementContext(treeInstanceId);

  let selectedCandidate = null;

  if (candidates.length > 0) {
    const selection = await selectChatLeafAnchorCandidate({
      treeName,
      originalQuestion: normalizedOriginalQuestion,
      broaderAnswer: normalizedBroaderAnswer,
      candidates,
    });

    if (selection.selectionDisposition === 'selected_anchor') {
      selectedCandidate = candidates.find((candidate) => candidate.nodeId === selection.selectedAnchorNodeId) ?? null;

      if (!selectedCandidate) {
        throw new Error('The selected anchor path was not valid for the target tree.');
      }

      if (selectedCandidate.directLeafPossible) {
        return {
          treeId: String(treeInstanceId),
          treeName,
          placementMode: 'direct_leaf_from_anchor',
          selectedAnchorNodeId: selectedCandidate.nodeId,
          selectedAnchorBreadcrumb: selection.selectedBreadcrumb || selectedCandidate.breadcrumb,
          generatedPathTitles: [],
          plannedLeafParentBreadcrumb: selection.selectedBreadcrumb || selectedCandidate.breadcrumb,
          generatedLeafTitle: selection.generatedLeafTitle,
          originalQuestion: normalizedOriginalQuestion,
          broaderAnswer: normalizedBroaderAnswer,
        };
      }
    }
  }

  if (!Number.isFinite(maxDepth) || maxDepth < 0) {
    throw new Error(`Tree depth is not configured for ${treeName}.`);
  }

  const requiredPathTitleCount = selectedCandidate
    ? selectedCandidate.remainingDepthBudget - 1
    : maxDepth;
  const pathPlan = await generateChatLeafPathPlan({
    treeName,
    originalQuestion: normalizedOriginalQuestion,
    broaderAnswer: normalizedBroaderAnswer,
    anchorBreadcrumbTitles: selectedCandidate?.breadcrumbTitles ?? [],
    requiredPathTitleCount,
  });

  const anchorBreadcrumbTitles = selectedCandidate?.breadcrumbTitles ?? [];
  const plannedLeafParentBreadcrumb = buildResolvedBreadcrumb(anchorBreadcrumbTitles, pathPlan.pathTitles);

  return {
    treeId: String(treeInstanceId),
    treeName,
    placementMode: selectedCandidate ? 'anchor_with_intermediates' : 'full_path_from_root',
    selectedAnchorNodeId: selectedCandidate?.nodeId ?? '',
    selectedAnchorBreadcrumb: selectedCandidate?.breadcrumb ?? '',
    generatedPathTitles: pathPlan.pathTitles,
    plannedLeafParentBreadcrumb,
    generatedLeafTitle: pathPlan.generatedLeafTitle,
    originalQuestion: normalizedOriginalQuestion,
    broaderAnswer: normalizedBroaderAnswer,
  };
}

async function createChatLeafPlacementRecords({
  treeInstanceId,
  selectedAnchorNodeId,
  generatedPathTitles,
  generatedLeafTitle,
  transaction,
}) {
  let currentParentId = selectedAnchorNodeId ? parseInt(selectedAnchorNodeId, 10) : null;
  const createdIntermediateNodes = [];

  for (const title of generatedPathTitles) {
    const createdNode = await createTreeNodeRecord({
      parentId: currentParentId,
      treeInstanceId,
      name: title,
      ensureLeafDetails: false,
      transaction,
    });

    if (createdNode.isLeafNode) {
      throw new Error('The chat add action generated too many intermediate path levels for the target tree.');
    }

    createdIntermediateNodes.push({
      createdNodeId: createdNode.createdNodeId,
      title,
    });
    currentParentId = parseInt(createdNode.createdNodeId, 10);
  }

  const createdLeafNode = await createTreeNodeRecord({
    parentId: currentParentId,
    treeInstanceId,
    name: generatedLeafTitle,
    ensureLeafDetails: true,
    transaction,
  });

  if (!createdLeafNode.isLeafNode) {
    throw new Error('The chat add action must create a leaf node.');
  }

  return {
    createdIntermediateNodes,
    createdLeafNode,
    finalParentNodeId: currentParentId === null ? null : String(currentParentId),
  };
}

async function updateTreeNodeDetailsRecord({ treeInstanceId, nodeId, name, notes, updatedBy = null, transaction }) {
  const trimmedName = String(name ?? '').trim();

  if (!trimmedName) {
    throw new Error('A non-empty leaf title is required.');
  }

  const treeNode = await queryTreeNode(treeInstanceId, nodeId, transaction);

  if (!treeNode) {
    throw new Error('Node was not found for the selected tree');
  }

  const updatedNodeCount = await updateTreeNodeText({
    treeInstanceId,
    nodeId,
    text: trimmedName,
    transaction,
  });

  if (!updatedNodeCount) {
    throw new Error('Node was not found for the selected tree');
  }

  if (!treeNode.isLeafNode) {
    throw new Error('Only leaf nodes can be updated through the chat add action.');
  }

  await upsertTreeNodeDetails({
    nodeId,
    notes: notes ?? '',
    updatedBy,
    transaction,
  });
}

function validateAttachmentFile(file) {
  if (!file || typeof file.name !== 'string') {
    throw new Error('Upload request did not include a valid file');
  }

  const normalizedFileName = file.name.toLowerCase();
  const extensionIndex = normalizedFileName.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? normalizedFileName.slice(extensionIndex) : '';

  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error(`File type is not allowed for uploads: ${file.name}`);
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File exceeds the 10 MB upload limit: ${file.name}`);
  }
}

export function normalizeUpdatedByMetadata(principal) {
  const auditMetadata = getAuditMetadata(principal);

  return {
    updatedByObjectId: auditMetadata.updatedByObjectId,
    updatedByUserDetails: auditMetadata.updatedByUserDetails,
  };
}

export async function previewLeafFromChat({ treeInstanceId, originalQuestion, broaderAnswer }) {
  return resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer });
}

export async function generateChildrenForNode(treeInstanceId, nodeId) {
  return withSqlConnection(async () => {
    const generationContext = await getNodeGenerationContext(treeInstanceId, nodeId);

    if (!generationContext) {
      throw createStatusError('Node was not found for the selected tree', 404);
    }

    if (generationContext.isLeafNode) {
      throw createStatusError('Cannot generate child nodes for a leaf node', 400);
    }

    const generatedChildren = await generateChildTitlesFromBreadcrumb({
      treeName: generationContext.treeName,
      breadcrumbTitles: generationContext.breadcrumbTitles,
      generateLeafChildren: generationContext.generatedChildIsLeaf,
    });

    const transaction = new sql.Transaction();
    const createdNodeIds = [];

    try {
      await transaction.begin();

      for (const child of generatedChildren.children) {
        const createdNode = await createTreeNodeRecord({
          parentId: nodeId,
          treeInstanceId,
          name: child.title,
          ensureLeafDetails: true,
          transaction,
        });

        createdNodeIds.push(createdNode.createdNodeId);
      }

      await transaction.commit();
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }

    return {
      createdNodeIds,
      flatData: await queryTreeData(treeInstanceId),
    };
  });
}

export async function generateNotesForNode(treeInstanceId, nodeId) {
  return withSqlConnection(async () => {
    const generationContext = await getNodeGenerationContext(treeInstanceId, nodeId);

    if (!generationContext) {
      throw createStatusError('Node was not found for the selected tree', 404);
    }

    if (!generationContext.isLeafNode) {
      throw createStatusError('Cannot generate notes for a non-leaf node', 400);
    }

    const generatedDraft = await generateLeafNotesDraft({
      treeName: generationContext.treeName,
      breadcrumbTitles: generationContext.breadcrumbTitles,
    });

    return {
      notes: generatedDraft.notes,
    };
  });
}

export async function deleteTreeNode({ id, treeInstanceId }) {
  return withSqlConnection(async () => {
    const [attachments, secrets] = await Promise.all([
      listActiveTreeSubtreeAttachments({ treeId: treeInstanceId, rootNodeId: id }),
      getDescendantSecretMetadata(treeInstanceId, id),
    ]);
    const deletedBlobNames = [];

    try {
      for (const attachment of attachments) {
        const deleted = await deleteNodeAttachmentBlobIfExists(attachment.blobName);

        if (deleted) {
          deletedBlobNames.push(attachment.blobName);
        }
      }

      await deleteStoredSecrets(treeInstanceId, secrets);

      const transaction = new sql.Transaction();

      try {
        await transaction.begin();
        const deletedAttachments = await softDeleteTreeSubtree({
          treeId: treeInstanceId,
          rootNodeId: id,
          transaction,
        });

        if (!deletedAttachments) {
          throw new Error('Node was not found for the selected tree');
        }

        await transaction.commit();
      } catch (error) {
        if (transaction._aborted !== true) {
          await transaction.rollback();
        }

        throw error;
      }

      return queryTreeData(treeInstanceId);
    } catch (error) {
      for (const blobName of deletedBlobNames) {
        await restoreNodeAttachmentBlobIfDeleted(blobName);
      }

      throw error;
    }
  });
}

export async function transitionTreeNodeReviewStatus({ treeInstanceId, nodeId, principal, reviewAction, rejectionComment = null }) {
  const scopedTree = await assertTreeAccess(treeInstanceId, {
    principal,
    visibility: 'both',
    requireWriteAccess: true,
  });

  if (!scopedTree.approvalEnabled) {
    throw createStatusError('Review is not enabled for this tree', 400);
  }

  const actor = normalizeUpdatedByMetadata(principal);

  if (!String(actor.updatedByObjectId ?? '').trim()) {
    throw createStatusError('Authentication is required to review this node', 401);
  }

  const treeNode = await queryTreeNode(treeInstanceId, nodeId);

  if (!treeNode) {
    throw createStatusError('Node was not found for the selected tree', 404);
  }

  const nextReviewStatus = resolveNextReviewStatus(treeNode.reviewStatus, reviewAction);
  const isSubmitAction = nextReviewStatus === REVIEW_STATUS_SUBMITTED;
  const normalizedRejectionComment = nextReviewStatus === REVIEW_STATUS_REJECTED
    ? normalizeRejectionComment(rejectionComment, { required: true })
    : null;

  await applyTreeNodeReviewStatus({
    treeInstanceId,
    nodeId,
    reviewStatus: nextReviewStatus,
    submittedByObjectId: isSubmitAction ? actor.updatedByObjectId : null,
    submittedByUserDetails: isSubmitAction ? actor.updatedByUserDetails : null,
    reviewedByObjectId: isSubmitAction ? null : actor.updatedByObjectId,
    reviewedByUserDetails: isSubmitAction ? null : actor.updatedByUserDetails,
    rejectionComment: normalizedRejectionComment,
  });

  return {
    flatData: await queryTreeData(treeInstanceId),
    details: await queryNodeDetails(treeInstanceId, nodeId),
  };
}

export async function transitionAttachmentReviewStatus({ treeInstanceId, attachmentId, principal, reviewAction, rejectionComment = null }) {
  const scopedTree = await assertTreeAccess(treeInstanceId, {
    principal,
    visibility: 'both',
    requireWriteAccess: true,
  });

  if (!scopedTree.approvalEnabled) {
    throw createStatusError('Review is not enabled for this tree', 400);
  }

  const actor = normalizeUpdatedByMetadata(principal);

  if (!String(actor.updatedByObjectId ?? '').trim()) {
    throw createStatusError('Authentication is required to review this attachment', 401);
  }

  const attachment = await queryAttachmentRecord(treeInstanceId, attachmentId);

  if (!attachment) {
    throw createStatusError('Attachment was not found for the selected tree', 404);
  }

  const nextReviewStatus = resolveNextReviewStatus(attachment.reviewStatus, reviewAction);
  const isSubmitAction = nextReviewStatus === REVIEW_STATUS_SUBMITTED;
  const normalizedRejectionComment = nextReviewStatus === REVIEW_STATUS_REJECTED
    ? normalizeRejectionComment(rejectionComment, { required: true })
    : null;

  await applyAttachmentReviewStatus({
    attachmentId,
    reviewStatus: nextReviewStatus,
    submittedByObjectId: isSubmitAction ? actor.updatedByObjectId : null,
    submittedByUserDetails: isSubmitAction ? actor.updatedByUserDetails : null,
    reviewedByObjectId: isSubmitAction ? null : actor.updatedByObjectId,
    reviewedByUserDetails: isSubmitAction ? null : actor.updatedByUserDetails,
    rejectionComment: normalizedRejectionComment,
  });

  return queryNodeDetails(treeInstanceId, attachment.treeNodeId);
}

export async function updateTreeNodeDetails(treeInstanceId, nodeId, {
  name,
  notes,
  isSecret = false,
  secretValue = '',
  secretMetadata = null,
  updatedBy = null,
}) {
  return withSqlConnection(async () => {
    const trimmedName = name.trim();
    const treeNode = await queryTreeNode(treeInstanceId, nodeId);

    if (!treeNode) {
      throw new Error('Node was not found for the selected tree');
    }

    const updateRowCount = await updateTreeNodeText({
      treeInstanceId,
      nodeId,
      text: trimmedName,
    });

    if (!updateRowCount) {
      throw new Error('Node was not found for the selected tree');
    }

    if (!treeNode.isLeafNode) {
      return {
        flatData: await queryTreeData(treeInstanceId),
        details: {
          id: String(nodeId),
          name: trimmedName,
          notes: '',
          attachments: [],
          isLeafNode: false,
        },
      };
    }

    const existingDetails = await queryTreeNodeDetailRecord(treeInstanceId, nodeId);
    const nextIsSecret = Boolean(isSecret);
    const nextNotes = typeof notes === 'string' ? notes : '';
    const nextSecretValue = String(secretValue ?? '').trim();
    const requestedSecretMetadata = normalizeSecretMetadata(secretMetadata);
    const existingSecretMetadata = requestedSecretMetadata ?? normalizeSecretMetadata(existingDetails?.secretMetadata);
    let nextSecretMetadata = null;

    if (nextIsSecret) {
      if (nextSecretValue) {
        const brokerResult = await invokeSecretFunction({
          action: 'set-secret',
          treeId: String(treeInstanceId),
          nodeId: String(nodeId),
          secretValue: nextSecretValue,
          secretMetadata: existingSecretMetadata,
        });

        nextSecretMetadata = normalizeSecretMetadata(brokerResult.secretMetadata);
      } else if (existingSecretMetadata) {
        nextSecretMetadata = existingSecretMetadata;
      } else {
        throw createStatusError('A secret value is required when enabling a secret note', 400);
      }
    } else if (existingSecretMetadata) {
      await invokeSecretFunction({
        action: 'delete-secret',
        treeId: String(treeInstanceId),
        nodeId: String(nodeId),
        secretMetadata: existingSecretMetadata,
      });
    }

    await upsertTreeNodeDetails({
      nodeId,
      notes: nextNotes,
      isSecret: nextIsSecret,
      secretMetadata: serializeSecretMetadata(nextSecretMetadata),
      updatedBy,
    });

    return {
      flatData: await queryTreeData(treeInstanceId),
      details: await queryNodeDetails(treeInstanceId, nodeId, null, treeNode),
    };
  });
}

export async function revealTreeNodeSecret(treeInstanceId, nodeId) {
  return withSqlConnection(async () => {
    const treeNode = await queryTreeNode(treeInstanceId, nodeId);

    if (!treeNode) {
      throw createStatusError('Node was not found for the selected tree', 404);
    }

    if (!treeNode.isLeafNode) {
      throw createStatusError('Only leaf nodes can contain secrets', 400);
    }

    const detailRecord = await queryTreeNodeDetailRecord(treeInstanceId, nodeId);
    const secretMetadata = normalizeSecretMetadata(detailRecord?.secretMetadata);

    if (!detailRecord?.isSecret || !secretMetadata) {
      throw createStatusError('This node does not contain a stored secret', 400);
    }

    const brokerResult = await invokeSecretFunction({
      action: 'get-secret',
      treeId: String(treeInstanceId),
      nodeId: String(nodeId),
      secretMetadata,
    });

    return {
      secretValue: String(brokerResult.secretValue ?? ''),
      secretMetadata: buildSecretReference(secretMetadata),
    };
  });
}

export async function createLeafNodeFromChat({
  treeInstanceId,
  principal,
  toolName,
  originalQuestion,
  broaderAnswer,
  placementMode,
  selectedAnchorNodeId,
  selectedAnchorBreadcrumb,
  generatedPathTitles,
  plannedLeafParentBreadcrumb,
  generatedLeafTitle,
}) {
  const resolvedPlacement = placementMode && generatedLeafTitle
    ? {
      treeId: String(treeInstanceId),
      treeName: (await queryTreeSummary(treeInstanceId)).treeName,
      placementMode: String(placementMode ?? '').trim(),
      selectedAnchorNodeId: String(selectedAnchorNodeId ?? '').trim(),
      selectedAnchorBreadcrumb: String(selectedAnchorBreadcrumb ?? '').trim(),
      generatedPathTitles: Array.isArray(generatedPathTitles)
        ? generatedPathTitles.map((title) => String(title ?? '').trim()).filter(Boolean)
        : [],
      plannedLeafParentBreadcrumb: String(plannedLeafParentBreadcrumb ?? '').trim(),
      generatedLeafTitle: String(generatedLeafTitle ?? '').trim(),
      originalQuestion: String(originalQuestion ?? '').trim(),
      broaderAnswer: String(broaderAnswer ?? '').trim(),
    }
    : await resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer });

  if (!resolvedPlacement.generatedLeafTitle) {
    throw new Error('A generated leaf title is required for the chat add action.');
  }

  const generatedNotes = await generateLeafNotesFromChatAnswer({
    treeName: resolvedPlacement.treeName,
    breadcrumbTitles: [
      ...String(resolvedPlacement.plannedLeafParentBreadcrumb ?? '').split('>').map((title) => title.trim()).filter(Boolean),
      resolvedPlacement.generatedLeafTitle,
    ],
    originalQuestion: resolvedPlacement.originalQuestion,
    broaderAnswer: resolvedPlacement.broaderAnswer,
  });

  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();

    try {
      await transaction.begin();

      const placementResult = await createChatLeafPlacementRecords({
        treeInstanceId,
        selectedAnchorNodeId: resolvedPlacement.selectedAnchorNodeId,
        generatedPathTitles: resolvedPlacement.generatedPathTitles,
        generatedLeafTitle: resolvedPlacement.generatedLeafTitle,
        transaction,
      });

      await updateTreeNodeDetailsRecord({
        treeInstanceId,
        nodeId: parseInt(placementResult.createdLeafNode.createdNodeId, 10),
        name: resolvedPlacement.generatedLeafTitle,
        notes: generatedNotes.notes,
        updatedBy: normalizeUpdatedByMetadata(principal),
        transaction,
      });

      await transaction.commit();

      const indexerRun = await requestIndexerRefreshForMutation(treeInstanceId, 'chat add');

      return {
        treeId: String(treeInstanceId),
        toolName: String(toolName ?? '').trim(),
        placementMode: resolvedPlacement.placementMode,
        createdNodeId: placementResult.createdLeafNode.createdNodeId,
        selectedAnchorNodeId: resolvedPlacement.selectedAnchorNodeId,
        selectedAnchorBreadcrumb: resolvedPlacement.selectedAnchorBreadcrumb,
        plannedLeafParentBreadcrumb: resolvedPlacement.plannedLeafParentBreadcrumb,
        createdIntermediateNodes: placementResult.createdIntermediateNodes,
        generatedLeafTitle: resolvedPlacement.generatedLeafTitle,
        flatData: await queryTreeData(treeInstanceId),
        details: await queryNodeDetails(treeInstanceId, placementResult.createdLeafNode.createdNodeId),
        indexerRun,
      };
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }
  });
}

export async function createTreeNodeAttachment({ treeInstanceId, nodeId, files, updatedBy = null }) {
  return withSqlConnection(async () => {
    await assertLeafNode(treeInstanceId, nodeId);

    await ensureTreeNodeDetailsRow(nodeId);

    const uploadedBlobNames = [];

    try {
      for (const file of files) {
        validateAttachmentFile(file);

        const uploadedFile = await uploadNodeAttachment({
          treeId: treeInstanceId,
          nodeId,
          file,
          updatedBy,
        });

        uploadedBlobNames.push(uploadedFile.blobName);

        await createAttachmentMetadataRecord(nodeId, {
          originalFileName: file.name,
          contentType: uploadedFile.contentType,
          byteSize: uploadedFile.byteSize,
          blobName: uploadedFile.blobName,
          blobUrl: uploadedFile.blobUrl,
          updatedByObjectId: updatedBy?.updatedByObjectId ?? null,
          updatedByUserDetails: updatedBy?.updatedByUserDetails ?? null,
        });
      }
    } catch (error) {
      for (const blobName of uploadedBlobNames) {
        await deleteNodeAttachmentBlobIfExists(blobName);
      }

      throw error;
    }

    return queryNodeDetails(treeInstanceId, nodeId);
  });
}

export async function deleteAttachmentMetadataRecord(treeInstanceId, attachmentId, updatedBy = null) {
  const attachment = await queryAttachmentDeleteRecord(treeInstanceId, attachmentId);
  if (!attachment) {
    throw new Error('Attachment was not found for the selected tree');
  }

  const deletedBlob = await deleteNodeAttachmentBlobIfExists(attachment.blobName);

  try {
    const deletedRowCount = await softDeleteAttachmentMetadataRecord({
      attachmentId,
      updatedBy,
    });

    if (!deletedRowCount) {
      throw new Error('Attachment was not found for the selected tree');
    }
  } catch (error) {
    if (deletedBlob) {
      await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);
    }

    throw error;
  }

  return queryNodeDetails(treeInstanceId, attachment.treeNodeId);
}