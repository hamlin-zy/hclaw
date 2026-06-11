declare module 'silk-wasm' {
    export function decode(data: Buffer, sampleRate?: number): Promise<{
        data: Uint8Array
    }>
}

