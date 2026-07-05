function tone(frequency: number, duration: number, gain: number) {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return;
  const ctx = new AudioCtor();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.frequency.value = frequency;
  osc.type = "sine";
  amp.gain.setValueAtTime(0, ctx.currentTime);
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.02);
  setTimeout(() => void ctx.close(), (duration + 0.08) * 1000);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function playStartSound() {
  tone(660, 0.13, 0.045);
}

export function playFinishSound() {
  tone(920, 0.1, 0.04);
  setTimeout(() => tone(1240, 0.12, 0.035), 72);
}
