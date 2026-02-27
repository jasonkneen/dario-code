/**
 * Plugin installer - handles plugin installation from npm and local sources
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync, spawn } from 'child_process'
import { fileExists, writeFile, readFile } from '../core/utils.mjs'
import { registerPlugin } from './registry.mjs'
import { getPluginsDir, getPluginDir } from './registry.mjs'
import { validateManifest } from './manifest.mjs'

const TEMP_DIR = path.join(os.tmpdir(), 'openclaude-plugins')

/**
 * Install a plugin from npm registry
 */
export async function installFromNpm(pluginName) {
  const pluginDir = getPluginDir(pluginName)

  // Create plugins directory if it doesn't exist
  const pluginsDir = getPluginsDir()
  if (!fileExists(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true })
  }

  // Create temp directory
  if (!fileExists(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }

  try {
    // Install to temp location first
    const tempPluginDir = path.join(TEMP_DIR, pluginName)
    if (fileExists(tempPluginDir)) {
      fs.rmSync(tempPluginDir, { recursive: true })
    }
    fs.mkdirSync(tempPluginDir, { recursive: true })

    // Use npm to install the package
    const cmd = `npm install --prefix "${tempPluginDir}" "${pluginName}@latest"`
    execSync(cmd, { stdio: 'pipe' })

    // Verify manifest exists
    const manifestPath = path.join(tempPluginDir, 'node_modules', pluginName, 'manifest.json')
    if (!fileExists(manifestPath)) {
      throw new Error(`Plugin does not have a manifest.json file`)
    }

    // Validate manifest
    const manifestContent = readFile(manifestPath)
    const manifest = JSON.parse(manifestContent)
    const validation = validateManifest(manifest)
    if (!validation.valid) {
      throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`)
    }

    // Move to final location
    if (fileExists(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true })
    }
    fs.mkdirSync(pluginDir, { recursive: true })

    // Copy plugin files
    const sourceDir = path.join(tempPluginDir, 'node_modules', pluginName)
    const files = fs.readdirSync(sourceDir)
    for (const file of files) {
      const src = path.join(sourceDir, file)
      const dest = path.join(pluginDir, file)
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true })
      } else {
        fs.copyFileSync(src, dest)
      }
    }

    // Clean up temp
    if (fileExists(tempPluginDir)) {
      fs.rmSync(tempPluginDir, { recursive: true })
    }

    // Register the plugin
    registerPlugin(pluginName)

    return {
      success: true,
      name: pluginName,
      version: manifest.version,
      path: pluginDir
    }
  } catch (e) {
    // Clean up on failure
    if (fileExists(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true })
    }
    throw new Error(`Failed to install plugin from npm: ${e.message}`)
  }
}

/**
 * Install a plugin from a local directory
 */
export async function installFromLocal(sourcePath) {
  // Verify source exists
  if (!fileExists(sourcePath)) {
    throw new Error(`Source path does not exist: ${sourcePath}`)
  }

  // Load and validate manifest
  const manifestPath = path.join(sourcePath, 'manifest.json')
  if (!fileExists(manifestPath)) {
    throw new Error(`No manifest.json found in ${sourcePath}`)
  }

  const manifestContent = readFile(manifestPath)
  const manifest = JSON.parse(manifestContent)

  const validation = validateManifest(manifest)
  if (!validation.valid) {
    throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`)
  }

  const pluginName = manifest.name
  const pluginDir = getPluginDir(pluginName)

  try {
    // Create plugins directory if needed
    const pluginsDir = getPluginsDir()
    if (!fileExists(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true })
    }

    // Copy plugin to plugins directory
    if (fileExists(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true })
    }
    fs.mkdirSync(pluginDir, { recursive: true })

    // Copy all files
    const files = fs.readdirSync(sourcePath)
    for (const file of files) {
      // Skip node_modules and hidden files
      if (file === 'node_modules' || file.startsWith('.')) {
        continue
      }

      const src = path.join(sourcePath, file)
      const dest = path.join(pluginDir, file)

      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true })
      } else {
        fs.copyFileSync(src, dest)
      }
    }

    // Register the plugin
    registerPlugin(pluginName)

    return {
      success: true,
      name: pluginName,
      version: manifest.version,
      path: pluginDir
    }
  } catch (e) {
    // Clean up on failure
    if (fileExists(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true })
    }
    throw new Error(`Failed to install plugin from local: ${e.message}`)
  }
}

/**
 * Uninstall a plugin
 */
export async function uninstallPlugin(pluginName) {
  const pluginDir = getPluginDir(pluginName)

  if (!fileExists(pluginDir)) {
    throw new Error(`Plugin not found: ${pluginName}`)
  }

  try {
    fs.rmSync(pluginDir, { recursive: true })
    return {
      success: true,
      name: pluginName
    }
  } catch (e) {
    throw new Error(`Failed to uninstall plugin: ${e.message}`)
  }
}

/**
 * Install a plugin from a GitHub repository with optional SHA pin.
 * Supports source format: "github:user/repo"
 *
 * @param {string} source - e.g. "github:user/repo"
 * @param {{ pin?: string }} options - Optional pin SHA/ref
 */
export async function installFromGit(source, options = {}) {
  const gitUrl = parseGitSource(source)
  if (!gitUrl) throw new Error(`Unsupported source format: ${source}`)

  const pluginsDir = getPluginsDir()
  if (!fileExists(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true })
  }

  // Clone to temp dir
  const tempName = `git-plugin-${Date.now()}`
  const tempDir = path.join(TEMP_DIR, tempName)
  if (!fileExists(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })

  try {
    // Use spawnSync with array args to avoid shell injection
    const { spawnSync } = await import('child_process')

    const cloneResult = spawnSync('git', ['clone', '--depth=50', gitUrl, tempDir], { stdio: 'pipe' })
    if (cloneResult.status !== 0) {
      throw new Error(`git clone failed: ${cloneResult.stderr?.toString().trim() || 'unknown error'}`)
    }

    // Checkout pin if specified (validate pin is a safe ref: alphanumeric + ./-)
    if (options.pin) {
      const safePin = options.pin.replace(/[^a-zA-Z0-9._\-/]/g, '')
      if (safePin !== options.pin) throw new Error(`Invalid pin ref: ${options.pin}`)
      const checkoutResult = spawnSync('git', ['-C', tempDir, 'checkout', safePin], { stdio: 'pipe' })
      if (checkoutResult.status !== 0) {
        throw new Error(`git checkout ${safePin} failed: ${checkoutResult.stderr?.toString().trim()}`)
      }
    }

    // Get the actual resolved SHA
    let resolvedSha = null
    try {
      const shaResult = spawnSync('git', ['-C', tempDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' })
      if (shaResult.status === 0) resolvedSha = shaResult.stdout.trim()
    } catch {}

    // Load and validate manifest
    const manifestPath = path.join(tempDir, 'manifest.json')
    if (!fileExists(manifestPath)) throw new Error('Plugin does not have a manifest.json file')

    const manifestContent = readFile(manifestPath)
    const manifest = JSON.parse(manifestContent)
    const validation = validateManifest(manifest)
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`)

    const pluginName = manifest.name
    const pluginDir = getPluginDir(pluginName)

    // Copy to final location
    if (fileExists(pluginDir)) fs.rmSync(pluginDir, { recursive: true })
    fs.cpSync(tempDir, pluginDir, { recursive: true })

    // Update manifest with pin metadata
    const installedManifestPath = path.join(pluginDir, 'manifest.json')
    const installedManifest = JSON.parse(readFile(installedManifestPath))
    installedManifest.source = source
    if (options.pin) installedManifest.pin = options.pin
    if (resolvedSha) installedManifest.resolvedSha = resolvedSha
    writeFile(installedManifestPath, JSON.stringify(installedManifest, null, 2))

    registerPlugin(pluginName)
    return { success: true, name: pluginName, version: manifest.version, path: pluginDir, resolvedSha }
  } finally {
    if (fileExists(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }) } catch {}
    }
  }
}

/**
 * Parse a source string like "github:user/repo" to a git clone URL.
 */
function parseGitSource(source) {
  if (!source) return null
  if (source.startsWith('github:')) {
    const repo = source.slice('github:'.length)
    // Only allow safe repo paths: alphanumeric, hyphens, underscores, forward slashes
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return null
    return `https://github.com/${repo}.git`
  }
  if (source.startsWith('https://') || source.startsWith('git@')) {
    return source
  }
  return null
}

/**
 * Update a plugin.
 * If the installed manifest has a `pin` field, warn and skip auto-update
 * unless the `force` or `unpin` option is set.
 *
 * @param {string} pluginName
 * @param {{ force?: boolean, unpin?: boolean }} options
 */
export async function updatePlugin(pluginName, options = {}) {
  // Check if pinned
  const pluginDir = getPluginDir(pluginName)
  const manifestPath = path.join(pluginDir, 'manifest.json')
  if (fileExists(manifestPath)) {
    try {
      const manifest = JSON.parse(readFile(manifestPath))
      if (manifest.pin && !options.force && !options.unpin) {
        return {
          success: false,
          skipped: true,
          name: pluginName,
          pin: manifest.pin,
          message: `Plugin is pinned to ${manifest.pin}. Use --force or --unpin to update.`
        }
      }
      // If source is a git source, reinstall from git
      if (manifest.source && parseGitSource(manifest.source)) {
        const pin = options.unpin ? undefined : manifest.pin
        return await installFromGit(manifest.source, { pin })
      }
    } catch {}
  }

  // Default: uninstall and reinstall from npm
  await uninstallPlugin(pluginName)
  return await installFromNpm(pluginName)
}

export default {
  installFromNpm,
  installFromLocal,
  installFromGit,
  uninstallPlugin,
  updatePlugin
}
