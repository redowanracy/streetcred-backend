import { z } from 'zod';

export const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');
export const displayName = z
  .string()
  .trim()
  .min(3, 'Display name must be at least 3 characters')
  .max(24, 'Display name must be at most 24 characters')
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'Display name may contain letters, numbers, spaces, _ . -');

export const guestBody = z.object({ displayName: displayName.optional() });
export const signupBody = z.object({ email, password, displayName: displayName.optional() });
export const loginBody = z.object({ email, password: z.string().min(1).max(128) });
export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
export const linkEmailBody = signupBody;
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const forgotPasswordBody = z.object({ email });
export const resetPasswordBody = z.object({ token: z.string().min(20).max(200), newPassword: password });
export const googleBody = z.object({ idToken: z.string().min(1) });
export const appleBody = z.object({ identityToken: z.string().min(1), nonce: z.string().optional() });
