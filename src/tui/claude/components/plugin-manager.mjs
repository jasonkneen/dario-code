/**
 * Plugin Manager Component
 *
 * Interactive TUI overlay for browsing, installing, and managing plugins.
 * Three tabs: Discover, Installed, Marketplaces.
 * Pattern follows McpManager / ModelSelector overlays.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { fetchAvailablePlugins, searchPlugins, formatDownloads, isBundledPlugin } from '../../../plugins/discovery.mjs'
import { getRegistries, addRegistry, removeRegistry } from '../../../plugins/registry.mjs'

const THEME = {
  claude: '#D97706',
  text: '#E5E5E5',
  secondaryText: '#6B7280',
  secondaryBorder: '#374151',
  success: '#22C55E',
  error: '#EF4444',
  warning: '#F59E0B',
  suggestion: '#3B82F6',
}

const TABS = ['discover', 'installed', 'marketplaces']
const TAB_LABELS = { discover: 'Discover', installed: 'Installed', marketplaces: 'Marketplaces' }
const MAX_VISIBLE = 8

/**
 * @param {Object} props
 * @param {Array} props.installedPlugins - Array of { name, version, status, description }
 * @param {Function} props.onInstall - (pluginName) => Promise
 * @param {Function} props.onUninstall - (pluginName) => Promise
 * @param {Function} props.onEnable - (pluginName) => void
 * @param {Function} props.onDisable - (pluginName) => void
 * @param {Function} props.onCancel - Close the overlay
 * @param {Function} props.onMessage - Show a status message
 */
export function PluginManager({
  installedPlugins = [],
  onInstall,
  onUninstall,
  onEnable,
  onDisable,
  onCancel,
  onMessage,
}) {
  const [activeTab, setActiveTab] = useState('discover')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [availablePlugins, setAvailablePlugins] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [view, setView] = useState('list') // 'list' | 'detail' | 'confirm-install' | 'confirm-remove'
  const [detailPlugin, setDetailPlugin] = useState(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const [actionInProgress, setActionInProgress] = useState(false)

  // Marketplaces state
  const [registries, setRegistries] = useState(() => getRegistries())
  const [marketView, setMarketView] = useState('list') // 'list' | 'add'
  const [newRegName, setNewRegName] = useState('')
  const [newRegUrl, setNewRegUrl] = useState('')
  const [addStep, setAddStep] = useState('name') // 'name' | 'url'
  const [marketSelectedIndex, setMarketSelectedIndex] = useState(0)

  // Installed plugin names set for quick lookup
  const installedNames = new Set(installedPlugins.map(p => p.name))

  const isCtrlC = (char, key) =>
    char === '\x03' || (key?.ctrl && (char === 'c' || char === 'C'))

  // Fetch available plugins on mount
  useEffect(() => {
    loadAvailablePlugins()
  }, [])

  const loadAvailablePlugins = async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const plugins = await fetchAvailablePlugins()
      setAvailablePlugins(plugins)
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  // Get current list based on active tab + search
  const getCurrentList = () => {
    if (activeTab === 'discover') {
      const filtered = searchQuery
        ? searchPlugins(searchQuery, availablePlugins)
        : availablePlugins
      return filtered
    }
    if (activeTab === 'installed') {
      if (searchQuery) {
        const lower = searchQuery.toLowerCase()
        return installedPlugins.filter(p =>
          p.name.toLowerCase().includes(lower) ||
          (p.description || '').toLowerCase().includes(lower)
        )
      }
      return installedPlugins
    }
    return []
  }

  const currentList = getCurrentList()
  const scrollOffset = Math.max(0, selectedIndex - MAX_VISIBLE + 1)

  // Reset selected index when switching tabs or searching
  useEffect(() => {
    setSelectedIndex(0)
  }, [activeTab, searchQuery])

  // Keyboard handling
  useInput((char, key) => {
    // Always allow emergency exit from raw-input overlays.
    if (isCtrlC(char, key)) {
      process.stdout.write('\x1b[?25h') // Show cursor
      process.exit(0)
    }

    if (actionInProgress) {
      if (key.escape) onCancel?.()
      return
    }

    // Escape - back navigation
    if (key.escape) {
      if (searchFocused) {
        setSearchFocused(false)
        return
      }
      if (marketView === 'add') {
        setMarketView('list')
        setNewRegName('')
        setNewRegUrl('')
        setAddStep('name')
        return
      }
      if (view === 'detail' || view === 'confirm-install' || view === 'confirm-remove') {
        setView('list')
        setDetailPlugin(null)
        return
      }
      onCancel()
      return
    }

    // Detail view input
    if (view === 'detail') {
      handleDetailInput(char, key)
      return
    }

    // Confirm views
    if (view === 'confirm-install' || view === 'confirm-remove') {
      handleConfirmInput(char, key)
      return
    }

    // In search mode, let TextInput handle most keys
    if (searchFocused) {
      if (key.return) {
        setSearchFocused(false)
      }
      return
    }

    // Tab switching: Tab key or left/right arrows
    if (key.tab || key.rightArrow) {
      const idx = TABS.indexOf(activeTab)
      setActiveTab(TABS[(idx + 1) % TABS.length])
      setSearchQuery('')
      return
    }
    if (key.leftArrow) {
      const idx = TABS.indexOf(activeTab)
      setActiveTab(TABS[(idx - 1 + TABS.length) % TABS.length])
      setSearchQuery('')
      return
    }

    // List navigation
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(currentList.length - 1, i + 1))
      return
    }

    // Focus search
    if (char === '/') {
      if (activeTab !== 'marketplaces') {
        setSearchFocused(true)
      }
      return
    }

    // Marketplace-specific keys
    if (activeTab === 'marketplaces' && marketView === 'list') {
      if (char === 'a' || char === 'A') {
        setMarketView('add')
        return
      }
      if (char === 'd' || char === 'D') {
        const reg = registries[marketSelectedIndex]
        if (reg && !reg.default) {
          const updated = removeRegistry(reg.url)
          setRegistries(updated)
          setMarketSelectedIndex(i => Math.min(i, updated.length - 1))
          onMessage?.(`Removed registry: ${reg.name}`)
        }
        return
      }
      if (key.upArrow) {
        setMarketSelectedIndex(i => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setMarketSelectedIndex(i => Math.min(registries.length - 1, i + 1))
        return
      }
    }

    // Space - toggle install/enable
    if (char === ' ') {
      const item = currentList[selectedIndex]
      if (!item) return

      if (activeTab === 'discover') {
        if (installedNames.has(item.name)) {
          setDetailPlugin(item)
          setView('confirm-remove')
        } else {
          setDetailPlugin(item)
          setView('confirm-install')
        }
      } else if (activeTab === 'installed') {
        if (item.status === 'enabled') {
          onDisable?.(item.name)
          onMessage?.(`Disabled plugin: ${item.name}`)
        } else {
          onEnable?.(item.name)
          onMessage?.(`Enabled plugin: ${item.name}`)
        }
      }
      return
    }

    // Enter - show details
    if (key.return) {
      const item = currentList[selectedIndex]
      if (item) {
        setDetailPlugin(item)
        setView('detail')
      }
      return
    }

    // Any other character — start searching if in discover/installed tab
    if (char && !key.ctrl && !key.meta && activeTab !== 'marketplaces') {
      setSearchFocused(true)
      setSearchQuery(char)
    }
  }, { isActive: !searchFocused && marketView !== 'add' })

  // Search-focused keyboard handling:
  // allow Esc/Ctrl+C even while TextInput has focus.
  useInput((char, key) => {
    if (isCtrlC(char, key)) {
      process.stdout.write('\x1b[?25h') // Show cursor
      process.exit(0)
    }
    if (key.escape) {
      setSearchFocused(false)
    }
  }, { isActive: searchFocused && marketView !== 'add' })

  // Escape handler for marketplace add view
  useInput((char, key) => {
    if (isCtrlC(char, key)) {
      process.stdout.write('\x1b[?25h') // Show cursor
      process.exit(0)
    }
    if (key.escape) {
      setMarketView('list')
      setNewRegName('')
      setNewRegUrl('')
      setAddStep('name')
    }
  }, { isActive: marketView === 'add' })

  const handleDetailInput = (char, key) => {
    // In detail view: i = install/uninstall, e = enable/disable, Esc = back
    if (char === 'i' || char === 'I') {
      if (detailPlugin) {
        if (installedNames.has(detailPlugin.name)) {
          setView('confirm-remove')
        } else {
          setView('confirm-install')
        }
      }
      return
    }
    if (char === 'e' || char === 'E') {
      if (detailPlugin && installedNames.has(detailPlugin.name)) {
        const installed = installedPlugins.find(p => p.name === detailPlugin.name)
        if (installed?.status === 'enabled') {
          onDisable?.(detailPlugin.name)
          onMessage?.(`Disabled plugin: ${detailPlugin.name}`)
        } else {
          onEnable?.(detailPlugin.name)
          onMessage?.(`Enabled plugin: ${detailPlugin.name}`)
        }
      }
      return
    }
  }

  const handleConfirmInput = (char, key) => {
    if (char === 'y' || char === 'Y' || key.return) {
      if (view === 'confirm-install' && detailPlugin) {
        performInstall(detailPlugin.name)
      } else if (view === 'confirm-remove' && detailPlugin) {
        performUninstall(detailPlugin.name)
      }
      return
    }
    if (char === 'n' || char === 'N') {
      setView('list')
      setDetailPlugin(null)
      return
    }
  }

  const performInstall = async (name) => {
    setActionInProgress(true)
    onMessage?.(`Installing ${name}...`)
    try {
      await onInstall?.(name)
      onMessage?.(`Successfully installed ${name}`)
    } catch (err) {
      onMessage?.(`Failed to install ${name}: ${err.message}`)
    } finally {
      setActionInProgress(false)
      setView('list')
      setDetailPlugin(null)
    }
  }

  const performUninstall = async (name) => {
    setActionInProgress(true)
    onMessage?.(`Removing ${name}...`)
    try {
      await onUninstall?.(name)
      onMessage?.(`Successfully removed ${name}`)
    } catch (err) {
      onMessage?.(`Failed to remove ${name}: ${err.message}`)
    } finally {
      setActionInProgress(false)
      setView('list')
      setDetailPlugin(null)
    }
  }

  // ─── Render ────────────────────────────────────────────────

  const renderTabs = () => {
    return React.createElement(Box, { key: 'tabs', flexDirection: 'row', marginBottom: 1 },
      React.createElement(Text, { bold: true, color: THEME.claude }, ' Plugins  '),
      ...TABS.map(tab =>
        React.createElement(Text, {
          key: tab,
          bold: tab === activeTab,
          color: tab === activeTab ? THEME.text : THEME.secondaryText,
          inverse: tab === activeTab,
        }, ` ${TAB_LABELS[tab]} `, React.createElement(Text, { color: THEME.secondaryText }, '  '))
      )
    )
  }

  const renderSearchBar = () => {
    return React.createElement(Box, {
      key: 'search',
      borderStyle: 'round',
      borderColor: searchFocused ? THEME.suggestion : THEME.secondaryBorder,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
    },
      React.createElement(Text, { color: THEME.secondaryText }, '\u2315 '),
      searchFocused
        ? React.createElement(TextInput, {
            value: searchQuery,
            onChange: setSearchQuery,
            onSubmit: () => setSearchFocused(false),
            placeholder: 'Search...',
            focus: true,
          })
        : React.createElement(Text, { color: searchQuery ? THEME.text : THEME.secondaryText },
            searchQuery || 'Search...'
          )
    )
  }

  const renderDiscoverTab = () => {
    if (isLoading && availablePlugins.length === 0) {
      return React.createElement(Box, { flexDirection: 'column' },
        renderTabs(),
        React.createElement(Text, { dimColor: true }, '  Loading plugins from npm...')
      )
    }

    if (loadError && availablePlugins.length === 0) {
      return React.createElement(Box, { flexDirection: 'column' },
        renderTabs(),
        React.createElement(Text, { color: THEME.error }, '  No plugins found. Check your network connection.'),
        React.createElement(Text, { dimColor: true, marginTop: 1 }, `  Error: ${loadError}`)
      )
    }

    const visibleItems = currentList.slice(scrollOffset, scrollOffset + MAX_VISIBLE)
    const hasMore = scrollOffset + MAX_VISIBLE < currentList.length
    const hasAbove = scrollOffset > 0

    return React.createElement(Box, { flexDirection: 'column' },
      renderTabs(),
      React.createElement(Text, { key: 'count', dimColor: true, marginBottom: 1 },
        ` Discover plugins (${selectedIndex + 1}/${currentList.length})`
      ),
      renderSearchBar(),
      hasAbove
        ? React.createElement(Text, { key: 'scroll-up', dimColor: true }, '  \u2191 more above')
        : null,
      React.createElement(Box, { key: 'list', flexDirection: 'column' },
        visibleItems.length === 0
          ? React.createElement(Text, { dimColor: true }, '  No plugins match your search')
          : visibleItems.map((plugin, idx) => {
              const realIdx = scrollOffset + idx
              const isSelected = realIdx === selectedIndex
              const isInstalled = installedNames.has(plugin.name)
              const icon = isInstalled ? '\u25CF' : '\u25CB'
              const iconColor = isInstalled ? THEME.success : THEME.secondaryText

              return React.createElement(Box, {
                key: plugin.name,
                flexDirection: 'column',
                marginBottom: 0,
              },
                React.createElement(Box, { flexDirection: 'row' },
                  React.createElement(Text, {
                    color: isSelected ? THEME.suggestion : undefined,
                    inverse: isSelected,
                  },
                    isSelected ? ' \u276F ' : '   ',
                    React.createElement(Text, { color: iconColor }, icon),
                    ' ',
                    plugin.name,
                  ),
                  React.createElement(Text, { dimColor: true },
                    ` \u00B7 ${plugin.author}`,
                    plugin.downloads ? ` \u00B7 ${formatDownloads(plugin.downloads)} installs` : '',
                  )
                ),
                React.createElement(Text, { dimColor: true },
                  '     ',
                  (plugin.description || '').slice(0, 65),
                  (plugin.description || '').length > 65 ? '...' : ''
                )
              )
            })
      ),
      hasMore
        ? React.createElement(Text, { key: 'scroll-down', dimColor: true, marginTop: 0 }, '  \u2193 more below')
        : null,
      renderFooter()
    )
  }

  const renderInstalledTab = () => {
    return React.createElement(Box, { flexDirection: 'column' },
      renderTabs(),
      React.createElement(Text, { key: 'count', dimColor: true, marginBottom: 1 },
        ` Installed plugins (${installedPlugins.length})`
      ),
      installedPlugins.length > 0 ? renderSearchBar() : null,
      React.createElement(Box, { key: 'list', flexDirection: 'column' },
        currentList.length === 0
          ? React.createElement(Text, { dimColor: true },
              installedPlugins.length === 0
                ? '  No plugins installed. Switch to Discover to browse.'
                : '  No plugins match your search'
            )
          : currentList.map((plugin, idx) => {
              const isSelected = idx === selectedIndex
              const isEnabled = plugin.status === 'enabled'
              const icon = isEnabled ? '\u25CF' : '\u25CB'
              const iconColor = isEnabled ? THEME.success : THEME.secondaryText
              const statusLabel = isEnabled ? 'enabled' : 'disabled'

              return React.createElement(Box, {
                key: plugin.name,
                flexDirection: 'column',
              },
                React.createElement(Box, { flexDirection: 'row' },
                  React.createElement(Text, {
                    color: isSelected ? THEME.suggestion : undefined,
                    inverse: isSelected,
                  },
                    isSelected ? ' \u276F ' : '   ',
                    React.createElement(Text, { color: iconColor }, icon),
                    ' ',
                    plugin.name,
                  ),
                  React.createElement(Text, { dimColor: true },
                    plugin.version ? `@${plugin.version}` : '',
                    ` (${statusLabel})`
                  )
                ),
                plugin.description
                  ? React.createElement(Text, { dimColor: true },
                      '     ',
                      (plugin.description || '').slice(0, 65),
                      (plugin.description || '').length > 65 ? '...' : ''
                    )
                  : null
              )
            })
      ),
      renderFooter()
    )
  }

  const renderMarketplacesTab = () => {
    if (marketView === 'add') {
      return renderAddRegistryView()
    }

    return React.createElement(Box, { flexDirection: 'column' },
      renderTabs(),
      React.createElement(Text, { key: 'count', dimColor: true, marginBottom: 1 },
        ` Plugin registries (${registries.length})`
      ),
      React.createElement(Box, { key: 'list', flexDirection: 'column' },
        registries.map((reg, idx) => {
          const isSelected = idx === marketSelectedIndex
          return React.createElement(Box, {
            key: reg.url,
            flexDirection: 'column',
            marginBottom: 0,
          },
            React.createElement(Box, { flexDirection: 'row' },
              React.createElement(Text, {
                color: isSelected ? THEME.suggestion : undefined,
                inverse: isSelected,
              },
                isSelected ? ' \u276F ' : '   ',
                React.createElement(Text, { color: THEME.success }, '\u25CF'),
                ' ',
                reg.name,
                reg.default ? React.createElement(Text, { dimColor: true }, ' (default)') : null,
              ),
            ),
            React.createElement(Text, { dimColor: true },
              '     ',
              reg.url,
            )
          )
        })
      ),
      React.createElement(Box, { key: 'help', marginTop: 1 },
        React.createElement(Text, { dimColor: true },
          '\u2191\u2193 navigate \u00B7 a add registry \u00B7 d remove \u00B7 \u2190/\u2192 tabs \u00B7 Esc close'
        )
      )
    )
  }

  const renderAddRegistryView = () => {
    const isUrlStep = addStep === 'url'
    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, { bold: true, color: THEME.claude }, ' + Add Registry'),
      React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
        React.createElement(Box, { flexDirection: 'row' },
          React.createElement(Text, { dimColor: !isUrlStep, color: !isUrlStep ? THEME.suggestion : THEME.secondaryText }, '  Name: '),
          !isUrlStep
            ? React.createElement(TextInput, {
                value: newRegName,
                onChange: setNewRegName,
                onSubmit: () => { if (newRegName.trim()) setAddStep('url') },
                placeholder: 'my-registry',
                focus: true,
              })
            : React.createElement(Text, null, newRegName),
        ),
        isUrlStep
          ? React.createElement(Box, { flexDirection: 'row' },
              React.createElement(Text, { color: THEME.suggestion }, '  URL:  '),
              React.createElement(TextInput, {
                value: newRegUrl,
                onChange: setNewRegUrl,
                onSubmit: () => {
                  if (newRegUrl.trim()) {
                    const updated = addRegistry(newRegName.trim(), newRegUrl.trim())
                    setRegistries(updated)
                    onMessage?.(`Added registry: ${newRegName.trim()}`)
                    setMarketView('list')
                    setNewRegName('')
                    setNewRegUrl('')
                    setAddStep('name')
                  }
                },
                placeholder: 'https://registry.example.com',
                focus: true,
              }),
            )
          : null,
      ),
      React.createElement(Box, { key: 'help', marginTop: 1 },
        React.createElement(Text, { dimColor: true },
          'Enter to continue \u00B7 Esc to cancel'
        )
      )
    )
  }

  const renderDetailView = () => {
    if (!detailPlugin) return null
    const isInstalled = installedNames.has(detailPlugin.name)
    const installedInfo = installedPlugins.find(p => p.name === detailPlugin.name)
    const isEnabled = installedInfo?.status === 'enabled'

    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, { bold: true, color: THEME.claude }, ` \u23FA ${detailPlugin.name}`),
      React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
        React.createElement(Box, { flexDirection: 'row' },
          React.createElement(Text, { dimColor: true }, '  Author:  '),
          React.createElement(Text, null, detailPlugin.author || 'unknown')
        ),
        React.createElement(Box, { flexDirection: 'row' },
          React.createElement(Text, { dimColor: true }, '  Version: '),
          React.createElement(Text, null, detailPlugin.version || 'unknown')
        ),
        isInstalled
          ? React.createElement(Box, { flexDirection: 'row' },
              React.createElement(Text, { dimColor: true }, '  Status:  '),
              React.createElement(Text, { color: isEnabled ? THEME.success : THEME.secondaryText },
                isEnabled ? '\u25CF enabled' : '\u25CB disabled'
              )
            )
          : null,
        detailPlugin.downloads
          ? React.createElement(Box, { flexDirection: 'row' },
              React.createElement(Text, { dimColor: true }, '  Installs: '),
              React.createElement(Text, null, formatDownloads(detailPlugin.downloads))
            )
          : null,
      ),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, '  '),
        React.createElement(Text, null, detailPlugin.description || 'No description available')
      ),
      React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
        React.createElement(Text, { bold: true, dimColor: true }, '  Actions:'),
        React.createElement(Text, { color: THEME.suggestion },
          isInstalled ? '  [i] Uninstall' : '  [i] Install'
        ),
        isInstalled
          ? React.createElement(Text, { color: THEME.suggestion },
              isEnabled ? '  [e] Disable' : '  [e] Enable'
            )
          : null,
      ),
      React.createElement(Box, { key: 'help', marginTop: 1 },
        React.createElement(Text, { dimColor: true },
          'i install/uninstall \u00B7 e enable/disable \u00B7 Esc back'
        )
      )
    )
  }

  const renderConfirmView = () => {
    if (!detailPlugin) return null
    const isRemove = view === 'confirm-remove'
    const label = isRemove ? 'uninstall' : 'install'

    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, { bold: true, color: isRemove ? THEME.error : THEME.success },
        ` ${isRemove ? '\u2717' : '\u2713'} Confirm ${label}: ${detailPlugin.name}`
      ),
      actionInProgress
        ? React.createElement(Text, { marginTop: 1, dimColor: true },
            `  ${isRemove ? 'Removing' : 'Installing'}...`
          )
        : React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, null, `  ${isRemove ? 'Remove' : 'Install'} ${detailPlugin.name}? `),
            React.createElement(Text, { dimColor: true }, 'y/Enter to confirm \u00B7 n/Esc to cancel')
          )
    )
  }

  const renderFooter = () => {
    if (activeTab === 'discover') {
      return React.createElement(Box, { key: 'help', marginTop: 1 },
        React.createElement(Text, { dimColor: true },
          'type to search \u00B7 Space to toggle \u00B7 Enter details \u00B7 Esc back'
        )
      )
    }
    if (activeTab === 'installed') {
      return React.createElement(Box, { key: 'help', marginTop: 1 },
        React.createElement(Text, { dimColor: true },
          '\u2191\u2193 navigate \u00B7 Space enable/disable \u00B7 Enter details \u00B7 Esc close'
        )
      )
    }
    return null
  }

  // Main render
  if (view === 'detail') return renderDetailView()
  if (view === 'confirm-install' || view === 'confirm-remove') return renderConfirmView()

  switch (activeTab) {
    case 'discover': return renderDiscoverTab()
    case 'installed': return renderInstalledTab()
    case 'marketplaces': return renderMarketplacesTab()
    default: return renderDiscoverTab()
  }
}
