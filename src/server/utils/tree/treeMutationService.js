import { createHash } from 'node:crypto';
import {
  deleteNodeAttachmentBlobIfExists,
  restoreNodeAttachmentBlobIfDeleted,
  uploadNodeAttachment,
} from '@/server/utils/blobStorage';
import {
  generateChatLeafPathPlan,
  generateChildTitlesFromBreadcrumb,
  generateMergedLeafNotes,
  generateLeafNotesDraft,
  selectChatPlacementCandidates,
} from '@/server/utils/tree/treeGenerationService';
import { requestTreeSqlIndexerRun } from '@/server/utils/azureSearch';
import { logException, logTrace } from '@/server/utils/logging';
import { invokeSecretFunction } from '@/server/utils/secretFunctionClient';
import { sql, withSqlConnection } from '@/server/utils/sql';
import { permanentlyDeletePersonalCacheNode } from '@/server/utils/agent/personalCacheTreeRepository';
import { assertConfiguredTree, listActiveTreeSubtreeAttachments, softDeleteTreeSubtree } from '@/server/utils/tree/treePathRepository';
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
  updateUnchangedLeafNotes,
  updateTreeNodeText,
  upsertTreeNodeDetails,
} from '@/server/utils/tree/treeRecordRepository';
import { assertTreeAccess, getAuditMetadata, isPersonalCacheTree } from '@/server/utils/tree/treeCatalog';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PLACEMENT_BATCH_SIZE = 30;
const PLACEMENT_SHORTLIST_SIZE = 4;
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
    flatData,
    breadcrumbByNodeId,
    candidates,
  };
}

async function shortlistPlacementLeaves({ leaves, selectionContext, parentBreadcrumb }) {
  let shortlist = [];

  for (let index = 0; index < leaves.length; index += PLACEMENT_BATCH_SIZE) {
    const batch = leaves.slice(index, index + PLACEMENT_BATCH_SIZE);
    const ids = await selectChatPlacementCandidates({
      ...selectionContext,
      parentBreadcrumb,
      candidates: batch,
      stage: 'shortlist',
      maxSelections: PLACEMENT_SHORTLIST_SIZE,
    });
    shortlist.push(...batch.filter((candidate) => ids.includes(candidate.nodeId)));

    while (shortlist.length > PLACEMENT_SHORTLIST_SIZE) {
      const offered = shortlist.slice(0, PLACEMENT_BATCH_SIZE);
      const retainedIds = await selectChatPlacementCandidates({
        ...selectionContext,
        parentBreadcrumb,
        candidates: offered,
        stage: 'shortlist',
        maxSelections: PLACEMENT_SHORTLIST_SIZE,
      });
      shortlist = [...offered.filter((candidate) => retainedIds.includes(candidate.nodeId)), ...shortlist.slice(offered.length)];
    }
  }

  return shortlist;
}

async function resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer, placementCaption = '', onModelCall }) {
  const normalizedOriginalQuestion = String(originalQuestion ?? '').trim();
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();

  if (!normalizedOriginalQuestion || !normalizedBroaderAnswer) {
    throw new Error('The chat add action requires the original question and broader answer content.');
  }

  const { treeName, maxDepth, flatData, breadcrumbByNodeId, candidates } = await getChatLeafPlacementContext(treeInstanceId);

  if (!Number.isFinite(maxDepth) || maxDepth < 0) {
    throw new Error(`Tree depth is not configured for ${treeName}.`);
  }

  const selectionContext = { treeName, originalQuestion: normalizedOriginalQuestion, broaderAnswer: normalizedBroaderAnswer, placementCaption, onModelCall };
  const roots = candidates.filter((candidate) => candidate.depth === 0);
  const [rootId] = await selectChatPlacementCandidates({ ...selectionContext, candidates: roots, stage: 'root' });
  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  let selectedCandidate = roots.find((candidate) => candidate.nodeId === rootId) ?? null;
  let leafMatch = null;
  let evaluatedLeafCandidates = false;

  while (selectedCandidate) {
    const childNodes = flatData.filter((node) => String(node.parent ?? '') === selectedCandidate.nodeId);
    const isLeafLevel = selectedCandidate.remainingDepthBudget === 1;
    const children = isLeafLevel
      ? childNodes.filter((node) => node.isLeafNode).map((node) => ({
        nodeId: String(node.id), breadcrumb: breadcrumbByNodeId.get(String(node.id)) ?? '',
        parentId: String(node.parent ?? ''), title: node.name, isLeafNode: true,
      }))
      : candidates.filter((candidate) => childNodes.some((node) => String(node.id) === candidate.nodeId));
    if (children.length === 0) break;
    if (isLeafLevel) evaluatedLeafCandidates = true;
    const [childId] = await selectChatPlacementCandidates({
      ...selectionContext, parentBreadcrumb: selectedCandidate.breadcrumb, candidates: children,
      stage: isLeafLevel ? 'leaf' : 'structural',
    });
    if (!childId) break;

    if (isLeafLevel) {
      const leaf = children.find((candidate) => candidate.nodeId === childId);
      const details = await queryTreeNodeDetailRecord(treeInstanceId, childId);
      if (details) leafMatch = { ...leaf, notesFingerprint: fingerprintNotes(details.notes) };
      break;
    }
    selectedCandidate = children.find((candidate) => candidate.nodeId === childId);
  }

  if (selectedCandidate && !leafMatch && !evaluatedLeafCandidates) {
    const isWithinSubtree = (nodeId) => {
      let node = nodeById.get(String(nodeId));
      while (node) {
        if (String(node.id) === selectedCandidate.nodeId) return true;
        node = node.parent === null || node.parent === undefined ? null : nodeById.get(String(node.parent));
      }
      return false;
    };
    const leaves = flatData.filter((node) => node.isLeafNode && isWithinSubtree(node.id))
      .map((node) => ({ nodeId: String(node.id), breadcrumb: breadcrumbByNodeId.get(String(node.id)) ?? '', parentId: String(node.parent ?? ''), title: node.name, isLeafNode: true }));
    const shortlist = await shortlistPlacementLeaves({ leaves, selectionContext, parentBreadcrumb: selectedCandidate.breadcrumb });
    const leafRecords = await Promise.all(shortlist.map(async (leaf) => ({ leaf, details: await queryTreeNodeDetailRecord(treeInstanceId, leaf.nodeId) })));
    const rankedLeaves = leafRecords.filter(({ details }) => details)
      .map(({ leaf, details }) => ({ ...leaf, notes: details.notes.slice(0, 1500), notesFingerprint: fingerprintNotes(details.notes) }));
    if (rankedLeaves.length) {
      const [leafId] = await selectChatPlacementCandidates({ ...selectionContext, candidates: rankedLeaves, stage: 'rank', required: true });
      leafMatch = rankedLeaves.find((leaf) => leaf.nodeId === leafId);
    }

    if (!leafMatch) {
      const descendants = candidates.filter((candidate) => candidate.depth > selectedCandidate.depth && isWithinSubtree(candidate.nodeId));
      const depths = [...new Set(descendants.map((candidate) => candidate.depth))].sort((left, right) => right - left);
      for (const depth of depths) {
        const atDepth = descendants.filter((candidate) => candidate.depth === depth);
        const [anchorId] = await selectChatPlacementCandidates({ ...selectionContext, parentBreadcrumb: selectedCandidate.breadcrumb, candidates: atDepth, stage: 'anchor' });
        if (anchorId) {
          selectedCandidate = atDepth.find((candidate) => candidate.nodeId === anchorId);
          break;
        }
      }
    }
  }

  if (leafMatch) {
    return {
      treeId: String(treeInstanceId), treeName, placementMode: 'merge_existing', generatedLeafTitle: '',
      originalQuestion: normalizedOriginalQuestion, broaderAnswer: normalizedBroaderAnswer,
      mergeTarget: {
        nodeId: leafMatch.nodeId, breadcrumb: leafMatch.breadcrumb, parentId: leafMatch.parentId,
        title: leafMatch.title, notesFingerprint: leafMatch.notesFingerprint,
      },
    };
  }

  const requiredPathTitleCount = selectedCandidate
    ? selectedCandidate.remainingDepthBudget - 1
    : maxDepth;
  const pathPlan = await generateChatLeafPathPlan({
    treeName,
    originalQuestion: normalizedOriginalQuestion,
    broaderAnswer: normalizedBroaderAnswer,
    placementCaption,
    anchorBreadcrumbTitles: selectedCandidate?.breadcrumbTitles ?? [],
    requiredPathTitleCount,
  });

  const anchorBreadcrumbTitles = selectedCandidate?.breadcrumbTitles ?? [];
  const plannedLeafParentBreadcrumb = buildResolvedBreadcrumb(anchorBreadcrumbTitles, pathPlan.pathTitles);

  return {
    treeId: String(treeInstanceId),
    treeName,
    placementMode: selectedCandidate ? requiredPathTitleCount === 0 ? 'direct_leaf_from_anchor' : 'anchor_with_intermediates' : 'full_path_from_root',
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

function fingerprintNotes(notes) {
  return createHash('sha256').update(notes).digest('hex');
}

function buildPreviewDestinations(preview, mergeTarget = null) {
  return {
    ...preview,
    createPath: preview.generatedLeafTitle
      ? [preview.plannedLeafParentBreadcrumb, preview.generatedLeafTitle].filter(Boolean).join(' > ')
      : null,
    mergeTarget,
    defaultSaveMode: mergeTarget ? 'merge_existing' : 'create_leaf',
  };
}

export async function previewLeafFromChat({ treeInstanceId, originalQuestion, broaderAnswer, placementCaption = '', onModelCall }) {
  const placement = await resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer, placementCaption, onModelCall });
  if (placement.broaderAnswer.length > 4000) {
    throw new Error('The cleaned answer is too long to save as one note. Shorten it before previewing.');
  }
  if (placement.mergeTarget) {
    return buildPreviewDestinations(placement, placement.mergeTarget);
  }
  const flatData = await queryTreeData(treeInstanceId);
  const breadcrumbs = buildBreadcrumbByNodeId(flatData);
  const occupiedPaths = new Set(flatData.filter((node) => node.isLeafNode)
    .map((node) => (breadcrumbs.get(String(node.id)) ?? '').toLowerCase()));
  const baseTitle = placement.generatedLeafTitle;
  for (let suffix = 0; suffix <= occupiedPaths.size; suffix += 1) {
    const addition = suffix === 0 ? '' : ` (New ${suffix})`;
    const title = `${baseTitle.slice(0, 255 - addition.length)}${addition}`;
    const path = [placement.plannedLeafParentBreadcrumb, title].filter(Boolean).join(' > ').toLowerCase();
    if (!occupiedPaths.has(path)) {
      placement.generatedLeafTitle = title;
      break;
    }
  }
  return buildPreviewDestinations(placement);
}

export async function reviseLeafPreviewPath({ treeInstanceId, preview, requestedPath }) {
  const { treeName, maxDepth, candidates } = await getChatLeafPlacementContext(treeInstanceId);
  const requestedTitles = String(requestedPath ?? '').split('>').map((title) => title.trim());
  const pathTitles = requestedTitles.length === maxDepth + 2 && requestedTitles[0]?.toLowerCase() === treeName.toLowerCase()
    ? requestedTitles.slice(1)
    : requestedTitles;

  if (pathTitles.some((title) => !title) || pathTitles.length !== maxDepth + 1) {
    throw new Error(`Provide a complete path of ${maxDepth + 1} non-empty titles separated by >, ending with the note title.`);
  }

  const selectedCandidate = candidates
    .filter((candidate) => candidate.breadcrumbTitles.every((title, index) => title.toLowerCase() === pathTitles[index].toLowerCase()))
    .sort((left, right) => right.depth - left.depth)[0] ?? null;
  const anchorTitles = selectedCandidate?.breadcrumbTitles ?? [];
  const generatedPathTitles = pathTitles.slice(anchorTitles.length, -1);

  const flatData = await queryTreeData(treeInstanceId);
  const breadcrumbs = buildBreadcrumbByNodeId(flatData);
  if (flatData.some((node) => node.isLeafNode &&
    (breadcrumbs.get(String(node.id)) ?? '').toLowerCase() === pathTitles.join(' > ').toLowerCase())) {
    throw new Error('Path revision creates a new note. Choose a path with a new leaf title.');
  }

  return buildPreviewDestinations({
    ...preview,
    treeName,
    placementMode: selectedCandidate
      ? generatedPathTitles.length ? 'anchor_with_intermediates' : 'direct_leaf_from_anchor'
      : 'full_path_from_root',
    selectedAnchorNodeId: selectedCandidate?.nodeId ?? '',
    selectedAnchorBreadcrumb: selectedCandidate?.breadcrumb ?? '',
    generatedPathTitles,
    plannedLeafParentBreadcrumb: buildResolvedBreadcrumb(anchorTitles, generatedPathTitles),
    generatedLeafTitle: pathTitles.at(-1),
  });
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

export async function deleteTreeNode({ id, treeInstanceId, principal }) {
  const tree = await assertTreeAccess(treeInstanceId, {
    principal,
    visibility: 'both',
    requireWriteAccess: true,
  });

  if (isPersonalCacheTree(tree)) {
    const deleted = await permanentlyDeletePersonalCacheNode({ treeId: treeInstanceId, principal, nodeId: id });

    if (!deleted) {
      throw new Error('Node was not found for the selected tree');
    }

    return withSqlConnection(async () => queryTreeData(treeInstanceId));
  }

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
  isSecret,
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
    const nextIsSecret = isSecret === undefined ? Boolean(existingDetails?.isSecret) : Boolean(isSecret);
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
  attachmentFile = null,
  preserveNoteWhitespace = false,
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
      broaderAnswer: preserveNoteWhitespace ? String(broaderAnswer ?? '') : String(broaderAnswer ?? '').trim(),
    }
    : await resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer });

  if (!resolvedPlacement.generatedLeafTitle) {
    throw new Error('A generated leaf title is required for the chat add action.');
  }

  const notes = resolvedPlacement.broaderAnswer;
  if ((!notes.trim() && !attachmentFile) || notes.length > 4000) {
    throw new Error('The cleaned answer must be non-empty and at most 4000 characters. Preview again.');
  }

  return withSqlConnection(async () => {
    const flatData = await queryTreeData(treeInstanceId);
    const breadcrumbs = buildBreadcrumbByNodeId(flatData);
    const intendedPath = [resolvedPlacement.plannedLeafParentBreadcrumb, resolvedPlacement.generatedLeafTitle]
      .filter(Boolean).join(' > ').toLowerCase();
    if (flatData.some((node) => node.isLeafNode &&
      (breadcrumbs.get(String(node.id)) ?? '').toLowerCase() === intendedPath)) {
      throw new Error('The new note path already exists. Preview again and choose a different path.');
    }
    const transaction = new sql.Transaction();
    let uploadedAttachment = null;
    let committed = false;

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
        notes,
        updatedBy: normalizeUpdatedByMetadata(principal),
        transaction,
      });

      if (attachmentFile) {
        validateAttachmentFile(attachmentFile);
        uploadedAttachment = await uploadNodeAttachment({
          treeId: treeInstanceId,
          nodeId: placementResult.createdLeafNode.createdNodeId,
          file: attachmentFile,
          updatedBy: normalizeUpdatedByMetadata(principal),
        });
        await createAttachmentMetadataRecord(placementResult.createdLeafNode.createdNodeId, {
          originalFileName: attachmentFile.name,
          contentType: uploadedAttachment.contentType,
          byteSize: uploadedAttachment.byteSize,
          blobName: uploadedAttachment.blobName,
          blobUrl: uploadedAttachment.blobUrl,
          updatedByObjectId: normalizeUpdatedByMetadata(principal).updatedByObjectId,
          updatedByUserDetails: normalizeUpdatedByMetadata(principal).updatedByUserDetails,
        }, transaction);
      }

      await transaction.commit();
      committed = true;

      const indexerRun = attachmentFile
        ? await requestIndexerRefreshForMutation(treeInstanceId, 'chat add').catch(() => null)
        : await requestIndexerRefreshForMutation(treeInstanceId, 'chat add');

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
        flatData: attachmentFile ? await queryTreeData(treeInstanceId).catch(() => []) : await queryTreeData(treeInstanceId),
        details: attachmentFile
          ? await queryNodeDetails(treeInstanceId, placementResult.createdLeafNode.createdNodeId)
            .catch(() => ({ notes, attachments: [{ fileName: attachmentFile.name, blobUrl: uploadedAttachment.blobUrl }] }))
          : await queryNodeDetails(treeInstanceId, placementResult.createdLeafNode.createdNodeId),
        indexerRun,
      };
    } catch (error) {
      if (committed) throw error;
      try {
        if (transaction._aborted !== true) await transaction.rollback();
      } finally {
        if (uploadedAttachment) await deleteNodeAttachmentBlobIfExists(uploadedAttachment.blobName);
      }

      throw error;
    }
  });
}

export async function mergeLeafNodeFromChat({ treeInstanceId, principal, preview, toolName }) {
  const target = preview.mergeTarget;
  if (!target?.nodeId || !target.notesFingerprint) {
    throw new Error('No existing note was offered for this preview. Preview again.');
  }

  const node = await queryTreeNode(treeInstanceId, target.nodeId);
  const current = await queryTreeNodeDetailRecord(treeInstanceId, target.nodeId);
    const flatData = await queryTreeData(treeInstanceId);
    const breadcrumbs = buildBreadcrumbByNodeId(flatData);
    const positionedNode = flatData.find((item) => String(item.id) === target.nodeId);
  if (!node?.isLeafNode || !current ||
      !positionedNode || (breadcrumbs.get(target.nodeId) ?? '') !== target.breadcrumb ||
      String(positionedNode.parent ?? '') !== target.parentId || node.name !== target.title ||
      fingerprintNotes(current.notes) !== target.notesFingerprint) {
    throw new Error('The existing note has changed or is no longer available. Preview again before merging.');
  }

  const notes = await generateMergedLeafNotes({
    treeName: preview.treeName,
    breadcrumb: target.breadcrumb,
    originalNotes: current.notes,
    broaderAnswer: preview.broaderAnswer,
  });

  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();
    try {
      await transaction.begin();
      await ensureTreeNodeDetailsRow(target.nodeId, transaction);
      const updated = await updateUnchangedLeafNotes({
        treeInstanceId,
        nodeId: target.nodeId,
        originalNotes: current.notes,
        notes,
        expectedTitle: target.title,
        expectedParentId: target.parentId,
        updatedBy: normalizeUpdatedByMetadata(principal),
        transaction,
      });
      if (!updated) {
        throw new Error('The existing note changed during the merge. Preview again before merging.');
      }
      await transaction.commit();
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }
      throw error;
    }

    const indexerRun = await requestIndexerRefreshForMutation(treeInstanceId, 'chat merge');
    return {
      treeId: String(treeInstanceId),
      treeName: preview.treeName,
      toolName,
      updatedNodeId: target.nodeId,
      mergeBreadcrumb: target.breadcrumb,
      details: await queryNodeDetails(treeInstanceId, target.nodeId),
      indexerRun,
    };
  });
}

export async function assertUnchangedAttachmentTarget({ treeInstanceId, target }) {
  if (!target?.nodeId || !target.notesFingerprint) {
    throw new Error('No existing leaf was offered for the attachment. Preview again.');
  }
  const node = await queryTreeNode(treeInstanceId, target.nodeId);
  const current = await queryTreeNodeDetailRecord(treeInstanceId, target.nodeId);
  const flatData = await queryTreeData(treeInstanceId);
  const breadcrumbs = buildBreadcrumbByNodeId(flatData);
  const positionedNode = flatData.find((item) => String(item.id) === target.nodeId);
  if (!node?.isLeafNode || !current || !positionedNode ||
      (breadcrumbs.get(target.nodeId) ?? '') !== target.breadcrumb ||
      String(positionedNode.parent ?? '') !== target.parentId || node.name !== target.title ||
      fingerprintNotes(current.notes) !== target.notesFingerprint) {
    throw new Error('The existing leaf changed. Preview again before attaching the file.');
  }
}

export async function createTreeNodeAttachment({ treeInstanceId, nodeId, files, updatedBy = null, expectedTarget = null }) {
  return withSqlConnection(async () => {
    if (expectedTarget) await assertUnchangedAttachmentTarget({ treeInstanceId, target: expectedTarget });
    await assertLeafNode(treeInstanceId, nodeId);
    const configuredTree = await assertConfiguredTree(treeInstanceId, { allowPrivate: true });

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
          skipSearchIndexing: isPersonalCacheTree(configuredTree),
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