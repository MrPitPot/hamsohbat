// Noise cancellation for the microphone, like Discord's Krisp option.
// "ai" uses GTCRN, a small neural speech-enhancement model; "rnnoise" uses Xiph's RNNoise. Both run locally in
// an AudioWorklet (WebAssembly), so no audio ever leaves the computer for this. "standard" is the browser's
// built-in suppressor and "off" sends the raw microphone.
import { loadGtcrn, loadRnnoise, GtcrnWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export type NoiseMode = 'ai' | 'rnnoise' | 'standard' | 'off';
export const NOISE_MODES: [NoiseMode, string, string][] = [
  ['ai', 'AI Noise Cancellation', 'A neural network removes keyboards, fans, traffic and other background noise. Best quality, a little more CPU.'],
  ['rnnoise', 'RNNoise', 'A lighter neural noise suppressor. Good for older computers.'],
  ['standard', 'Standard', "The browser's built-in noise suppression."],
  ['off', 'None', 'Send your microphone exactly as it is.'],
];

let ctx: AudioContext | null = null;
const binaries: Record<string, Promise<ArrayBuffer>> = {};
const modules: Record<string, Promise<void>> = {};

function context() {
  // Both models are built for 48 kHz.
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

async function makeNode(ac: AudioContext, mode: 'ai' | 'rnnoise'): Promise<AudioWorkletNode & { destroy?: () => void }> {
  if (mode === 'ai') {
    binaries.ai ||= loadGtcrn({ url: gtcrnWasm });
    modules.ai ||= ac.audioWorklet.addModule(gtcrnWorklet);
    const [wasmBinary] = await Promise.all([binaries.ai, modules.ai]);
    return new GtcrnWorkletNode(ac, { maxChannels: 1, wasmBinary });
  }
  binaries.rnnoise ||= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
  modules.rnnoise ||= ac.audioWorklet.addModule(rnnoiseWorklet);
  const [wasmBinary] = await Promise.all([binaries.rnnoise, modules.rnnoise]);
  return new RnnoiseWorkletNode(ac, { maxChannels: 1, wasmBinary });
}

export interface ProcessedMic {
  stream: MediaStream;
  /** Stops the processing and the raw microphone. */
  stop: () => void;
  mode: NoiseMode;
}

/** Runs a microphone stream through the chosen noise canceller. Falls back to the raw stream on any error. */
export async function processMic(raw: MediaStream, mode: NoiseMode): Promise<ProcessedMic> {
  const passthrough: ProcessedMic = { stream: raw, stop: () => raw.getTracks().forEach((t) => t.stop()), mode: mode === 'standard' ? 'standard' : 'off' };
  if ((mode !== 'ai' && mode !== 'rnnoise') || !raw.getAudioTracks().length || typeof AudioWorkletNode === 'undefined') return passthrough;
  // Modules were added to a context that has since been closed: start over.
  if (ctx?.state === 'closed') for (const k of Object.keys(modules)) delete modules[k];
  try {
    const ac = context();
    const node = await makeNode(ac, mode);
    const src = ac.createMediaStreamSource(raw);
    // Mono in: a stereo microphone is mixed down first.
    const mix = ac.createGain();
    mix.channelCount = 1;
    mix.channelCountMode = 'explicit';
    mix.channelInterpretation = 'speakers';
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 1;
    src.connect(mix).connect(node).connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    // Keep the original device label so the UI can still show it.
    return {
      stream: dest.stream,
      mode,
      stop: () => {
        try {
          src.disconnect();
          mix.disconnect();
          node.disconnect();
          node.destroy?.();
        } catch {}
        track.stop();
        raw.getTracks().forEach((t) => t.stop());
      },
    };
  } catch (e) {
    console.warn('noise cancellation unavailable', e);
    return passthrough;
  }
}

/** getUserMedia constraints that go with a noise mode (the browser filter is off when a model does the work). */
export const browserSuppression = (mode: NoiseMode) => mode === 'standard';

// For tests and debugging.
(window as any).__noise = { processMic };
