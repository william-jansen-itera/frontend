import { interactionError, validateInteractionValues } from '@/shared/interactions';

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw interactionError('Invalid structured collection object.');
  }
}

export function parseInteractionResponse(response, descriptor, maximumFields = 5) {
  object(response, ['action', 'fields']);
  if (!Array.isArray(response.fields) || response.fields.length > maximumFields) {
    throw interactionError('Invalid structured collection item count.');
  }
  if (new Set(response.fields.map((field) => field?.id)).size !== response.fields.length) {
    throw interactionError('Duplicate structured collection IDs.');
  }
  if (!descriptor.allowedActions.includes(response.action)) throw interactionError('This response action is unavailable.');
  const submitsFields = ['continue', 'submit'].includes(response.action);
  if (!submitsFields && response.fields.length) throw interactionError('Navigation cannot supply answers.');
  const values = Object.fromEntries(response.fields.map((field) => {
    object(field, ['id', 'value', 'selections']);
    const expected = descriptor.fields.find(({ id }) => id === field.id);
    if (!expected || (expected.type === 'multiple_choice' ? field.value !== null : field.selections !== null)) {
      throw interactionError('The response does not match the current fields.');
    }
    return [field.id, expected.type === 'multiple_choice' ? field.selections : field.value];
  }));
  return {
    action: response.action,
    values: validateInteractionValues(submitsFields ? descriptor.fields : [], values),
  };
}
