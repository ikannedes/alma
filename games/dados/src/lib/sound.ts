/**
 * Tiny WebAudio kit — every effect is synthesised, so the bundle ships no audio
 * assets. All playback is soft-failing: if the platform blocks audio (or the
 * player muted it) the game simply stays silent.
 */

let ctx: AudioContext | null = null
let muted = false

export function setMuted(value: boolean): void {
  muted = value
}

export function isMuted(): boolean {
  return muted
}

type AudioContextCtor = typeof AudioContext

function getCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const scoped = window as unknown as { webkitAudioContext?: AudioContextCtor }
  return window.AudioContext ?? scoped.webkitAudioContext ?? null
}

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = getCtor()
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    ctx = null
  }
  return ctx
}

/** Call from a user-gesture handler so the browser unlocks playback. */
export function unlockAudio(): void {
  const audio = getCtx()
  if (audio && audio.state === 'suspended') void audio.resume()
}

function active(): AudioContext | null {
  if (muted) return null
  const audio = getCtx()
  return audio && audio.state === 'running' ? audio : null
}

/** White noise with an exponential decay envelope — the reusable building block. */
function noiseBurst(audio: AudioContext, duration: number, decay: number): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor(audio.sampleRate * duration))
  const buffer = audio.createBuffer(1, length, audio.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-decay * (i / length))
  }
  const source = audio.createBufferSource()
  source.buffer = buffer
  return source
}

function tone(
  audio: AudioContext,
  options: {
    type: OscillatorType
    from: number
    to?: number
    duration: number
    gain: number
    delay?: number
  },
): void {
  const { type, from, to = from, duration, gain, delay = 0 } = options
  const start = audio.currentTime + delay
  const osc = audio.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(from, start)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration)
  const envelope = audio.createGain()
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.02, duration * 0.2))
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(envelope)
  envelope.connect(audio.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/** Dice rattling in a cup. */
export function playRollSound(): void {
  const audio = active()
  if (!audio) return
  const source = noiseBurst(audio, 0.6, 3.2)
  const filter = audio.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 1800
  filter.Q.value = 0.7
  const gain = audio.createGain()
  gain.gain.value = 0.2
  source.connect(filter)
  filter.connect(gain)
  gain.connect(audio.destination)
  source.start()
}

/** A die clicking onto the felt. */
export function playSettleSound(): void {
  const audio = active()
  if (!audio) return
  const source = noiseBurst(audio, 0.09, 14)
  const filter = audio.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 2200
  const gain = audio.createGain()
  gain.gain.value = 0.3
  source.connect(filter)
  filter.connect(gain)
  gain.connect(audio.destination)
  source.start()
  tone(audio, { type: 'triangle', from: 320, to: 110, duration: 0.14, gain: 0.16 })
}

/** A neutral tap for committing a bid. */
export function playCallSound(quantity: number): void {
  const audio = active()
  if (!audio) return
  const base = 300 + Math.min(quantity, 10) * 22
  tone(audio, { type: 'square', from: base, to: base * 1.2, duration: 0.09, gain: 0.06 })
}

/** A rising chime when the table is opened. */
export function playRevealSound(): void {
  const audio = active()
  if (!audio) return
  const source = noiseBurst(audio, 0.35, 6)
  const filter = audio.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 900
  const gain = audio.createGain()
  gain.gain.value = 0.14
  source.connect(filter)
  filter.connect(gain)
  gain.connect(audio.destination)
  source.start()
  tone(audio, { type: 'sine', from: 520, to: 880, duration: 0.28, gain: 0.1 })
}

const WIN_NOTES = [523.25, 659.25, 783.99]
const LOSE_NOTES = [392, 311.13, 261.63]

function playArpeggio(notes: number[]): void {
  const audio = active()
  if (!audio) return
  notes.forEach((frequency, index) => {
    tone(audio, {
      type: 'sine',
      from: frequency,
      duration: 0.24,
      gain: 0.14,
      delay: index * 0.09,
    })
  })
}

export function playWinSound(): void {
  playArpeggio(WIN_NOTES)
}

export function playLoseSound(): void {
  playArpeggio(LOSE_NOTES)
}

/** Quiet tick used for neutral UI affordances. */
export function playTickSound(): void {
  const audio = active()
  if (!audio) return
  tone(audio, { type: 'sine', from: 660, duration: 0.05, gain: 0.04 })
}
