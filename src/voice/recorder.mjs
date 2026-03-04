/**
 * Microphone recording via sox child process.
 * Records 16kHz mono WAV suitable for Whisper STT.
 */

import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync, existsSync } from 'fs'

let recProcess = null
let currentFile = null
const SOX_COMMAND_CANDIDATES = ['sox_ng', 'sox', 'rec']

function commandWorks(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, {
      stdio: 'ignore',
      timeout: 2000,
      windowsHide: true
    })
    return result.status === 0
  } catch {
    return false
  }
}

function resolveRecorderCommand() {
  for (const command of SOX_COMMAND_CANDIDATES) {
    if (commandWorks(command)) {
      return command
    }
  }
  return null
}

function buildRecorderArgs(command, wavPath) {
  if (command === 'sox' || command === 'sox_ng') {
    return ['-q', '-d', '-r', '16000', '-c', '1', '-b', '16', '-t', 'wav', wavPath]
  }
  return ['-q', '-r', '16000', '-c', '1', '-b', '16', '-t', 'wav', wavPath]
}

/**
 * Check if sox/rec is installed and available.
 * @returns {boolean}
 */
export function isAvailable() {
  return Boolean(resolveRecorderCommand())
}

/**
 * Start recording from the default microphone.
 * @returns {string} Path to the WAV file being written.
 */
export function startRecording() {
  if (recProcess) throw new Error('Already recording')

  const recorderCommand = resolveRecorderCommand()
  if (!recorderCommand) throw new Error('Sox recorder binary not found')

  const wavPath = join(tmpdir(), `dario-voice-${Date.now()}.wav`)
  currentFile = wavPath

  recProcess = spawn(recorderCommand, buildRecorderArgs(recorderCommand, wavPath), {
    stdio: 'ignore',
    windowsHide: true
  })

  recProcess.on('error', (err) => {
    recProcess = null
    currentFile = null
  })

  return wavPath
}

/**
 * Stop recording and return the WAV file path.
 * @returns {string} Path to the recorded WAV file.
 */
export function stopRecording() {
  if (!recProcess) throw new Error('Not recording')

  const wavPath = currentFile
  recProcess.kill('SIGTERM')
  recProcess = null
  currentFile = null
  return wavPath
}

/**
 * Clean up a temporary WAV file.
 * @param {string} wavPath
 */
export function cleanup(wavPath) {
  try {
    if (wavPath && existsSync(wavPath)) unlinkSync(wavPath)
  } catch {
    // best-effort cleanup
  }
}
