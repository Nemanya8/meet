/**
 * Room Encryption: End-to-end encryption for Statement Store data
 *
 * Provides AES-GCM encryption for sensitive signaling data
 * (SDPs, ICE candidates, presence info) stored in the Statement Store.
 *
 * Key sharing is done via URL fragment (#), which is never sent to servers.
 */

/**
 * Generate a new room encryption key.
 * Returns a URL-safe base64 string that can be shared via URL fragment.
 */
export async function generateRoomKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt'
  ])
  const exported = await crypto.subtle.exportKey('raw', key)
  return arrayBufferToBase64Url(exported)
}

/**
 * Import a room key from a URL-safe base64 string.
 */
export async function importRoomKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64UrlToArrayBuffer(base64Key)
  return crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ])
}

/**
 * Encrypt channel data before writing to Statement Store.
 * Returns a base64-encoded string containing IV + ciphertext.
 */
export async function encryptChannelData(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return arrayBufferToBase64Url(combined.buffer)
}

/**
 * Decrypt channel data received from Statement Store.
 */
export async function decryptChannelData(key: CryptoKey, encrypted: string): Promise<string> {
  const combined = new Uint8Array(base64UrlToArrayBuffer(encrypted))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

/**
 * Check if a string looks like encrypted data.
 */
export function isEncryptedData(data: string): boolean {
  if (data.length < 20) return false
  const firstChar = data.charAt(0)
  if (firstChar === '{' || firstChar === '[') return false
  try {
    const decoded = base64UrlToArrayBuffer(data)
    return decoded.byteLength >= 13
  } catch {
    return false
  }
}

/**
 * Validate that a string is a valid room key format.
 */
export function isValidRoomKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false
  try {
    const decoded = base64UrlToArrayBuffer(key)
    return decoded.byteLength === 32
  } catch {
    return false
  }
}

/**
 * Extract room key from URL hash/fragment.
 */
export function extractRoomKeyFromUrl(url?: string): string | null {
  const hash = url
    ? new URL(url).hash
    : typeof window !== 'undefined'
      ? window.location.hash
      : ''
  if (!hash || hash.length < 2) return null
  const key = hash.slice(1)
  return isValidRoomKey(key) ? key : null
}

/**
 * Create a shareable URL with the room key in the fragment.
 */
export function createShareableUrl(baseUrl: string, roomKey: string): string {
  const url = new URL(baseUrl)
  url.hash = roomKey
  return url.toString()
}

// ============================================================================
// Base64 URL-safe encoding helpers
// ============================================================================

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
