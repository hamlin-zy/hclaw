import {safeStorage} from 'electron'

/**
 * Encrypt a plain text value using Electron's safeStorage API.
 */
export async function encryptSecret(plainText: string): Promise<string> {
    if (!plainText) return plainText
    try {
        if (safeStorage.isEncryptionAvailable()) {
            const buffer = safeStorage.encryptString(plainText)
            return buffer.toString('base64')
        }
    } catch (err) {
        console.error('[crypto] encrypt failed:', err)
    }
    return plainText
}

/**
 * Decrypt an encrypted value using Electron's safeStorage API.
 */
export async function decryptSecret(cipherText: string): Promise<string> {
    if (!cipherText) return cipherText
    try {
        if (safeStorage.isEncryptionAvailable()) {
            const buffer = Buffer.from(cipherText, 'base64')
            return safeStorage.decryptString(buffer)
        }
    } catch (err) {
        console.error('[crypto] decrypt failed:', err)
    }
    return cipherText
}
