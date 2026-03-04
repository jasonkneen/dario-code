import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  getWindowsClipboardImagePng,
  getWindowsClipboardImageRaw,
  getWindowsClipboardImageSize,
  getWindowsClipboardText,
  setWindowsClipboardImageRaw,
  setWindowsClipboardText
} from '../src/mentions/windows-clipboard.mjs'
import { getImageFromClipboard } from '../src/mentions/index.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function buffersEqual(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sizesEqual(a, b) {
  return Boolean(a && b && a.width === b.width && a.height === b.height)
}

async function waitForClipboardRawImage(expectedRaw = null, timeoutMs = 1500) {
  const initialRaw = await getWindowsClipboardImageRaw()
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const raw = await getWindowsClipboardImageRaw()
    if (!raw) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      continue
    }
    if (expectedRaw) {
      if (buffersEqual(raw, expectedRaw)) {
        if (!initialRaw || !buffersEqual(initialRaw, expectedRaw) || Date.now() - started > 200) {
          return raw
        }
      }
    } else if (!initialRaw || !buffersEqual(raw, initialRaw)) {
      return raw
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function waitForClipboardImageSize(expectedSize = null, timeoutMs = 1500) {
  const initialSize = getWindowsClipboardImageSize()
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const size = getWindowsClipboardImageSize()
    if (!size) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      continue
    }
    if (expectedSize) {
      if (size.width === expectedSize.width && size.height === expectedSize.height) {
        if (!initialSize || !sizesEqual(initialSize, expectedSize) || Date.now() - started > 200) {
          return size
        }
      }
    } else if (!initialSize || !sizesEqual(size, initialSize)) {
      return size
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

describe.skipIf(process.platform !== 'win32')('Windows clipboard integration', () => {
  let originalText = ''

  beforeAll(async () => {
    originalText = (await getWindowsClipboardText()) ?? ''
  })

  afterAll(async () => {
    await setWindowsClipboardText(originalText)
  })

  it('round-trips clipboard text using @napi-rs/clipboard', async () => {
    const marker = `dario-win-clipboard-${Date.now()}`
    await setWindowsClipboardText(marker)
    const clipboardText = await getWindowsClipboardText()
    expect(clipboardText).toBe(marker)
  })

  it('round-trips raw RGBA clipboard image bytes', async () => {
    const width = 2
    const height = 2
    const rgba = Buffer.from([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255
    ])

    await setWindowsClipboardImageRaw(width, height, rgba)

    const size = await waitForClipboardImageSize({ width, height })
    expect(size).toEqual({ width, height })

    const raw = await waitForClipboardRawImage(rgba)
    expect(raw).not.toBeNull()
    expect(raw.equals(rgba)).toBe(true)
  })

  it('exports Windows clipboard image as PNG for mentions', async () => {
    const width = 3
    const height = 1
    const rgba = Buffer.from([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255
    ])

    await setWindowsClipboardImageRaw(width, height, rgba)
    await waitForClipboardImageSize({ width, height })
    await waitForClipboardRawImage(rgba)

    const png = await getWindowsClipboardImagePng()
    expect(png).not.toBeNull()
    expect(png.type).toBe('png')
    expect(png.width).toBe(width)
    expect(png.height).toBe(height)
    expect(png.data.length).toBeGreaterThan(8)
    expect(png.data.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })

  it('integrates with mentions.getImageFromClipboard on Windows', async () => {
    const width = 1
    const height = 1
    const rgba = Buffer.from([12, 34, 56, 255])
    await setWindowsClipboardImageRaw(width, height, rgba)
    await waitForClipboardImageSize({ width, height })
    await waitForClipboardRawImage(rgba)

    const image = await getImageFromClipboard()
    expect(image).not.toBeNull()
    expect(image.type).toBe('png')
    expect(image.size).toBeGreaterThan(8)
    expect(image.data.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })
})
