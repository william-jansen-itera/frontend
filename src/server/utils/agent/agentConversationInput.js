export function buildInitialAgentInput({ allowedToolInstruction, normalizedHistory, normalizedMessage }) {
  return [
    ...(allowedToolInstruction
      ? [{
        type: 'message',
        role: 'system',
        content: allowedToolInstruction,
      }]
      : []),
    ...normalizedHistory,
    {
      type: 'message',
      role: 'user',
      content: normalizedMessage,
    },
  ];
}
