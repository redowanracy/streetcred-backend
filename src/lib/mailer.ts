import { env } from '../config/env';
import { logger } from './logger';

/**
 * Outgoing email. No provider is wired up yet: plug SES / SendGrid / Postmark
 * into `send` before enabling password reset in production.
 */
export const mailer = {
  async sendPasswordReset(to: string, token: string): Promise<void> {
    const link = `${env.PASSWORD_RESET_URL_BASE}?token=${encodeURIComponent(token)}`;
    if (env.devLogPasswordResetLinks) {
      logger.info({ to, link }, '[dev mailer] password reset link');
      return;
    }
    logger.warn({ to }, 'Password reset requested but no email provider is configured; nothing was sent');
  },
};
