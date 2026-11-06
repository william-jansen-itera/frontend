export function validateMergedLeafNotes(originalNotes, mergedNotes, maxLength) {
  const merged = String(mergedNotes ?? '');

  if (!merged.trim() || merged.length > maxLength) {
    throw new Error('The updated note is empty or exceeds the allowed length.');
  }

  return merged;
}