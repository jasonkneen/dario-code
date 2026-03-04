import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { PNG } from 'pngjs'

const WINDOWS_CLIPBOARD_SIZE_COMMAND = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'if ([Windows.Forms.Clipboard]::ContainsImage()) {',
  "  $img = [Windows.Forms.Clipboard]::GetImage()",
  "  Write-Output ($img.Width.ToString() + ',' + $img.Height.ToString())",
  '}'
].join('; ')

let ClipboardCtorPromise = null
let powerShellExecutable = null

function getPowerShellExecutable() {
  if (powerShellExecutable) return powerShellExecutable

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const ps1 = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const ps2 = path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  if (existsSync(ps1)) {
    powerShellExecutable = ps1
    return powerShellExecutable
  }
  if (existsSync(ps2)) {
    powerShellExecutable = ps2
    return powerShellExecutable
  }

  powerShellExecutable = 'powershell.exe'
  return powerShellExecutable
}

async function getClipboardCtor() {
  if (!ClipboardCtorPromise) {
    ClipboardCtorPromise = import('@napi-rs/clipboard')
      .then((mod) => mod.Clipboard)
      .catch(() => null)
  }
  return ClipboardCtorPromise
}

async function getClipboardInstance() {
  const Clipboard = await getClipboardCtor()
  return Clipboard ? new Clipboard() : null
}

export function getWindowsClipboardImageSize() {
  try {
    const output = execFileSync(
      getPowerShellExecutable(),
      ['-NoProfile', '-STA', '-Command', WINDOWS_CLIPBOARD_SIZE_COMMAND],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      }
    ).trim()

    if (!output) return null

    const [widthStr, heightStr] = output.split(',')
    const width = Number(widthStr)
    const height = Number(heightStr)

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null
    }

    return { width, height }
  } catch {
    return null
  }
}

export async function getWindowsClipboardText() {
  try {
    const clipboard = await getClipboardInstance()
    if (!clipboard) return null
    const text = clipboard.getText()
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export async function setWindowsClipboardText(text) {
  const clipboard = await getClipboardInstance()
  if (!clipboard) throw new Error('Windows clipboard binding unavailable')
  clipboard.setText(text ?? '')
}

export async function getWindowsClipboardImageRaw() {
  try {
    const clipboard = await getClipboardInstance()
    if (!clipboard) return null
    const image = clipboard.getImage()
    if (!image || image.length < 4) return null
    return image
  } catch {
    return null
  }
}

export async function setWindowsClipboardImageRaw(width, height, rgbaBuffer) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error('Invalid width: must be a positive integer')
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error('Invalid height: must be a positive integer')
  }

  if (!Buffer.isBuffer(rgbaBuffer) && !(rgbaBuffer instanceof Uint8Array)) {
    throw new Error('Invalid rgbaBuffer: must be a Buffer or Uint8Array')
  }

  const raw = Buffer.isBuffer(rgbaBuffer) ? rgbaBuffer : Buffer.from(rgbaBuffer)
  const expectedBytes = width * height * 4
  if (raw.length !== expectedBytes) {
    throw new Error(`rgbaBuffer length mismatch: expected ${expectedBytes}, got ${raw.length}`)
  }

  const clipboard = await getClipboardInstance()
  if (!clipboard) throw new Error('Windows clipboard binding unavailable')
  clipboard.setImage(width, height, raw)
}

export async function getWindowsClipboardImagePng() {
  const size = getWindowsClipboardImageSize()
  if (!size) return null

  const raw = await getWindowsClipboardImageRaw()
  if (!raw) return null

  const expectedBytes = size.width * size.height * 4
  if (raw.length !== expectedBytes) {
    return null
  }

  const png = new PNG({ width: size.width, height: size.height })
  raw.copy(png.data)
  const data = PNG.sync.write(png)

  return {
    data,
    type: 'png',
    size: data.length,
    width: size.width,
    height: size.height
  }
}
