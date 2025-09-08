import appInsights from 'applicationinsights';

let isInitialized = false;

export function getAppInsightsClient() {
  if (!isInitialized && process.env.APPINSIGHTS_INSTRUMENTATIONKEY) {
    appInsights.setup(process.env.APPINSIGHTS_INSTRUMENTATIONKEY).start();
    isInitialized = true;
  }
  return appInsights.defaultClient;
}

export function logTrace(message) {
  const client = getAppInsightsClient();
  if (client) {
    client.trackTrace({ message });
  }
}

export function logException(exception) {
  const client = getAppInsightsClient();
  if (client) {
    client.trackException({ exception });
  }
}
