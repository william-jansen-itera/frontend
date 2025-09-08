
import crypto from 'crypto';

const workspaceId = process.env.AZURE_MONITOR_WORKSPACE_ID;
const sharedKey = process.env.AZURE_MONITOR_SHARED_KEY;
const logType = 'CustomAppLogs'; // You can change this to your preferred log type

async function sendLogToAzureMonitor(body) {
  if (!workspaceId || !sharedKey) {
    console.warn('Azure Monitor workspace ID or shared key not set.');
    return;
  }
  const customerId = workspaceId;
  const sharedKeyBuffer = Buffer.from(sharedKey, 'base64');
  const date = new Date().toUTCString();
  const bodyString = JSON.stringify(body);
  const contentLength = Buffer.byteLength(bodyString, 'utf8');
  const stringToSign = `POST\n${contentLength}\napplication/json\nx-ms-date:${date}\n/api/logs`;
  const signature = crypto.createHmac('sha256', sharedKeyBuffer)
    .update(stringToSign, 'utf8')
    .digest('base64');
  const authorization = `SharedKey ${customerId}:${signature}`;

  const url = `https://${customerId}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Log-Type': logType,
        'x-ms-date': date,
        'Authorization': authorization,
      },
      body: bodyString,
    });
  } catch (err) {
    console.error('Failed to send log to Azure Monitor:', err);
  }
}

export async function logTrace(message) {
  await sendLogToAzureMonitor({ level: 'trace', message, timestamp: new Date().toISOString() });
}

export async function logException(exception) {
  await sendLogToAzureMonitor({ level: 'error', message: exception?.message || String(exception), stack: exception?.stack, timestamp: new Date().toISOString() });
}
