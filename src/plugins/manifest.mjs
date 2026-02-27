/**
 * Plugin manifest schema and validation
 * Defines the structure that all plugins must follow
 */

/**
 * Plugin manifest schema (expected structure)
 */
export const PLUGIN_MANIFEST_SCHEMA = {
  name: 'string (required) - unique identifier, lowercase with hyphens',
  version: 'string (required) - semantic version (e.g., 1.0.0)',
  description: 'string (required) - short description of what plugin does',
  author: 'string (optional) - plugin author name',
  license: 'string (optional) - plugin license',
  entry: 'string (optional) - path to entry point (default: index.mjs)',
  commands: 'array (optional) - custom commands provided by plugin',
  tools: 'array (optional) - MCP tools provided by plugin',
  config: 'object (optional) - default configuration values',
  source: 'string (optional) - install source, e.g. "github:user/repo"',
  pin: 'string (optional) - git SHA or ref to pin the plugin version (reproducible installs)',
  resolvedSha: 'string (internal) - the actual git SHA after installation'
}

/**
 * Validate a plugin manifest
 */
export function validateManifest(manifest) {
  const errors = []

  // Required fields
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('name is required and must be a string')
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('version is required and must be a string')
  }
  if (!manifest.description || typeof manifest.description !== 'string') {
    errors.push('description is required and must be a string')
  }

  // Validate name format (lowercase with hyphens only)
  if (manifest.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
    errors.push('name must be lowercase with hyphens only (e.g., my-plugin)')
  }

  // Validate version format (semantic versioning)
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push('version must follow semantic versioning (e.g., 1.0.0)')
  }

  // Optional validation
  if (manifest.entry && typeof manifest.entry !== 'string') {
    errors.push('entry must be a string path')
  }

  if (manifest.commands && !Array.isArray(manifest.commands)) {
    errors.push('commands must be an array')
  }

  if (manifest.tools && !Array.isArray(manifest.tools)) {
    errors.push('tools must be an array')
  }

  if (manifest.config && typeof manifest.config !== 'object') {
    errors.push('config must be an object')
  }

  // Optional SHA pin field — must be a non-empty string if present
  if (manifest.pin !== undefined && (typeof manifest.pin !== 'string' || !manifest.pin.trim())) {
    errors.push('pin must be a non-empty string (git SHA or ref)')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Create a plugin manifest object
 */
export function createManifest(data) {
  const manifest = {
    name: data.name,
    version: data.version,
    description: data.description,
    author: data.author || '',
    license: data.license || 'MIT',
    entry: data.entry || 'index.mjs',
    commands: data.commands || [],
    tools: data.tools || [],
    config: data.config || {}
  }

  // Preserve optional SHA pin fields
  if (data.source) manifest.source = data.source
  if (data.pin) manifest.pin = data.pin
  if (data.resolvedSha) manifest.resolvedSha = data.resolvedSha

  return manifest
}

export default {
  PLUGIN_MANIFEST_SCHEMA,
  validateManifest,
  createManifest
}
