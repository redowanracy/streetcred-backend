import { notImplemented } from '../../lib/errors';

/** A verified identity asserted by Google or Apple. */
export interface ProviderIdentity {
  subject: string; // stable provider user id ("sub")
  email?: string;
  emailVerified?: boolean;
}

export type ProviderName = 'google' | 'apple';

/**
 * TODO(google-login): verify the ID token with google-auth-library
 * (`OAuth2Client.verifyIdToken`, audience = Android/iOS/Web client IDs),
 * then return { subject: payload.sub, email: payload.email, emailVerified: payload.email_verified }.
 */
export async function verifyGoogleIdToken(_idToken: string): Promise<ProviderIdentity> {
  throw notImplemented('Google sign-in is not enabled yet');
}

/**
 * TODO(apple-login): verify the identity token JWT against Apple's JWKS
 * (https://appleid.apple.com/auth/keys), issuer https://appleid.apple.com,
 * audience = app bundle / service ID, and check the nonce if the client sends one.
 */
export async function verifyAppleIdentityToken(_identityToken: string, _nonce?: string): Promise<ProviderIdentity> {
  throw notImplemented('Apple sign-in is not enabled yet');
}

export function verifyProviderToken(provider: ProviderName, token: string, nonce?: string) {
  return provider === 'google' ? verifyGoogleIdToken(token) : verifyAppleIdentityToken(token, nonce);
}
