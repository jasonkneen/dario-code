/**
 * Input Component
 *
 * Input prompt component
 * - Command history (Ctrl+R)
 * - Multi-line support (Shift+Enter)
 * - Auto-complete
 */

import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { CLAUDE_COLORS } from '../theme.mjs'

/**
 * Input prompt component
 */
export function InputPrompt({ onSubmit, placeholder = '>', disabled = false }) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [multiline, setMultiline] = useState(false)

  // Handle submission
  const handleSubmit = (input) => {
    if (!input.trim()) return

    // Add to history
    setHistory(prev => [...prev, input])
    setHistoryIndex(-1)

    // Clear input
    setValue('')
    setMultiline(false)

    // Call callback
    if (onSubmit) {
      onSubmit(input)
    }
  }

  // Handle keyboard shortcuts
  useInput((input, key) => {
    // Ctrl+C - cancel input
    if (key.ctrl && input === 'c') {
      setValue('')
      return
    }

    // Ctrl+R - history search (TODO: implement search UI)
    if (key.ctrl && input === 'r') {
      // For now, just cycle through history
      if (history.length > 0) {
        const newIndex = historyIndex + 1
        if (newIndex < history.length) {
          setHistoryIndex(newIndex)
          setValue(history[history.length - 1 - newIndex])
        }
      }
      return
    }

    // Up arrow - previous history
    if (key.upArrow && !multiline) {
      if (history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1)
        setHistoryIndex(newIndex)
        setValue(history[history.length - 1 - newIndex])
      }
      return
    }

    // Down arrow - next history
    if (key.downArrow && !multiline) {
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setValue(history[history.length - 1 - newIndex])
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setValue('')
      }
      return
    }

    // Shift+Enter - multiline mode
    if (key.shift && key.return) {
      setValue(value + '\n')
      setMultiline(true)
      return
    }

    // Enter - submit (if not in multiline)
    if (key.return && !multiline) {
      handleSubmit(value)
      return
    }
  })

  if (disabled) {
    return React.createElement(Box, null,
      React.createElement(Text, { dimColor: true }, `${placeholder} (waiting...)`)
    )
  }

  return React.createElement(Box, null,
    React.createElement(Text, { color: CLAUDE_COLORS.claude }, `${placeholder} `),
    React.createElement(TextInput, {
      value: value,
      onChange: setValue,
      onSubmit: handleSubmit,
      placeholder: multiline ? '(Shift+Enter for newline, Enter to send)' : ''
    })
  )
}

/**
 * Multi-line input component (for longer prompts)
 */
export function MultiLineInput({ onSubmit, onCancel, initialValue = '' }) {
  const [lines, setLines] = useState(initialValue.split('\n'))
  const [currentLine, setCurrentLine] = useState(0)

  useInput((input, key) => {
    // Ctrl+D or Ctrl+Enter - submit
    if ((key.ctrl && input === 'd') || (key.ctrl && key.return)) {
      onSubmit(lines.join('\n'))
      return
    }

    // Esc - cancel
    if (key.escape) {
      if (onCancel) onCancel()
      return
    }
  })

  return React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', paddingX: 1 },
    React.createElement(Box, null,
      React.createElement(Text, { dimColor: true }, 'Multi-line mode (Ctrl+Enter to submit, Esc to cancel)')
    ),
    lines.map((line, i) =>
      React.createElement(Box, { key: i },
        React.createElement(Text, { dimColor: true }, `${i + 1}. `),
        React.createElement(Text, null, line)
      )
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: CLAUDE_COLORS.claude }, '❯ '),
      React.createElement(TextInput, {
        value: lines[currentLine],
        onChange: (value) => {
          const newLines = [...lines]
          newLines[currentLine] = value
          setLines(newLines)
        }
      })
    )
  )
}

export default {
  InputPrompt,
  MultiLineInput
}
