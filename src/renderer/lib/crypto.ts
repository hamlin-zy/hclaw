/**
 * Encrypted value marker prefix.
 * All values stored encrypted by Electron's safeStorage are prefixed with this marker.
 */
const ENC_PREFIX = 'enc:'

/**
 * Encrypt a plain text value using Electron's safeStorage API.
 * Returns the encrypted value prefixed with 'enc:' marker.
 */
export async function encryptSecret(value: string): Promise<string> {
    if (!value) return value
    const encrypted = await window.electronAPI?.secretEncrypt?.(value)
    return encrypted ? `${ENC_PREFIX}${encrypted}` : value
}

/**
 * Decrypt an encrypted value.
 * If the value is not encrypted (no 'enc:' prefix), returns it as-is.
 */
export async function decryptSecret(value: string): Promise<string> {
    if (!value) return value
    if (value.startsWith(ENC_PREFIX)) {
        return await window.electronAPI?.secretDecrypt?.(value.slice(ENC_PREFIX.length)) || ''
    }
    return value
}

/**
 * Check if a value is encrypted (has 'enc:' prefix).
 */
export function isEncrypted(value: string): boolean {
    return value?.startsWith(ENC_PREFIX) ?? false
}
