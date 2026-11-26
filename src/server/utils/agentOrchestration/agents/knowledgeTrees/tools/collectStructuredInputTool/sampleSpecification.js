export function buildCollectionTestSpecification(language = 'en') {
  const da = language === 'da';
  return {
    title: da ? 'Test af struktureret interaktion' : 'Structured interaction test',
    purpose: da ? 'Indsaml kun testinput. Ingen svar godkender eller udfører en handling.'
      : 'Collect test input only. No answer approves or executes an action.',
    steps: [
      {
        id: 'topic', prompt: da ? 'Vælg et emne.' : 'Choose a topic.',
        fields: [{
          id: 'topic', label: da ? 'Emne' : 'Topic', type: 'single_choice', required: true, maxLength: 2000,
          options: [{ id: 'nature', label: da ? 'Natur' : 'Nature' }, { id: 'technology', label: da ? 'Teknologi' : 'Technology' }],
        }],
      },
      {
        id: 'note', prompt: da ? 'Skriv en kort note.' : 'Enter a short note.',
        fields: [{ id: 'note', label: da ? 'Note' : 'Note', type: 'text', required: true, maxLength: 500, options: [] }],
      },
      {
        id: 'features', prompt: da ? 'Vælg funktioner at teste (valgfrit).' : 'Choose features to test (optional).',
        fields: [{
          id: 'features', label: da ? 'Funktioner' : 'Features', type: 'multiple_choice', required: false, maxLength: 2000,
          options: [{ id: 'choices', label: da ? 'Valg' : 'Choices' }, { id: 'navigation', label: da ? 'Navigation' : 'Navigation' }],
        }],
      },
      {
        id: 'feedback', prompt: da ? 'Var denne test nyttig?' : 'Was this test useful?',
        fields: [{
          id: 'feedback', label: da ? 'Nyttig test' : 'Useful test', type: 'yes_no', required: true, maxLength: 2000,
          options: [{ id: 'yes', label: da ? 'Ja' : 'Yes' }, { id: 'no', label: da ? 'Nej' : 'No' }],
        }],
      },
    ],
  };
}
