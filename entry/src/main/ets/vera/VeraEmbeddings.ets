/**
 * ArkTS interface to the embedding half of the llama.cpp NAPI module
 * (napi_llama.cpp's llamaEmbedInit/llamaEmbedBatch/llamaEmbedFree) -- a
 * second, independent model+context from LlamaEngine.ets's generation one,
 * loaded once and kept alive for the process lifetime, the same "load once,
 * keep alive" shape VeraIntentRegistry.loadRegistry() and VeraSdkIndex
 * .loadSdkIndex() already use.
 *
 * Model: EmbeddingGemma-300M, Q4_K_M GGUF (~236MB), downloaded once straight
 * from Hugging Face to {filesDir}/models/ (GeneratePage.ets) -- no
 * vera-server dependency, unlike the generation model
 * (LlamaEngine.defaultModelPath), because this one is small and public
 * enough to fetch directly over the INTERNET permission the app already has.
 *
 * Supersedes an earlier attempt at @ohos.data.intelligence
 * (getTextEmbeddingModel): that API exists on real devices (canIUse is true)
 * but its model asset, arkdata_text_embedding_chs, was not in the test
 * device's ROM (dcas_service's own model manifest lists only
 * msdp_autofill_bert) -- a firmware gap no app code can fix. llama.cpp was
 * already vendored for LlamaEngine.ets, and ggml has native gemma-embedding
 * architecture support, so EmbeddingGemma over that path sidesteps the gap
 * entirely rather than waiting on it.
 *
 * null from embedBatch/embedOne means "not loaded yet, or the native call
 * failed" -- every caller treats that as "fall back to token-only", never as
 * an error to surface. Vectors that come back are already L2-normalized (the
 * native side does it once, in float, right after pooling), so a cache can
 * score candidates by a plain dot product.
 */

import { fileIo as fs } from '@kit.CoreFileKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { nativeEmbedInit, nativeEmbedBatch, nativeBuildInfo } from './LlamaEngine'

const DOMAIN = 0x0000
/** Exported so VeraSdkEmbeddingCache.ets can bind its bundled cache to this
 * exact model, not just the corpus -- one string, not two copies to drift. */
export const MODEL_FILE = 'embeddinggemma-300m-q4_k_m.gguf'

/** Where GeneratePage.ets's downloader fetches the model from -- small and
 * public, unlike the generation model, so no vera-server hop is needed. */
export const EMBED_MODEL_URL =
  'https://huggingface.co/second-state/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300m-Q4_K_M.gguf'

export function embedModelPath(filesDir: string): string {
  return filesDir + '/models/' + MODEL_FILE
}

export function embedModelExists(filesDir: string): boolean {
  try {
    let stat = fs.statSync(embedModelPath(filesDir))
    return stat.size > 0
  } catch (_e) {
    return false
  }
}

let loaded = false
let loading: Promise<boolean> | null = null

async function doLoad(filesDir: string): Promise<boolean> {
  if (!embedModelExists(filesDir)) {
    hilog.warn(DOMAIN, 'VERA', 'VERA-EMBED model file missing, not loaded')
    return false
  }
  let config: Record<string, Object> = {}
  config['model_path'] = embedModelPath(filesDir)
  // 512 covers this app's corpora comfortably: SDK descriptions and
  // find_*_function "need" queries are both short, well inside
  // EmbeddingGemma's own 512-character-per-inference limit.
  config['n_ctx'] = 512
  config['n_threads'] = 4
  let startedAt = Date.now()
  try {
    let ok = nativeEmbedInit(JSON.stringify(config))
    loaded = ok
    hilog.info(DOMAIN, 'VERA', 'VERA-EMBED native model load ok=' + ok.toString() +
      ' in ' + (Date.now() - startedAt).toString() + 'ms')
    return ok
  } catch (e) {
    hilog.warn(DOMAIN, 'VERA', 'VERA-EMBED native model load threw: ' + (e as Error).message)
    return false
  }
}

/**
 * A line for a screen's status when this build cannot load a model at all,
 * '' otherwise. A build made from a checkout without llama.cpp is a stub: it
 * compiles, runs, and quietly answers every model load with false, so SDK and
 * intent search fall back to keywords and local generation is unavailable.
 * Saying so is the only way anyone notices.
 */
export function modelSupportNote(): string {
  if (nativeBuildInfo() !== 'stub') { return '' }
  hilog.warn(DOMAIN, 'VERA', 'VERA-EMBED this build has no llama.cpp: model support is off')
  return 'This build has no llama.cpp: device search uses keywords only (see entry/src/main/cpp/CMakeLists.txt).'
}

/** Starts the one-time native load; safe to call more than once -- later calls reuse the first attempt. */
export function loadEmbeddingModel(filesDir: string): Promise<boolean> {
  if (loading === null) { loading = doLoad(filesDir) }
  return loading!
}

export function embeddingModelReady(): boolean { return loaded }

/**
 * A real yield to the event loop -- confirmed the hard way this session
 * that `setTimeout(fn, 0)` is NOT one here. First attempt used a 0ms delay;
 * HarmonyOS's watchdog still logged THREAD_BLOCK_3S/6S and killed the
 * process (appfreeze-...-20261001175908...log), and the freeze dump's own
 * main-handler history shows why: a single "uvLoopTask" dispatch ran
 * continuously for ~8 seconds, several chunks deep, with no completed
 * event in between. A due-immediately timer is apparently drained inline
 * as part of the same dispatch rather than requiring the thread to actually
 * return to the native poll/wait phase -- which is the one place pending
 * input, rendering and the watchdog's own heartbeat message actually get
 * serviced. A real (nonzero) delay forces a genuine wait there.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve: () => void) => { setTimeout(resolve, 50) })
}

/**
 * One L2-normalized vector per input text, in the same order, or null if the
 * model isn't loaded or the native call itself failed outright (as opposed
 * to one text within the batch failing -- that comes back as an empty
 * sub-array, not a null batch; see napi_llama.cpp's LlamaEmbedBatch). Always
 * yields to the event loop afterward (see yieldToEventLoop) -- callers that
 * loop over many chunks (the two corpus caches) get a breathing room point
 * for free, and a single live query during generation pays one harmless
 * extra tick for it.
 */
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) { return [] }
  if (!loaded) { return null }
  try {
    let startedAt = Date.now()
    let vecs = nativeEmbedBatch(texts)
    hilog.info(DOMAIN, 'VERA', 'VERA-EMBED batch(' + texts.length.toString() + ') ' +
      (Date.now() - startedAt).toString() + 'ms')
    await yieldToEventLoop()
    return vecs
  } catch (e) {
    hilog.warn(DOMAIN, 'VERA', 'VERA-EMBED batch failed: ' + (e as Error).message)
    return null
  }
}

export async function embedOne(text: string): Promise<number[] | null> {
  let vecs = await embedBatch([text])
  if (vecs === null || vecs.length === 0 || vecs[0].length === 0) { return null }
  return vecs[0]
}
