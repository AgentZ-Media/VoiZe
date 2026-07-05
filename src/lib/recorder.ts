export interface Recording {
  /// 16 kHz mono 16-bit little-endian PCM, base64 (no WAV header)
  pcmB64: string;
  durationMs: number;
}

// Runs inside the AudioWorklet realm; posts each 128-frame block to the
// main thread. Kept as source text so it can be loaded from a Blob URL
// without a separate bundler entry.
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("voize-capture", CaptureProcessor);
`;

let workletUrl: string | null = null;

function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
  }
  return workletUrl;
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

/// Resample captured Float32 audio to 16 kHz mono and encode as base64
/// 16-bit PCM. OfflineAudioContext does the band-limited resampling.
async function toPcm16kBase64(
  chunks: Float32Array[],
  sourceRate: number,
): Promise<string> {
  const RATE = 16000;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total === 0) return "";
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  let mono = merged;
  if (sourceRate !== RATE) {
    const frames = Math.max(1, Math.ceil((total / sourceRate) * RATE));
    const off = new OfflineAudioContext(1, frames, RATE);
    const buffer = off.createBuffer(1, total, sourceRate);
    buffer.copyToChannel(merged, 0);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    mono = (await off.startRendering()).getChannelData(0);
  }
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private levelFrame = 0;
  private smoothedLevel = 0;
  /// latest RMS straight from the capture path — the level meter reads
  /// this instead of an AnalyserNode (WebKit doesn't reliably pull
  /// analysers that aren't on a path to the destination)
  private currentRms = 0;
  /// slowly decaying peak for adaptive normalization: raw capture (no
  /// AGC) is quiet and mic levels vary wildly — normalizing against the
  /// recent peak makes the waveform deflect fully from the first word
  private peak = 0;
  private chunks: Float32Array[] = [];
  private startedAt = 0;

  get running() {
    return this.ctx !== null;
  }

  async start(onLevel: (value: number) => void): Promise<void> {
    if (this.ctx) return;
    this.chunks = [];
    this.currentRms = 0;
    this.peak = 0;
    this.startedAt = performance.now();
    // Echo cancellation / noise suppression / AGC stay off: WKWebView's
    // audio processing chain ramps up for ~0.6-1 s after the track opens
    // and delivers pure silence first — push-to-talk would swallow the
    // first word. The raw signal transcribes fine.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    const capture = (block: Float32Array) => {
      this.chunks.push(block);
      this.currentRms = rms(block);
    };

    try {
      await ctx.audioWorklet.addModule(getWorkletUrl());
      const worklet = new AudioWorkletNode(ctx, "voize-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        capture(event.data);
      };
      source.connect(worklet);
      worklet.connect(sink);
      this.worklet = worklet;
    } catch {
      // deprecated but universally supported fallback
      const processor = ctx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(data.length);
        copy.set(data);
        capture(copy);
      };
      source.connect(processor);
      processor.connect(sink);
      this.processor = processor;
    }

    const updateLevel = () => {
      if (!this.ctx) return;
      this.peak = Math.max(this.currentRms, this.peak * 0.996, 0.01);
      const norm = Math.min(1, this.currentRms / this.peak);
      // perceptual curve: quiet speech still moves the bars visibly
      const target = Math.pow(norm, 0.6);
      // fast attack, slower release — speech onsets hit immediately
      const blend = target > this.smoothedLevel ? 0.55 : 0.25;
      this.smoothedLevel = this.smoothedLevel * (1 - blend) + target * blend;
      onLevel(this.smoothedLevel);
      this.levelFrame = window.requestAnimationFrame(updateLevel);
    };
    sink.connect(ctx.destination);
    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.sink = sink;
    this.smoothedLevel = 0;
    this.levelFrame = window.requestAnimationFrame(updateLevel);
  }

  async stop(): Promise<Recording> {
    const ctx = this.ctx;
    if (!ctx) {
      throw new Error("Recorder is not running.");
    }
    const durationMs = Math.max(0, performance.now() - this.startedAt);
    if (this.levelFrame) window.cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const sampleRate = ctx.sampleRate;
    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    await ctx.close().catch(() => {});
    const chunks = this.chunks;
    this.chunks = [];
    const pcmB64 = await toPcm16kBase64(chunks, sampleRate);
    return { pcmB64, durationMs };
  }
}
