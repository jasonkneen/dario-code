/**
 * Diff Utilities
 *
 * Generates unified diffs for file edits, used by the TUI to show
 * before/after changes when tools modify files (CC 2.x feature).
 */

/**
 * Generate a simple unified diff between two strings.
 * Returns an array of { type, line } objects.
 * type: 'context' | 'add' | 'remove' | 'header'
 */
export function generateDiff(oldText, newText, filename = 'file', contextLines = 3) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  const hunks = computeHunks(oldLines, newLines, contextLines)

  if (hunks.length === 0) return []

  const result = [
    { type: 'header', line: `--- a/${filename}` },
    { type: 'header', line: `+++ b/${filename}` },
  ]

  for (const hunk of hunks) {
    result.push({ type: 'header', line: `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@` })
    for (const change of hunk.changes) {
      result.push(change)
    }
  }

  return result
}

/**
 * Format diff output as a coloured string for terminal display
 */
export function formatDiffForTerminal(diffLines) {
  if (!diffLines || diffLines.length === 0) return '  (no changes)'

  return diffLines.map(({ type, line }) => {
    switch (type) {
      case 'header': return `\x1b[36m${line}\x1b[0m`       // cyan
      case 'add':    return `\x1b[32m+ ${line}\x1b[0m`      // green
      case 'remove': return `\x1b[31m- ${line}\x1b[0m`      // red
      case 'context':return `  ${line}`
      default:       return `  ${line}`
    }
  }).join('\n')
}

/**
 * Compute diff hunks between old and new line arrays.
 * Uses a greedy window search suitable for typical file edits.
 */
function computeHunks(oldLines, newLines, contextLines = 3) {
  const changes = myersDiff(oldLines, newLines)

  if (changes.length === 0) return []

  const hunks = []
  let currentHunk = null

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]

    if (change.type === 'equal') {
      if (currentHunk) {
        currentHunk.changes.push({ type: 'context', line: change.line })
        // Check if the next non-equal change is far enough away to close this hunk
        let nextChangeIdx = -1
        for (let j = i + 1; j < changes.length; j++) {
          if (changes[j].type !== 'equal') { nextChangeIdx = j; break }
        }
        if (nextChangeIdx === -1 || nextChangeIdx - i > contextLines * 2) {
          // Trim trailing context to contextLines
          let count = 0
          for (let k = currentHunk.changes.length - 1; k >= 0; k--) {
            if (currentHunk.changes[k].type === 'context') count++
            else break
          }
          if (count > contextLines) {
            currentHunk.changes.splice(currentHunk.changes.length - (count - contextLines))
          }
          finishHunk(currentHunk)
          hunks.push(currentHunk)
          currentHunk = null
        }
      }
    } else {
      if (!currentHunk) {
        // Start new hunk — grab leading context and record start indices
        currentHunk = { changes: [], oldStart: -1, newStart: -1, oldCount: 0, newCount: 0 }
        let start = i - contextLines
        if (start < 0) start = 0
        for (let j = start; j < i; j++) {
          if (changes[j].type === 'equal') {
            // First context line establishes the hunk's starting position
            if (currentHunk.oldStart === -1) {
              currentHunk.oldStart = changes[j].oldIdx
              currentHunk.newStart = changes[j].newIdx
            }
            currentHunk.changes.push({ type: 'context', line: changes[j].line })
          }
        }
        // If there was no leading context, use the change's own position
        if (currentHunk.oldStart === -1) {
          currentHunk.oldStart = change.oldIdx !== undefined ? change.oldIdx : (change.newIdx || 0)
          currentHunk.newStart = change.newIdx !== undefined ? change.newIdx : (change.oldIdx || 0)
        }
      }
      currentHunk.changes.push({
        type: change.type === 'insert' ? 'add' : 'remove',
        line: change.line
      })
    }
  }

  if (currentHunk) {
    finishHunk(currentHunk)
    hunks.push(currentHunk)
  }

  return hunks
}

function finishHunk(hunk) {
  let oldCount = 0, newCount = 0
  for (const c of hunk.changes) {
    if (c.type === 'context') { oldCount++; newCount++ }
    else if (c.type === 'add') { newCount++ }
    else if (c.type === 'remove') { oldCount++ }
  }
  hunk.oldCount = oldCount
  hunk.newCount = newCount
}

/**
 * Greedy diff algorithm with 20-line lookahead window.
 * Emits { type, line, oldIdx, newIdx } for accurate hunk positioning.
 */
function myersDiff(oldLines, newLines) {
  const result = []
  let oi = 0, ni = 0

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      result.push({ type: 'equal', line: oldLines[oi], oldIdx: oi, newIdx: ni })
      oi++; ni++
    } else {
      // Look ahead to find next match within window
      let bestOld = -1, bestNew = -1, bestDist = Infinity
      const searchWindow = 20

      for (let o = oi; o < Math.min(oi + searchWindow, oldLines.length); o++) {
        for (let n = ni; n < Math.min(ni + searchWindow, newLines.length); n++) {
          if (oldLines[o] === newLines[n] && (o - oi + n - ni) < bestDist) {
            bestOld = o; bestNew = n; bestDist = o - oi + n - ni
            break // first match for this o is optimal (smallest n for this o)
          }
        }
      }

      if (bestDist < Infinity) {
        while (oi < bestOld) {
          result.push({ type: 'delete', line: oldLines[oi], oldIdx: oi })
          oi++
        }
        while (ni < bestNew) {
          result.push({ type: 'insert', line: newLines[ni], newIdx: ni })
          ni++
        }
      } else {
        // No match in window — emit one change from each side
        if (oi < oldLines.length) {
          result.push({ type: 'delete', line: oldLines[oi], oldIdx: oi })
          oi++
        }
        if (ni < newLines.length) {
          result.push({ type: 'insert', line: newLines[ni], newIdx: ni })
          ni++
        }
      }
    }
  }

  return result
}

/**
 * Generate a unified diff between before and after strings.
 * CC 2.x parity alias — used by permission prompts to show diffs before approval.
 *
 * @param {string} filename - File name shown in diff headers
 * @param {string} before - Original content
 * @param {string} after - New content
 * @param {number} context - Number of context lines (default 3)
 * @returns {Array<{ type, line }>} Diff line objects
 */
export function generateUnifiedDiff(filename, before, after, context = 3) {
  return generateDiff(before, after, filename, context)
}

/**
 * Render a diff as ANSI-coloured terminal output.
 * CC 2.x parity alias for use in permission prompts.
 * Truncates to at most 50 lines to keep prompts compact.
 *
 * @param {Array<{ type, line }>} diff - Output of generateDiff or generateUnifiedDiff
 * @returns {string} ANSI-coloured string ready for terminal display
 */
export function renderDiffColored(diff) {
  if (!diff || diff.length === 0) return '  (no changes)'
  const truncated = diff.length > 50 ? [...diff.slice(0, 50), { type: 'header', line: `... (${diff.length - 50} more lines)` }] : diff
  return formatDiffForTerminal(truncated)
}

export default { generateDiff, formatDiffForTerminal, generateUnifiedDiff, renderDiffColored }
