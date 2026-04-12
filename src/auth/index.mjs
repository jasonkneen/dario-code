/**
 * Authentication module entry point
 * OAuth authentication via oauth.mjs
 */

// OAuth
export {
  authenticateWithOAuth,
  authenticateWithOAuth as authenticate,
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
  oauth,
  authenticate: oauth.authenticateWithOAuth,
  authenticateWithOAuth: oauth.authenticateWithOAuth,
  getValidToken: oauth.getValidToken,
  isOAuthAuthenticated: oauth.isOAuthAuthenticated,
  logout: oauth.logout,
  getAuthInfo: oauth.getAuthInfo,
  loadToken: oauth.loadToken,
  saveToken: oauth.saveToken,
  deleteToken: oauth.deleteToken,
  setOAuthMode: oauth.setOAuthMode
}
