export function getAgentChatLanguage(responseLanguage, appLanguage) {
  const reportedLanguage = String(responseLanguage ?? "").trim().toLowerCase();
  if (reportedLanguage === "danish" || reportedLanguage === "dansk" || reportedLanguage === "danish (da)" || /^da(?:-|$)/.test(reportedLanguage)) {
    return "da";
  }
  if (reportedLanguage === "english" || reportedLanguage === "english (en)" || /^en(?:-|$)/.test(reportedLanguage)) {
    return "en";
  }
  return appLanguage;
}

export function buildLaneRequestContext(context, turnId) {
  return {
    conversationId: context.conversationId,
    turnId,
    expectedVersion: context.version,
  };
}

export function acceptLaneContext(current, payload) {
  const next = payload?.laneContext;
  if (!next) return current;
  if (next.conversationId !== current.conversationId ||
      !Number.isSafeInteger(next.version) || next.version < current.version) {
    throw new Error('The chat response has an invalid or outdated conversation context.');
  }

  return { conversationId: next.conversationId, version: next.version, activeLane: next.activeLane };
}

export function isInteractionAvailable(interaction, family, activeLane) {
  return Boolean(interaction) && family === 'knowledgeTrees' &&
    (interaction.workflow === 'structured-input' || interaction.workflow === 'quiz' && activeLane === 'quiz');
}

export function getInteractionReplyTarget(interaction, family, activeLane, normalChat) {
  return !normalChat && ['structured-input', 'quiz'].includes(interaction?.workflow) &&
    isInteractionAvailable(interaction, family, activeLane) &&
    interaction.status === 'active' && interaction.allowedActions?.includes(
      interaction.workflow === 'quiz' ? 'submit' : 'cancel',
    )
    ? interaction : null;
}

export function buildInteractionReplyContext(target, interaction, family, activeLane) {
  if (!target) return null;
  if (!isInteractionAvailable(interaction, family, activeLane) || interaction?.status !== 'active' ||
      ['interactionId', 'stepId', 'version', 'workflow'].some((key) => target[key] !== interaction[key])) {
    throw new Error('The interaction reply target changed. Select Reply to this step again.');
  }
  return {
    interactionId: target.interactionId, stepId: target.stepId, version: target.version,
    workflow: target.workflow,
  };
}
