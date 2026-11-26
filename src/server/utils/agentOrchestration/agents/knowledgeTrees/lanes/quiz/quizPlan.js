import { interactionError } from '@/shared/interactions';
import { QUIZ_QUESTION_TYPES } from '../../quizQuestions.js';

const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = () => { throw interactionError('Quiz model returned an invalid evidence plan. Resume to retry.', 502); };

export function approveQuizPlan(source, plan) {
  if (!exact(plan, ['language', 'languageReason', 'title', 'assessments', 'objectives']) ||
      !['en', 'da', 'und'].includes(plan.language) || !text(plan.languageReason, 500) || !text(plan.title, 160) ||
      !Array.isArray(plan.assessments) || plan.assessments.length !== source.leaves.length ||
      !Array.isArray(plan.objectives) || plan.objectives.length > 45) invalid();
  const leaves = new Map(source.leaves.map((leaf) => [leaf.id, leaf]));
  const assessments = new Map();
  const groups = new Map(source.leaves.map((leaf) => [leaf.id, []]));
  const objectives = new Set();
  for (const assessment of plan.assessments) {
    if (!exact(assessment, ['leafId', 'reason']) || !leaves.has(assessment.leafId) ||
        assessments.has(assessment.leafId) || !text(assessment.reason, 2000)) invalid();
    assessments.set(assessment.leafId, assessment);
  }
  for (const objective of plan.objectives) {
    if (!exact(objective, ['leafId', 'learningObjective', 'evidenceBasis', 'evidence', 'supportedTypes']) ||
        !leaves.has(objective.leafId) || !text(objective.learningObjective, 1000) ||
        !['note', 'tree_path'].includes(objective.evidenceBasis) ||
        !Array.isArray(objective.evidence) || !objective.evidence.length || objective.evidence.length > 4 ||
        objective.evidence.some((quote) => !text(quote, 8000)) ||
        new Set(objective.evidence).size !== objective.evidence.length ||
        !Array.isArray(objective.supportedTypes) || !objective.supportedTypes.length ||
        objective.supportedTypes.some((type) => !QUIZ_QUESTION_TYPES.includes(type)) ||
        new Set(objective.supportedTypes).size !== objective.supportedTypes.length) invalid();
    const leaf = leaves.get(objective.leafId);
    const categories = leaf.path.split(' > ').slice(0, -1);
    if (objective.evidence.some((quote) => objective.evidenceBasis === 'note'
      ? !leaf.notes.includes(quote) : !categories.includes(quote))) invalid();
    const identity = `${objective.leafId}:${objective.learningObjective.trim().toLowerCase()}`;
    if (objectives.has(identity)) invalid();
    objectives.add(identity);
    groups.get(objective.leafId).push(objective);
  }
  const allocated = [];
  const counts = Object.fromEntries(QUIZ_QUESTION_TYPES.map((type) => [type, 0]));
  for (let index = 0; allocated.length < plan.objectives.length; index++) {
    for (const group of groups.values()) {
      const objective = group[index];
      if (!objective) continue;
      const supported = QUIZ_QUESTION_TYPES.filter((type) => objective.supportedTypes.includes(type));
      const preferredType = supported.reduce((best, type) => counts[type] < counts[best] ? type : best);
      counts[preferredType]++;
      allocated.push({
        ...objective, objectiveId: `objective-${allocated.length + 1}`, preferredType,
      });
    }
  }
  return {
    language: plan.language, languageReason: plan.languageReason,
    title: plan.title,
    assessments: source.leaves.map((leaf) => {
      const group = groups.get(leaf.id);
      return {
        ...assessments.get(leaf.id), questionCount: group.length,
        supportedTypes: QUIZ_QUESTION_TYPES.filter((type) => group.some((objective) => objective.supportedTypes.includes(type))),
      };
    }),
    objectives: allocated,
  };
}
