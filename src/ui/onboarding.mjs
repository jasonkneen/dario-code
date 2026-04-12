/**
 * Dario Onboarding Module
 * Readable implementations of onboarding and UI-related functions
 *
 * - AX9 -> initOnboarding
 * - BX9 -> completeOnboarding
 * - VX9 -> incrementStartupCounter
 * - ZX9 -> StickerRequestForm (React component)
 * - GR2 -> handleCliError
 * - IR2 -> getApprovedTools
 * - dR2 -> removeApprovedTool
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { writeFileSync } from 'fs'

// Config imports (these would be from the main config module)
let getGlobalConfig, saveGlobalConfig, getCurrentProjectConfig, saveCurrentProjectConfig

/**
 * Initialize config functions
 * Call this with the actual config functions from cli.mjs
 */
export function initConfigFunctions(globalGet, globalSave, projectGet, projectSave) {
  getGlobalConfig = globalGet
  saveGlobalConfig = globalSave
  getCurrentProjectConfig = projectGet
  saveCurrentProjectConfig = projectSave
}

// Version info
const VERSION_INFO = {
  ISSUES_EXPLAINER: "report the issue at https://github.com/anthropics/claude-code/issues",
  PACKAGE_URL: "@anthropic-ai/claude-code",
  README_URL: "https://docs.anthropic.com/s/claude-code",
  VERSION: "0.2.9"
}

/**
 * Complete the onboarding flow
 * Sets the hasCompletedOnboarding flag and records the version
 *
 * Original name: BX9
 */
export function completeOnboarding() {
  const currentConfig = getGlobalConfig()
  saveGlobalConfig({
    ...currentConfig,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: VERSION_INFO.VERSION
  })
}

/**
 * Initialize onboarding flow
 * Shows onboarding UI if user hasn't completed it yet
 *
 * Original name: AX9
 * @param {boolean} skipPermissions - Whether to skip permission dialogs
 * @param {boolean} printMode - Whether running in print/non-interactive mode
 */
export async function initOnboarding(skipPermissions, printMode) {
  const config = getGlobalConfig()

  // Dario: Force onboarding if user hasn't selected auth method yet
  // (for users who onboarded before auth selector was added)
  const needsAuthSelection = !config.selectedAuthMethod &&
                             !config.primaryApiKey &&
                             !config.apiKey &&
                             !config.claudeOAuthToken

  // Check if onboarding is needed
  if (!config.theme || !config.hasCompletedOnboarding || needsAuthSelection) {
    // Clear screen and show onboarding component
    await clearScreen()

    await new Promise((resolve) => {
      // Render the onboarding component (ss in original)
      renderInk(
        React.createElement(OnboardingComponent, {
          onDone: async () => {
            completeOnboarding()
            await clearScreen()
            resolve()
          }
        }),
        { exitOnCtrlC: false }
      )
    })
  }

  // If not in print mode and no initial prompt, show trust dialog if needed
  if (!printMode && !skipPermissions) {
    if (!hasTrustDialogAccepted()) {
      await new Promise((resolve) => {
        // Render trust dialog (iq2 in original)
        renderInk(
          React.createElement(TrustDialog, {
            onDone: () => {
              markTrustDialogAccepted()
              resolve()
            }
          }),
          { exitOnCtrlC: false }
        )
      })
    }
  }
}

/**
 * Increment the startup counter in config
 * Tracks how many times the CLI has been started
 *
 * Original name: VX9
 */
export function incrementStartupCounter() {
  const config = getGlobalConfig()
  saveGlobalConfig({
    ...config,
    numStartups: (config.numStartups ?? 0) + 1
  })
}

/**
 * Get list of approved tools for a given working directory
 *
 * Original name: IR2
 * @param {string} cwd - Current working directory
 * @param {object} configFunctions - Optional config function overrides for testing
 * @returns {string} Formatted string of approved tools
 */
export function getApprovedTools(cwd, configFunctions = null) {
  const configOps = configFunctions || {
    getCurrentProjectConfig,
    saveCurrentProjectConfig
  }

  const projectConfig = configOps.getCurrentProjectConfig()
  return `Allowed tools for ${cwd}:\n${projectConfig.allowedTools.join('\n')}`
}

/**
 * Remove a tool from the approved tools list
 *
 * Original name: dR2
 * @param {string} tool - Tool name to remove
 * @param {object} configFunctions - Optional config function overrides for testing
 * @returns {{ success: boolean, message: string }}
 */
export function removeApprovedTool(tool, configFunctions = null) {
  const configOps = configFunctions || {
    getCurrentProjectConfig,
    saveCurrentProjectConfig
  }

  const projectConfig = configOps.getCurrentProjectConfig()
  const originalLength = projectConfig.allowedTools.length
  const filteredTools = projectConfig.allowedTools.filter((t) => t !== tool)

  if (originalLength !== filteredTools.length) {
    projectConfig.allowedTools = filteredTools
    configOps.saveCurrentProjectConfig(projectConfig)
    return {
      success: true,
      message: `Removed ${tool} from the list of approved tools`
    }
  }

  return {
    success: false,
    message: `${tool} was not in the list of approved tools`
  }
}

/**
 * Handle CLI configuration errors
 * Shows a dialog for invalid JSON config files
 *
 * Original name: GR2
 * @param {{ error: { filePath: string, message: string, defaultConfig: object }}} params
 * @returns {Promise<void>}
 */
export function handleCliError({ error }) {
  return new Promise((resolve) => {
    renderInk(
      React.createElement(ConfigErrorDialog, {
        filePath: error.filePath,
        errorDescription: error.message,
        onExit: () => {
          resolve()
          process.exit(1)
        },
        onReset: () => {
          writeFileSync(error.filePath, JSON.stringify(error.defaultConfig, null, 2))
          resolve()
          process.exit(0)
        }
      }),
      { exitOnCtrlC: false }
    )
  })
}

/**
 * Configuration error dialog component
 * Shows options to exit or reset config
 *
 * Original name: ZX9 (different component but same pattern)
 */
function ConfigErrorDialog({ filePath, errorDescription, onExit, onReset }) {
  const theme = getTheme()

  useInput((input, key) => {
    if (key.escape) onExit()
  })

  const handleChoice = (choice) => {
    if (choice === 'exit') onExit()
    else onReset()
  }

  return React.createElement(React.Fragment, null,
    React.createElement(Box, {
      flexDirection: 'column',
      borderColor: theme.error,
      borderStyle: 'round',
      padding: 1,
      width: 70,
      gap: 1
    },
      React.createElement(Text, { bold: true }, 'Configuration Error'),
      React.createElement(Box, { flexDirection: 'column', gap: 1 },
        React.createElement(Text, null,
          'The configuration file at ',
          React.createElement(Text, { bold: true }, filePath),
          ' contains invalid JSON.'
        ),
        React.createElement(Text, null, errorDescription)
      ),
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { bold: true }, 'Choose an option:'),
        React.createElement(SelectInput, {
          options: [
            { label: 'Exit and fix manually', value: 'exit' },
            { label: 'Reset with default configuration', value: 'reset' }
          ],
          onChange: handleChoice
        })
      )
    )
  )
}

// ============================================================================
// Sticker Request Form (Easter Egg)
// Original name: xq2 (wrapped by ZX9)
// ============================================================================

/**
 * US States for validation
 */
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
])

/**
 * Validate a form field
 *
 * Original name: Ie
 * @param {string} fieldName - Field to validate
 * @param {string} value - Value to validate
 * @returns {null | { message: string }} - Null if valid, error object if invalid
 */
export function validateField(fieldName, value) {
  const trimmed = value.trim()

  // address2 is optional
  if (!trimmed && fieldName === 'address2') return null

  // All other fields are required
  if (!trimmed) {
    return { message: 'This field is required' }
  }

  switch (fieldName) {
    case 'email': {
      const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
      if (!emailRegex.test(trimmed)) {
        return { message: 'Please enter a valid email address' }
      }
      break
    }

    case 'name':
      if (trimmed.length < 2) {
        return { message: 'Name must be at least 2 characters long' }
      }
      break

    case 'address1': {
      if (trimmed.length < 3) {
        return { message: 'Please enter a valid address' }
      }
      // Check for PO Box or street number
      const isPoBox = /^P\.?O\.?\s*Box\s+\d+$/i.test(trimmed)
      const hasNumber = /\d+/.test(trimmed)
      if (!isPoBox && !hasNumber) {
        return { message: 'Please include a number in the street address' }
      }
      break
    }

    case 'address2':
      // Optional field, already handled above
      break

    case 'city':
      if (trimmed.length < 2) {
        return { message: 'City name must be at least 2 characters long' }
      }
      if (!/^[a-zA-Z\s.-]+$/.test(trimmed)) {
        return { message: 'City can only contain letters, spaces, periods, and hyphens' }
      }
      break

    case 'state': {
      const stateUpper = trimmed.toUpperCase()
      if (!US_STATES.has(stateUpper)) {
        return { message: 'Please enter a valid US state code (e.g. CA)' }
      }
      break
    }

    case 'usLocation': {
      const lower = trimmed.toLowerCase()
      if (!['y', 'yes', 'n', 'no'].includes(lower)) {
        return { message: 'Please enter y/yes or n/no' }
      }
      break
    }

    case 'zip':
      if (!/^\d{5}(-\d{4})?$/.test(trimmed)) {
        return { message: 'Please enter a valid ZIP code (e.g. 12345 or 12345-6789)' }
      }
      break

    case 'phone':
      if (!/^(\+1\s?)?(\d{3}[-.\s]??)?\d{3}[-.\s]??\d{4}$/.test(trimmed)) {
        return { message: 'Please enter a valid US phone number' }
      }
      break
  }

  return null
}

/**
 * Build Google Form URL with pre-filled data
 * @param {object} formData - Form data object
 * @returns {string} - Google Form URL
 */
function buildGoogleFormUrl(formData) {
  const name = encodeURIComponent(formData.name || '')
  const email = encodeURIComponent(formData.email || '')
  const phone = encodeURIComponent(formData.phone || '')
  const address1 = encodeURIComponent(formData.address1 || '')
  const address2 = encodeURIComponent(formData.address2 || '')
  const city = encodeURIComponent(formData.city || '')
  const state = encodeURIComponent(formData.state || '')
  const country = encodeURIComponent('USA')

  return `https://docs.google.com/forms/d/e/1FAIpQLSfYhWr1a-t4IsvS2FKyEH45HRmHKiPUycvAlFKaD0NugqvfDA/viewform?usp=pp_url&entry.2124017765=${name}&entry.1522143766=${email}&entry.1730584532=${phone}&entry.1700407131=${address1}&entry.109484232=${address2}&entry.1209468849=${city}&entry.222866183=${state}&entry.1042966503=${country}`
}

/**
 * Form field definitions
 */
const FORM_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'usLocation', label: 'Are you in the United States? (y/n)' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'address1', label: 'Address Line 1' },
  { key: 'address2', label: 'Address Line 2 (optional)' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP Code' }
]

/**
 * Sticker Request Form Component
 * Easter egg component
 *
 * Original name: xq2
 * @param {{ onSubmit: Function, onClose: Function }} props
 */
export function StickerRequestForm({ onSubmit, onClose }) {
  const [googleFormUrl, setGoogleFormUrl] = useState('')
  const { rows } = useStdout()

  // Determine spinner size based on terminal height
  const getSpinnerSize = () => {
    if (rows >= 50) return 'large'
    if (rows >= 35) return 'medium'
    return 'small'
  }

  // Form state
  const [formData, setFormData] = useState({})
  const [selectedField, setSelectedField] = useState('name')
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState(null)
  const [isComplete, setIsComplete] = useState(false)
  const [isNotUS, setIsNotUS] = useState(false)
  const [usChoice, setUsChoice] = useState('yes')

  const theme = getTheme()

  // Move to next field
  const moveToNextField = (currentField) => {
    const currentIndex = FORM_FIELDS.findIndex((f) => f.key === currentField)
    const nextIndex = currentIndex + 1

    if (currentIndex === -1) throw new Error('Invalid field state')

    const nextField = FORM_FIELDS[nextIndex]
    if (!nextField) throw new Error('Invalid field state')

    // Analytics tracking would go here
    // trackEvent('sticker_form_field_completed', {...})

    setSelectedField(nextField.key)
    const nextValue = formData[nextField.key]?.toString() || ''
    setInputValue(nextValue)
    setCursorOffset(nextValue.length)
    setError(null)
  }

  // Handle keyboard input
  useInput((input, key) => {
    // Escape or Ctrl+C/D to close
    if (key.escape || (key.ctrl && (input === 'c' || input === 'd'))) {
      onClose()
      return
    }

    // If complete or not US, Enter returns to main
    if (isComplete && key.return) {
      onClose()
      return
    }
    if (isNotUS && key.return) {
      onClose()
      return
    }

    // US location selection
    if (selectedField === 'usLocation' && !isComplete) {
      if (key.leftArrow || key.rightArrow) {
        setUsChoice((prev) => prev === 'yes' ? 'no' : 'yes')
        return
      }

      if (key.return) {
        if (usChoice === 'yes') {
          const newData = { ...formData, [selectedField]: true }
          setFormData(newData)
          moveToNextField(selectedField)
        } else {
          setIsNotUS(true)
        }
        return
      }

      // Quick y/n keys
      const lower = input.toLowerCase()
      if (['y', 'yes'].includes(lower)) {
        const newData = { ...formData, [selectedField]: true }
        setFormData(newData)
        moveToNextField(selectedField)
        return
      }
      if (['n', 'no'].includes(lower)) {
        setIsNotUS(true)
        return
      }
    }

    // Tab navigation
    if (!isComplete && key.tab) {
      if (key.shift) {
        // Previous field
        const currentIndex = FORM_FIELDS.findIndex((f) => f.key === selectedField)
        if (currentIndex === -1) throw new Error('Invalid field state')

        const prevIndex = (currentIndex - 1 + FORM_FIELDS.length) % FORM_FIELDS.length
        const prevField = FORM_FIELDS[prevIndex]
        if (!prevField) throw new Error('Invalid field index')

        setSelectedField(prevField.key)
        const prevValue = formData[prevField.key]?.toString() || ''
        setInputValue(prevValue)
        setCursorOffset(prevValue.length)
        setError(null)
        return
      }

      // Validate current field before moving forward (except optional fields)
      if (selectedField !== 'address2' && selectedField !== 'usLocation') {
        const trimmed = inputValue.trim()
        if (validateField(selectedField, trimmed)) {
          setError({ message: 'Please fill out this field before continuing' })
          return
        }
        const newData = { ...formData, [selectedField]: trimmed }
        setFormData(newData)
      }

      // Next field
      const currentIndex = FORM_FIELDS.findIndex((f) => f.key === selectedField)
      if (currentIndex === -1) throw new Error('Invalid field state')

      const nextIndex = (currentIndex + 1) % FORM_FIELDS.length
      const nextField = FORM_FIELDS[nextIndex]
      if (!nextField) throw new Error('Invalid field index')

      setSelectedField(nextField.key)
      const nextValue = formData[nextField.key]?.toString() || ''
      setInputValue(nextValue)
      setCursorOffset(nextValue.length)
      setError(null)
      return
    }

    // Submit on Enter when complete
    if (isComplete && key.return) {
      onSubmit(formData)
    }
  })

  // Handle field submission
  const handleFieldSubmit = (value) => {
    // Allow empty address2
    if (!value && selectedField === 'address2') {
      const newData = { ...formData, [selectedField]: '' }
      setFormData(newData)
      moveToNextField(selectedField)
      return
    }

    // Validate
    const validationError = validateField(selectedField, value)
    if (validationError) {
      setError(validationError)
      return
    }

    // Cross-validate state/zip if both present
    if (selectedField === 'state' && formData.zip) {
      if (validateField('zip', formData.zip)) {
        setError({ message: 'The existing ZIP code is not valid for this state' })
        return
      }
    }

    // Update form data
    const newData = { ...formData, [selectedField]: value }
    setFormData(newData)
    setError(null)

    // Check if last field
    const currentIndex = FORM_FIELDS.findIndex((f) => f.key === selectedField)
    if (currentIndex === -1) throw new Error('Invalid field state')

    if (currentIndex < FORM_FIELDS.length - 1) {
      moveToNextField(selectedField)
    } else {
      setIsComplete(true)
    }
  }

  // Get current field definition
  const currentField = FORM_FIELDS.find((f) => f.key === selectedField)
  if (!currentField) throw new Error('Invalid field state')

  // Generate Google Form URL when complete
  if (isComplete && !googleFormUrl) {
    const url = buildGoogleFormUrl(formData)
    setGoogleFormUrl(url)
    // Analytics and open URL would go here
    // trackEvent('sticker_form_summary_reached', {...})
    // openUrl(url)
  }

  // Header content
  const classifiedHeader = `
+------------------------------+
|         CLASSIFIED           |
+------------------------------+`

  const secretMessage = "You've discovered Dario's top secret sticker distribution operation!"

  // Render header section
  const renderHeader = () => (
    React.createElement(React.Fragment, null,
      React.createElement(Box, {
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      },
        React.createElement(Text, null, classifiedHeader),
        React.createElement(Text, { bold: true, color: theme.claude }, secretMessage)
      ),
      !isComplete && React.createElement(Box, { justifyContent: 'center' },
        React.createElement(ClaudeSpinner, {
          size: getSpinnerSize(),
          cycles: getSpinnerSize() === 'large' ? 4 : undefined
        })
      )
    )
  )

  // Render instructions
  const renderInstructions = () => (
    React.createElement(Box, { marginLeft: 1 },
      isNotUS || isComplete
        ? React.createElement(Text, { color: theme.suggestion, bold: true },
            'Press Enter to return to base'
          )
        : React.createElement(Text, { color: theme.secondaryText },
            selectedField === 'usLocation'
              ? '<-/-> arrows to select . Enter to confirm . Y/N keys also work . Esc Esc to abort mission'
              : 'Enter to continue . Tab/Shift+Tab to navigate . Esc to abort mission'
          )
    )
  )

  // Render form content based on state
  const renderFormContent = () => {
    if (isComplete) {
      // Summary view
      return React.createElement(React.Fragment, null,
        React.createElement(Box, null,
          React.createElement(Text, { color: theme.suggestion, bold: true },
            'Please review your shipping information:'
          )
        ),
        React.createElement(Box, { flexDirection: 'column' },
          FORM_FIELDS.filter((f) => f.key !== 'usLocation').map((field) =>
            React.createElement(Box, { key: field.key, marginLeft: 3 },
              React.createElement(Text, null,
                React.createElement(Text, { bold: true, color: theme.text },
                  field.label, ':'
                ),
                ' ',
                React.createElement(Text, {
                  color: !formData[field.key] ? theme.secondaryText : theme.text
                },
                  formData[field.key] || '(empty)'
                )
              )
            )
          )
        ),
        React.createElement(Box, {
          marginTop: 1,
          marginBottom: 1,
          flexDirection: 'column'
        },
          React.createElement(Box, null,
            React.createElement(Text, { color: theme.text },
              'Submit your sticker request:'
            )
          ),
          React.createElement(Box, { marginTop: 1 },
            React.createElement(Link, { url: googleFormUrl },
              React.createElement(Text, { color: theme.success, underline: true },
                '-> Click here to open Google Form'
              )
            )
          ),
          React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.secondaryText, italic: true },
              '(You can still edit your info on the form)'
            )
          )
        )
      )
    }

    if (isNotUS) {
      // Not in US message
      return React.createElement(React.Fragment, null,
        React.createElement(Box, { marginY: 1 },
          React.createElement(Text, { color: theme.error, bold: true },
            'Mission Not Available'
          )
        ),
        React.createElement(Box, { flexDirection: 'column', marginY: 1 },
          React.createElement(Text, { color: theme.text },
            'We\'re sorry, but the Dario sticker deployment mission is only available within the United States.'
          ),
          React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.text },
              'Future missions may expand to other territories. Stay tuned for updates.'
            )
          )
        )
      )
    }

    // Main form view
    return React.createElement(React.Fragment, null,
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { color: theme.text },
          'Please provide your coordinates for the sticker deployment mission.'
        ),
        React.createElement(Text, { color: theme.secondaryText },
          'Currently only shipping within the United States.'
        )
      ),
      // Progress indicators
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Box, { flexDirection: 'row', marginLeft: 2 },
          FORM_FIELDS.map((field, index) =>
            React.createElement(React.Fragment, { key: field.key },
              React.createElement(Text, {
                color: field.key === selectedField ? theme.suggestion : theme.secondaryText
              },
                field.key === selectedField
                  ? `[${field.label}]`
                  : formData[field.key]
                    ? React.createElement(Text, { color: theme.secondaryText }, 'o')
                    : 'O'
              ),
              index < FORM_FIELDS.length - 1 && React.createElement(Text, null, ' ')
            )
          )
        ),
        React.createElement(Box, { marginLeft: 2 },
          React.createElement(Text, { color: theme.secondaryText },
            'Field ', FORM_FIELDS.findIndex((f) => f.key === selectedField) + 1,
            ' of ', FORM_FIELDS.length
          )
        )
      ),
      // Input field or US location selector
      React.createElement(Box, { flexDirection: 'column', marginX: 2 },
        selectedField === 'usLocation'
          ? React.createElement(Box, { flexDirection: 'row' },
              React.createElement(Text, {
                color: usChoice === 'yes' ? theme.success : theme.secondaryText,
                bold: true
              },
                usChoice === 'yes' ? 'o' : 'O', ' YES'
              ),
              React.createElement(Text, null, ' '),
              React.createElement(Text, {
                color: usChoice === 'no' ? theme.error : theme.secondaryText,
                bold: true
              },
                usChoice === 'no' ? 'o' : 'O', ' NO'
              )
            )
          : React.createElement(TextInput, {
              value: inputValue,
              onChange: setInputValue,
              onSubmit: handleFieldSubmit,
              placeholder: currentField.label,
              cursorOffset: cursorOffset,
              onChangeCursorOffset: setCursorOffset,
              columns: 40
            }),
        // Error display
        error && React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: theme.error, bold: true },
            'x ', error.message
          )
        )
      )
    )
  }

  // Main render
  return React.createElement(Box, {
    flexDirection: 'column',
    paddingLeft: 1
  },
    React.createElement(Box, {
      borderColor: theme.claude,
      borderStyle: 'round',
      flexDirection: 'column',
      gap: 1,
      padding: 1,
      paddingLeft: 2,
      width: 100
    },
      renderHeader(),
      renderFormContent()
    ),
    renderInstructions()
  )
}

// ============================================================================
// Claude Spinner Animation (Easter Egg)
// Original name: kq2
// ============================================================================

/**
 * ASCII art frames for large spinner
 */
const LARGE_SPINNER_FRAMES = [
  // Frame 0 - Full detail
  `
              .=#*=.      :==.
              -%%%%=.    .#%#=
              .=%%%#=    :%%#:    -=+-
         ...   .=%%%*-   =@%+   :+%%%%.
        :*%%+=  .=%%%*-  +%%= .=%%%%%=
        .=#%%%#=..=#%%*: *%#:-*%%%%+:
          .=*%%%%+==#%%+.%%+=#%%%%=.
             :=#%%%##%%%*%%%%%%%*-       .
                -=#%%%%%%%%%%%%+-====+*%%%+.
     .============-=*%%%%%%%%%%%%%%%%#+===:
      =======+++****%%%%%%%%%%#+==:.
                  -=*%%%%%%%%%*+#%%%%%%%#*=.
              .=+#%#++#%%%%%%%%+-..-==+*##=.
           .=+%%%+=-+%#=*%+%%%##%+:
         .+%%%*=. =*%+:-%%:=#%#==#%+:
         .=+=.  .=%%=. +%#. -*%%=:=*%+-
               -*%#=  .#%*   :*%%+: :=*.
             .=%%=.   =%%=    .=%%=.
              :=.     +%%=     .-=:
                      =#+.                        `,
  // ... more frames would be here (abbreviated for readability)
]

/**
 * ASCII art frames for small spinner
 */
const SMALL_SPINNER_FRAMES = [
  `   @
@  @  @
  @@@
@  @  @
   @`,
  `   *
*  *  *
  ***
*  *  *
   *`,
  `   +
+  +  +
  +++
+  +  +
   +`,
  `   /
/  /  /
  ///
/  /  /
   /`,
  `   |
|  |  |
  |||
|  |  |
   |`,
  `   \\
\\  \\  \\
  \\\\\\
\\  \\  \\
   \\`,
  `   -
-  -  -
  ---
-  -  -
   -`
]

/**
 * Claude Spinner Component
 * Animated ASCII art spinner
 *
 * Original name: kq2
 * @param {{ size?: 'small' | 'large', cycles?: number, color?: string, intervalMs?: number }} props
 */
export function ClaudeSpinner({
  size = 'small',
  cycles,
  color,
  intervalMs
}) {
  const [frameIndex, setFrameIndex] = useState(0)
  const direction = useRef(1)
  const cycleCount = useRef(0)
  const theme = getTheme()

  const frames = size === 'large' ? LARGE_SPINNER_FRAMES : SMALL_SPINNER_FRAMES

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((current) => {
        // Stop if reached cycle limit
        if (cycles !== undefined && cycles !== null && cycleCount.current >= cycles) {
          return 0
        }

        // Reverse at ends
        if (current === frames.length - 1) {
          direction.current = -1
          cycleCount.current += 1
        }
        if (current === 0) {
          direction.current = 1
        }

        return current + direction.current
      })
    }, intervalMs || (size === 'large' ? 100 : 200))

    return () => clearInterval(interval)
  }, [frames.length, cycles, intervalMs, size])

  return React.createElement(Text, {
    color: color || theme.claude
  }, frames[frameIndex])
}

// ============================================================================
// Placeholder functions (these would be imported from other modules)
// ============================================================================

// These are placeholders - in the real implementation they come from other modules
function getTheme() {
  return {
    claude: '#cc785c',
    suggestion: '#6b9f78',
    secondaryText: '#7a7a7a',
    text: '#d4d4d4',
    success: '#6b9f78',
    error: '#f14c4c',
    warning: '#cca700',
    permission: '#6c9cde'
  }
}

function useStdout() {
  return { rows: 40 }
}

function clearScreen() {
  return Promise.resolve()
}

function renderInk(element, options) {
  // This would be the actual Ink render function
}

function hasTrustDialogAccepted() {
  return false
}

function markTrustDialogAccepted() {
  // Mark trust dialog as accepted
}

// Placeholder components
function OnboardingComponent({ onDone }) {
  return React.createElement(Box, null,
    React.createElement(Text, null, 'Onboarding...')
  )
}

function TrustDialog({ onDone }) {
  return React.createElement(Box, null,
    React.createElement(Text, null, 'Trust Dialog...')
  )
}

function SelectInput({ options, onChange }) {
  return React.createElement(Box, null,
    React.createElement(Text, null, 'Select...')
  )
}

function TextInput({ value, onChange, onSubmit, placeholder }) {
  return React.createElement(Box, null,
    React.createElement(Text, null, placeholder)
  )
}

function Link({ url, children }) {
  return React.createElement(Text, null, children)
}

// Export all functions
export default {
  initOnboarding,
  completeOnboarding,
  incrementStartupCounter,
  getApprovedTools,
  removeApprovedTool,
  handleCliError,
  validateField,
  StickerRequestForm,
  ClaudeSpinner,
  initConfigFunctions
}
