import { CONFIG } from "./config.js";

// Register OAuth if an APP_ID is set. Sign-in then happens automatically
// the first time the map or one of its layers needs a private resource.
export async function setupAuth() {
  if (!CONFIG.APP_ID) return null;
  const [OAuthInfo, esriId] = await $arcgis.import([
    "@arcgis/core/identity/OAuthInfo.js",
    "@arcgis/core/identity/IdentityManager.js",
  ]);
  esriId.registerOAuthInfos([
    new OAuthInfo({
      appId: CONFIG.APP_ID,
      portalUrl: CONFIG.PORTAL_URL,
      flowType: "authorization-code",
      popup: false,
    }),
  ]);
  return esriId;
}
