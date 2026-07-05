import { encodeWav } from "./wav";

export interface Recording {
  blob: Blob;
  durationMs: number;
  sampleRate: number;
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;

  get running() {
    return this.ctx !== null;
  }

  async start(onLevel: (value: number) => void): Promise<void> {
    if (this.ctx) return;
    this.chunks = [];
    this.startedAt = performance.now();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(data.length);
      copy.set(data);
      this.chunks.push(copy);
      let sum = 0;
      for (let i = 0; i < copy.length; i += 1) sum += copy[i] * copy[i];
      onLevel(Math.min(1, Math.sqrt(sum / copy.length) * 8));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.processor = processor;
    this.sink = sink;
  }

  async stop(): Promise<Recording> {
    const ctx = this.ctx;
    if (!ctx) {
      throw new Error("Recorder is not running.");
    }
    const durationMs = Math.max(0, performance.now() - this.startedAt);
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    await ctx.close().catch(() => {});
    const blob = encodeWav(this.chunks, ctx.sampleRate);
    const sampleRate = ctx.sampleRate;
    this.chunks = [];
    return { blob, durationMs, sampleRate };
  }
}
