export function validateMergedLeafNotes(originalNotes, mergedNotes, maxLength) {
  const original = String(originalNotes ?? '');
  const merged = String(mergedNotes ?? '');

  if (!merged.trim() || merged.length > maxLength) {
    throw new Error('The updated note is empty or exceeds the allowed length.');
  }

  let originalOffset = 0;
  let insertion = '';

  for (let index = 0; index < merged.length; index += 1) {
    const character = merged[index];
    if (character === original[originalOffset]) {
      originalOffset += 1;
    } else {
      insertion += character;
    }
  }

  if (originalOffset !== original.length || !insertion.trim()) {
    throw new Error('Merged notes must preserve the existing note and add new content.');
  }

  return merged;
}