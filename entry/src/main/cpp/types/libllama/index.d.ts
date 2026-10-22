export interface NativeGenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
}

export const llamaInit: (configJson: string) => boolean
export const llamaGenerate: (paramsJson: string, callback: (token: string) => void) => NativeGenerateResult
export const llamaStop: () => void
export const llamaFree: () => void
export const llamaEmbedInit: (configJson: string) => boolean
export const llamaEmbedBatch: (texts: string[]) => number[][]
export const llamaEmbedFree: () => void
export const llamaScanCorpus: (query: number[], corpus: Float32Array, dimension: number, count: number) => Float32Array
export const llamaBuildInfo: () => string
