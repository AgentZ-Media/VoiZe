export interface Recording {
  /// 16 kHz mono 16-bit little-endian PCM, base64 (no WAV header)
  pcmB64: string;
  durationMs: number;
}

/// WKWebView's MediaRecorder produces AAC-in-MP4 ("audio/mp4"); opus/webm is
/// preferred where available. decodeAudioData below handles either container.
function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "";
}

/// Decode a recorded blob (webm/opus or mp4/aac) and resample it to what the
/// local Parakeet model expects: 16 kHz mono 16-bit PCM, base64 without a WAV
/// header. Decoding at the native rate first and rendering through an
/// OfflineAudioContext is the resample path that works reliably in WebKit.
async function blobToPcm16kBase64(blob: Blob): Promise<string> {
  if (blob.size === 0) return "";
  const RATE = 16000;
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void probe.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  // String.fromCharCode in bounded chunks — one call over minutes of audio
  // would blow the argument limit
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private analyser: AnalyserNode | null = null;
  private sink: GainNode | null = null;
  private parts: Blob[] = [];
  private mime = "";
  private levelFrame = 0;
  private smoothedLevel = 0;
  /// slowly decaying peak for adaptive normalization: raw capture (no AGC) is
  /// quiet and mic levels vary wildly — normalizing against the recent peak
  /// makes the waveform deflect fully from the first word
  private peak = 0;
  private timeBuf = new Float32Array(0);
  private startedAt = 0;

  get running() {
    return this.recorder?.state === "recording";
  }

  async start(
    onLevel: (value: number) => void,
    onFailure?: (error: Error) => void,
  ): Promise<void> {
    if (this.recorder) return;
    this.parts = [];
    this.peak = 0;
    this.smoothedLevel = 0;
    this.startedAt = 0;

    // Echo cancellation / noise suppression / AGC stay off: WKWebView's audio
    // processing chain ramps up for ~0.6-1 s after the track opens and delivers
    // pure silence first — push-to-talk would swallow the first word. The raw
    // signal transcribes fine.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.stream = stream;

    try {
      // Capture with MediaRecorder, not a live AudioWorklet. MediaRecorder
      // buffers the *complete* take from the first frame; the worklet approach
      // dropped the opening while its module compiled (addModule is async) and
      // the trailing blocks in flight at stop — that is what made words go
      // missing at the start and end. Decode + resample happens after stop.
      this.mime = pickMime();
      const recorder = this.mime
        ? new MediaRecorder(stream, { mimeType: this.mime })
        : new MediaRecorder(stream);
      this.recorder = recorder;
      if (!this.mime) this.mime = recorder.mimeType || "audio/mp4";
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.parts.push(event.data);
      };

      // MediaRecorder.start() only schedules the start. Its `start` event is the
      // browser's confirmation that media is actually being gathered. Do not let
      // the HUD or ready sound run ahead of this promise: getUserMedia may take a
      // different amount of time every time the microphone is opened.
      await new Promise<void>((resolve, reject) => {
        const onStart = () => {
          recorder.removeEventListener("error", onError);
          resolve();
        };
        const onError = (event: Event) => {
          recorder.removeEventListener("start", onStart);
          const error = (event as Event & { error?: DOMException }).error;
          reject(error ?? new Error("Audioaufnahme konnte nicht gestartet werden."));
        };
        recorder.addEventListener("start", onStart, { once: true });
        recorder.addEventListener("error", onError, { once: true });
        recorder.start();
      });
      this.startedAt = performance.now();
      recorder.onerror = (event) => {
        const error = (event as Event & { error?: DOMException }).error;
        onFailure?.(error ?? new Error("Die Audioaufnahme wurde unterbrochen."));
      };
      // The meter is cosmetic and must never delay the ready signal. Recording
      // is already active; initialize the Web Audio graph independently.
      void this.startLevelMeter(stream, onLevel);
    } catch (error) {
      const recorder = this.recorder;
      const ctx = this.ctx;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      this.analyser?.disconnect();
      this.sink?.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      this.recorder = null;
      this.analyser = null;
      this.sink = null;
      this.stream = null;
      this.ctx = null;
      this.startedAt = 0;
      this.parts = [];
      await ctx?.close().catch(() => {});
      throw error;
    }
  }

  private async startLevelMeter(
    stream: MediaStream,
    onLevel: (value: number) => void,
  ): Promise<void> {
    // Separate live-level path: source -> analyser -> silent sink -> destination.
    // The sink (gain 0) keeps the graph pulled so WebKit actually advances the
    // analyser. This path drives only the waveform and may fail independently;
    // the recording itself comes from MediaRecorder above.
    const ctx = new AudioContext();
    if (this.stream !== stream || this.recorder?.state !== "recording") {
      await ctx.close().catch(() => {});
      return;
    }
    this.ctx = ctx;
    try {
      await ctx.resume();
      if (
        this.ctx !== ctx ||
        this.stream !== stream ||
        this.recorder?.state !== "recording"
      ) {
        await ctx.close().catch(() => {});
        return;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyser.connect(sink);
      sink.connect(ctx.destination);
      this.timeBuf = new Float32Array(analyser.fftSize);
      this.analyser = analyser;
      this.sink = sink;

      const updateLevel = () => {
        if (this.ctx !== ctx || this.analyser !== analyser) return;
        analyser.getFloatTimeDomainData(this.timeBuf);
        let sum = 0;
        for (let i = 0; i < this.timeBuf.length; i += 1) {
          sum += this.timeBuf[i] * this.timeBuf[i];
        }
        const rms = Math.sqrt(sum / this.timeBuf.length);
        this.peak = Math.max(rms, this.peak * 0.996, 0.01);
        const norm = Math.min(1, rms / this.peak);
        const target = Math.pow(norm, 0.6);
        const blend = target > this.smoothedLevel ? 0.55 : 0.25;
        this.smoothedLevel = this.smoothedLevel * (1 - blend) + target * blend;
        onLevel(this.smoothedLevel);
        this.levelFrame = window.requestAnimationFrame(updateLevel);
      };
      this.levelFrame = window.requestAnimationFrame(updateLevel);
    } catch {
      if (this.ctx === ctx) this.ctx = null;
      await ctx.close().catch(() => {});
    }
  }

  /// Stop the recorder and resolve with the finished blob — onstop flushes
  /// every buffered chunk, so nothing is lost at the tail.
  private finishRecorder(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const r = this.recorder;
      this.recorder = null;
      if (r) r.onerror = null;
      const collect = () =>
        this.parts.length ? new Blob(this.parts, { type: this.mime }) : null;
      if (!r || r.state === "inactive") {
        resolve(collect());
        return;
      }
      r.onstop = () => resolve(collect());
      r.stop();
    });
  }

  async stop(): Promise<Recording> {
    const ctx = this.ctx;
    if (!this.recorder || !this.startedAt) {
      throw new Error("Recorder is not running.");
    }
    const durationMs = Math.max(0, performance.now() - this.startedAt);
    if (this.levelFrame) window.cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;

    const blob = await this.finishRecorder();

    this.analyser?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.analyser = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    await ctx?.close().catch(() => {});
    this.parts = [];

    const pcmB64 = blob ? await blobToPcm16kBase64(blob) : "";
    return { pcmB64, durationMs };
  }
}
