/**
 * Credentials Middleware
 * Resolves and validates the active account credentials,
 * auto-refreshing tokens when they are expired or expiring soon.
 */

import {
  getActiveAccount,
  refreshAccountToken,
  isTokenExpiredOrExpiringSoon,
  loadAccounts
} from '../account-manager.js';
import { logger } from '../utils/logger.js';

/**
 * Resolves the active account credentials, refreshing the token if needed.
 * Returns null if no valid account is available.
 *
 * @returns {Promise<{accessToken: string, accountId: string, email: string}|null>}
 */
export async function getCredentialsOrError() {
  const account = getActiveAccount();

  if (!account) {
    logger.info('No active account found');
    return null;
  }

  if (!account.accessToken || !account.accountId) {
    logger.info(`Account ${account.email} missing token or accountId`);
    return null;
  }

  if (isTokenExpiredOrExpiringSoon(account)) {
    logger.info(`Token expired/expiring soon for ${account.email}, refreshing...`);
    const result = await refreshAccountToken(account.email);

    if (!result.success) {
      logger.error(`Failed to refresh token: ${result.message}`);
      return null;
    }

    const refreshedAccount = getActiveAccount();
    if (!refreshedAccount) {
      logger.error('Failed to get refreshed account');
      return null;
    }

    logger.info(`Using refreshed token for ${refreshedAccount.email}`);
    return {
      accessToken: refreshedAccount.accessToken,
      accountId: refreshedAccount.accountId,
      email: refreshedAccount.email
    };
  }

  return {
    accessToken: account.accessToken,
    accountId: account.accountId,
    email: account.email
  };
}

/**
 * Get credentials for a specific account by email.
 * @param {string} email
 * @returns {Promise<{accessToken: string, accountId: string, email: string}|null>}
 */
export async function getCredentialsForAccount(email) {
  const data = loadAccounts();
  const account = data.accounts.find(a => a.email === email);

  if (!account) {
    logger.info(`[Credentials] Account not found: ${email} (total: ${data.accounts.length})`);
    return null;
  }

  if (!account.accessToken || !account.accountId) {
    logger.info(`[Credentials] Account ${email} missing ${!account.accessToken ? 'accessToken' : ''} ${!account.accountId ? 'accountId' : ''}`);
    return null;
  }

  if (isTokenExpiredOrExpiringSoon(account)) {
    logger.info(`[Credentials] Token expired for ${email}, refreshing...`);
    const result = await refreshAccountToken(account.email);
    if (!result.success) {
      logger.error(`[Credentials] Refresh failed for ${email}: ${result.message}`);
      return null;
    }
    const refreshedData = loadAccounts();
    const refreshedAccount = refreshedData.accounts.find(a => a.email === email);
    if (!refreshedAccount) return null;

    return {
      accessToken: refreshedAccount.accessToken,
      accountId: refreshedAccount.accountId,
      email: refreshedAccount.email
    };
  }

  return {
    accessToken: account.accessToken,
    accountId: account.accountId,
    email: account.email
  };
}

/**
 * Sends a 401 authentication error response.
 * @param {import('express').Response} res
 * @param {string} [message]
 */
export function sendAuthError(res, message = 'No active account with valid credentials. Add an account via /accounts/add') {
  return res.status(401).json({
    type: 'error',
    error: { type: 'authentication_error', message }
  });
}

export default { getCredentialsOrError, getCredentialsForAccount, sendAuthError };
