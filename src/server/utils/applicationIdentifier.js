export function getRequiredApplicationIdentifier() {
  const applicationIdentifier = String(process.env.APPLICATION_IDENTIFIER ?? '').trim();

  if (!applicationIdentifier) {
    throw new Error('Application identifier env var is not configured');
  }

  return applicationIdentifier;
}