/**
 * Authentication module entry point
 * OAuth authentication via oauth.mjs
 */

// OAuth
export {
  authenticateWithOAuth,
  getValidToken,
  isOAuthAuthenticated,
  logout,
  getAuthInfo,
  loadToken,
  saveToken,
  deleteToken,
  setOAuthMode
} from './oauth.mjs'

import oauth from './oauth.mjs'

export default {
  oauth
}
