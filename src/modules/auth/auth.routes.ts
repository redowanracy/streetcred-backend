import { Request, Router } from 'express';
import { currentUser, requireAuth } from '../../middleware/auth';
import { credentialLimiter, guestCreationLimiter } from '../../middleware/rate-limit';
import { parse } from '../../lib/validate';
import * as schemas from './auth.schemas';
import * as auth from './auth.service';
import { verifyProviderToken } from './providers';

export const authRouter = Router();

const meta = (req: Request): auth.SessionMeta => ({ userAgent: req.get('user-agent'), ip: req.ip });

authRouter.post('/guest', guestCreationLimiter, async (req, res) => {
  const body = parse(schemas.guestBody, req.body);
  res.status(201).json(await auth.createGuest(body.displayName, meta(req)));
});

authRouter.post('/signup', credentialLimiter, async (req, res) => {
  const body = parse(schemas.signupBody, req.body);
  res.status(201).json(await auth.signup(body, meta(req)));
});

authRouter.post('/login', credentialLimiter, async (req, res) => {
  const body = parse(schemas.loginBody, req.body);
  res.json(await auth.login(body, meta(req)));
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = parse(schemas.refreshBody, req.body);
  res.json(await auth.refresh(refreshToken, meta(req)));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = parse(schemas.refreshBody, req.body);
  await auth.logout(refreshToken);
  res.status(204).end();
});

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await auth.logoutAll(currentUser(req).id);
  res.status(204).end();
});

authRouter.post('/link/email', requireAuth, credentialLimiter, async (req, res) => {
  const body = parse(schemas.linkEmailBody, req.body);
  res.json(await auth.linkEmail(currentUser(req).id, body));
});

authRouter.post('/password/change', requireAuth, credentialLimiter, async (req, res) => {
  const body = parse(schemas.changePasswordBody, req.body);
  res.json(await auth.changePassword(currentUser(req).id, body.currentPassword, body.newPassword, meta(req)));
});

authRouter.post('/password/forgot', credentialLimiter, async (req, res) => {
  const { email } = parse(schemas.forgotPasswordBody, req.body);
  await auth.requestPasswordReset(email);
  res.status(202).json({ message: 'If that email has an account, a reset link has been sent.' });
});

authRouter.post('/password/reset', credentialLimiter, async (req, res) => {
  const body = parse(schemas.resetPasswordBody, req.body);
  await auth.resetPassword(body.token, body.newPassword);
  res.status(204).end();
});

// ── Google / Apple: contract is final; token verification returns 501 until enabled (see providers.ts).

authRouter.post('/google', credentialLimiter, async (req, res) => {
  const { idToken } = parse(schemas.googleBody, req.body);
  const identity = await verifyProviderToken('google', idToken);
  res.json(await auth.signInWithProvider('google', identity, meta(req)));
});

authRouter.post('/apple', credentialLimiter, async (req, res) => {
  const { identityToken, nonce } = parse(schemas.appleBody, req.body);
  const identity = await verifyProviderToken('apple', identityToken, nonce);
  res.json(await auth.signInWithProvider('apple', identity, meta(req)));
});

authRouter.post('/link/google', requireAuth, async (req, res) => {
  const { idToken } = parse(schemas.googleBody, req.body);
  const identity = await verifyProviderToken('google', idToken);
  res.json(await auth.linkProvider(currentUser(req).id, 'google', identity));
});

authRouter.post('/link/apple', requireAuth, async (req, res) => {
  const { identityToken, nonce } = parse(schemas.appleBody, req.body);
  const identity = await verifyProviderToken('apple', identityToken, nonce);
  res.json(await auth.linkProvider(currentUser(req).id, 'apple', identity));
});
