import { PublicClientApplication } from "@azure/msal-browser";

export const msalConfig = {
  auth: {
    clientId: "b82efeaa-410b-4d9a-9bc1-64a1a3f71ec9",
    authority: "https://login.microsoftonline.com/a18232f7-c6f8-48da-b8e1-838c7fac8ab1",
    redirectUri: "/", // or your deployed URL
  },
};

export const loginRequest = {
  scopes: ["openid", "profile", "api://398c6cf6-0b41-476e-ab6e-289c46caf1ad/user_impersonation"],
};

export const msalInstance = new PublicClientApplication(msalConfig);