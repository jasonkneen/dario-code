/**
 * Voice session coordinator.
 * Manages recording → transcription lifecycle.
 */

import { EventEmitter } from 'events'
import { isAvailable, startRecording, stopRecording } from './recorder.mjs'
import { transcribe, resolveProvider, resolveProviderAsync } from './transcribe.mjs'

class VoiceSession extends EventEmitter {
  constructor() {
    super()
    this.isRecording = false
    this.isTranscribing = false
  }

  /**
   * Begin recording. Emits 'recording' on success, 'error' on failure.
   */
  start() {
    if (this.isRecording || this.isTranscribing) return

    if (!isAvailable()) {
      const installHint = process.platform === 'win32'
        ? 'winget install --id sox_ng.sox_ng --exact or choco install sox_ng'
        : process.platform === 'darwin'
          ? 'brew install sox'
          : 'sudo apt install sox (or use your distro package manager)'
      this.emit('error', new Error(`sox is not installed. Run: ${installHint}`))
      return
    }

    try {
      startRecording()
      this.isRecording = true
      this.emit('recording')
    } catch (err) {
      this.emit('error', err)
    }
  }

  /**
   * Stop recording and transcribe. Emits 'transcribed' with text, or 'error'.
   */
  async stop() {
    if (!this.isRecording) return

    try {
      const wavPath = stopRecording()
      this.isRecording = false
      this.isTranscribing = true
      this.emit('transcribing')

      const text = await transcribe(wavPath)
      this.isTranscribing = false
      this.emit('transcribed', text)
    } catch (err) {
      this.isRecording = false
      this.isTranscribing = false
      this.emit('error', err)
    }
  }
}

export { VoiceSession, isAvailable, resolveProvider, resolveProviderAsync }
