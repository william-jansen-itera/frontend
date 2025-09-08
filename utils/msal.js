import { msalInstance, loginRequest } from "./msalConfig";

export async function getAccessToken() {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) {
    await msalInstance.loginPopup(loginRequest);
  }
  const result = await msalInstance.acquireTokenSilent({
    ...loginRequest,
    account: msalInstance.getAllAccounts()[0],
  });
  return result.accessToken;
}