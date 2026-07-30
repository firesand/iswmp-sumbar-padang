// App Check provider bridge for the attested Android wrapper.
//
// Inside the wrapper the JavaScript SDK must NOT attest as the web application:
// its reCAPTCHA token carries the web application id, and the backend's attested
// allowlist would never match. This CustomProvider forwards a token minted by
// the native Firebase SDK, which is registered with the Play Integrity provider
// for the Android application, so `request.app.appId` becomes the Android id.
//
// Not wired into src/config/firebase.js yet. Doing so changes how every Firebase
// call in the app is attested, so it must be validated on a test build together
// with registering the Android app — see docs/android-attested-client.md.

import { CustomProvider, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

const PLUGIN = 'IswmpLocationIntegrity';
const TOKEN_SAFETY_MARGIN_MS = 60_000;

const resolvePlugin = (scope = globalThis) => {
  const plugin = scope?.Capacitor?.Plugins?.[PLUGIN];
  return plugin && typeof plugin.getAppCheckToken === 'function'
    ? plugin
    : null;
};

/**
 * App Check provider appropriate for the current runtime.
 *
 * Returns the native-backed CustomProvider inside the wrapper, and the existing
 * reCAPTCHA Enterprise provider in an ordinary browser. Never silently falls
 * back from native to reCAPTCHA once the plugin is present: that would quietly
 * downgrade an attested client to a web-class one.
 *
 * @param {string} recaptchaSiteKey Existing reCAPTCHA Enterprise site key.
 * @param {object} [scope] Global object (injected for tests).
 * @returns {object} An App Check provider instance.
 */
export function resolveAppCheckProvider(recaptchaSiteKey, scope = globalThis) {
  const plugin = resolvePlugin(scope);
  if (!plugin) {
    return new ReCaptchaEnterpriseProvider(recaptchaSiteKey);
  }
  return new CustomProvider({
    getToken: async () => {
      const result = await plugin.getAppCheckToken();
      const token = result?.token;
      const expireTimeMillis = Number(result?.expireTimeMillis);
      if (typeof token !== 'string' || token.length === 0 ||
          !Number.isFinite(expireTimeMillis)) {
        throw new Error('Native App Check token tidak valid.');
      }
      return {
        token,
        // The JS SDK expects a TTL, not an absolute expiry.
        expireTimeMillis: Math.max(
          TOKEN_SAFETY_MARGIN_MS,
          expireTimeMillis - Date.now()
        ),
      };
    },
  });
}

/**
 * Whether replay-protected callables can still use limited-use tokens.
 *
 * The JavaScript CustomProvider interface exposes only getToken, so a wrapper
 * build cannot supply a limited-use token through it. `limitedUseAppCheckTokens`
 * on submitAttendance therefore degrades to a standard token inside the wrapper,
 * and App Check replay protection stops contributing. The plugin exposes
 * getLimitedUseAppCheckToken for a future native callable path; until callables
 * are invoked natively this is a documented, accepted downgrade.
 */
export const supportsLimitedUseTokens = (scope = globalThis) =>
  resolvePlugin(scope) === null;
