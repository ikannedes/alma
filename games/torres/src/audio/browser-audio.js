import { createGameAudioRuntimeSinkCapability } from "./game-audio-runtime.js";

const contextFactoryCapabilities = new WeakMap();
const consumedContextFactoryCapabilities = new WeakSet();
const authenticBrowserAudioSinks = new WeakSet();

function frozen(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function checkedContext(value) {
  if (value === null || typeof value !== "object" ||
      typeof value.createBuffer !== "function" ||
      typeof value.createBufferSource !== "function" ||
      typeof value.createGain !== "function" ||
      typeof value.resume !== "function" ||
      value.destination === null || typeof value.destination !== "object" ||
      typeof value.currentTime !== "number" || !Number.isFinite(value.currentTime)) {
    throw new TypeError("browser audio context factory returned an invalid context");
  }
  return value;
}

function primitiveSamples(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2 !== 0) {
    throw new TypeError("browser audio PCM bytes are invalid");
  }
  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

function primitivePcmMetrics(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let peak = 0;
  let energy = 0;
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    const sample = view.getInt16(index * 2, true);
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    energy += sample * sample;
  }
  const sampleCount = bytes.byteLength / 2;
  const rms = sampleCount === 0 ? 0 : Math.sqrt(energy / sampleCount);
  return {
    energy,
    peak,
    rmsBasisPoints: Math.floor(rms * 10_000 / 32_767),
  };
}

function observePromise(result) {
  if (result !== null && (typeof result === "object" || typeof result === "function") &&
      typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
  }
}

function cleanupContext(context) {
  if (context === null || (typeof context !== "object" && typeof context !== "function")) {
    return;
  }
  for (const method of ["suspend", "close"]) {
    try {
      if (typeof context[method] === "function") {
        observePromise(context[method]());
      }
    } catch {}
  }
}

export function createBrowserAudioContextFactoryCapability(factory) {
  if (arguments.length !== 1 || typeof factory !== "function") {
    throw new TypeError("browser audio context factory must be one function");
  }
  const capability = Object.freeze(Object.create(null));
  contextFactoryCapabilities.set(capability, factory);
  return capability;
}

export function isAuthenticBrowserPcmAudioSink(value) {
  return authenticBrowserAudioSinks.has(value);
}

export class BrowserPcmAudioSink {
  #active = new Map();
  #context = null;
  #disposed = false;
  #factory;
  #fault = null;
  #gainBasisPoints = 10_000;
  #gainNode = null;
  #muted = false;
  #resumeCount = 0;
  #runtimeBound = false;
  #scheduledPcm = [];
  #startCount = 0;
  #transactionCount = 0;
  #unlockCount = 0;
  #unlockPromise = null;

  constructor(factoryCapability) {
    const factory = contextFactoryCapabilities.get(factoryCapability);
    if (factory === undefined) {
      if (consumedContextFactoryCapabilities.has(factoryCapability)) {
        throw new TypeError("browser audio context capability is consumed");
      }
      throw new TypeError("browser audio context capability is invalid");
    }
    contextFactoryCapabilities.delete(factoryCapability);
    consumedContextFactoryCapabilities.add(factoryCapability);
    this.#factory = factory;
    authenticBrowserAudioSinks.add(this);
    Object.freeze(this);
  }

  createRuntimeSinkCapability() {
    this.#assertUsable();
    if (this.#runtimeBound) throw new RangeError("browser audio sink is already bound");
    this.#runtimeBound = true;
    return createGameAudioRuntimeSinkCapability(
      (transaction, voices) => this.#apply(transaction, voices),
    );
  }

  unlock(event) {
    this.#assertUsable();
    if (event === null || typeof event !== "object" || event.isTrusted !== true) {
      return Promise.resolve(false);
    }
    if (this.#unlockPromise !== null) return this.#unlockPromise.then(() => false);
    let context;
    let gainNode;
    try {
      context = checkedContext(this.#factory());
      gainNode = context.createGain();
      if (gainNode === null || typeof gainNode !== "object" ||
          typeof gainNode.connect !== "function" ||
          typeof gainNode.disconnect !== "function" ||
          gainNode.gain === null || typeof gainNode.gain !== "object" ||
          typeof gainNode.gain.setValueAtTime !== "function") {
        throw new TypeError("browser audio context returned an invalid gain node");
      }
      gainNode.connect(context.destination);
      this.#context = context;
      this.#gainNode = gainNode;
      this.#setNodeGain();
      this.#unlockCount = 1;
      const result = context.resume();
      this.#resumeCount = 1;
      if (result === null || typeof result !== "object" ||
          typeof result.then !== "function") {
        throw new TypeError("browser audio context resume must return a promise");
      }
      this.#unlockPromise = Promise.resolve(result).then(() => true, (error) => {
        this.#fault = error ?? new Error("browser audio resume rejected");
        this.#disposeGraph();
        throw error;
      });
      return this.#unlockPromise;
    } catch (error) {
      this.#fault = error ?? new Error("browser audio unlock failed");
      const graphWasAdopted = this.#context === context;
      if (graphWasAdopted) this.#disposeGraph();
      else {
        try { gainNode?.disconnect(); } catch {}
        cleanupContext(context);
      }
      return Promise.reject(error);
    }
  }

  #apply(transaction, voices) {
    this.#assertUsable();
    this.#transactionCount += 1;
    const byVoiceId = new Map(voices.map((voice) => [voice.voiceId, voice]));
    let gainBasisPoints = this.#gainBasisPoints;
    let muted = this.#muted;
    try {
      for (const command of transaction.commands) {
        if (command.kind === "output") {
          gainBasisPoints = command.gainBasisPoints;
          muted = command.muted;
          this.#setNodeGain(gainBasisPoints, muted);
        } else if (command.kind === "stop") {
          this.#stop(command.voiceId);
        } else if (command.kind === "start" && this.#gainNode !== null) {
          this.#start(command, byVoiceId.get(command.voiceId), gainBasisPoints, muted);
        }
      }
      this.#gainBasisPoints = gainBasisPoints;
      this.#muted = muted;
    } catch (error) {
      this.#fault = error ?? new Error("browser audio transaction failed");
      this.#disposeGraph();
      throw error;
    }
  }

  #start(command, voice, outputGainBasisPoints = this.#gainBasisPoints,
    outputMuted = this.#muted) {
    if (voice === undefined || this.#active.has(command.voiceId)) {
      throw new TypeError("browser audio start voice is invalid or duplicate");
    }
    const context = this.#context;
    const samples = primitiveSamples(voice.bytes);
    const buffer = context.createBuffer(1, samples.length, voice.sampleRateHz ?? 48_000);
    if (buffer === null || typeof buffer !== "object") {
      throw new TypeError("browser audio context returned an invalid buffer");
    }
    if (typeof buffer.copyToChannel === "function") buffer.copyToChannel(samples, 0);
    else if (typeof buffer.getChannelData === "function") buffer.getChannelData(0).set(samples);
    else throw new TypeError("browser audio buffer cannot receive PCM data");
    const source = context.createBufferSource();
    if (source === null || typeof source !== "object" ||
        typeof source.connect !== "function" || typeof source.disconnect !== "function" ||
        typeof source.start !== "function" || typeof source.stop !== "function") {
      throw new TypeError("browser audio context returned an invalid source");
    }
    try {
      source.buffer = buffer;
      source.connect(this.#gainNode);
      source.onended = () => {
        if (this.#active.get(command.voiceId) !== source) return;
        this.#active.delete(command.voiceId);
        try { source.disconnect(); } catch {}
      };
      this.#active.set(command.voiceId, source);
      source.start(context.currentTime);
      const metrics = primitivePcmMetrics(voice.bytes);
      this.#scheduledPcm.push(Object.freeze({
        ...metrics,
        cueId: voice.cueId,
        effectiveGainBasisPoints: voice.effectiveGainBasisPoints,
        family: voice.family,
        mixGainBasisPoints: voice.mixGainBasisPoints ?? 10_000,
        outputGainBasisPoints,
        outputMuted,
        sampleCount: voice.sampleCount,
        sampleRateHz: voice.sampleRateHz,
        sequence: voice.sequence,
        sourceType: voice.sourceType,
        startTick: voice.startTick,
        voiceId: command.voiceId,
        waveformSha256: voice.waveformSha256,
      }));
      this.#startCount += 1;
    } catch (error) {
      this.#active.delete(command.voiceId);
      try { source.stop(context.currentTime); } catch {}
      try { source.disconnect(); } catch {}
      throw error;
    }
  }

  #stop(voiceId) {
    const source = this.#active.get(voiceId);
    if (source === undefined) return;
    this.#active.delete(voiceId);
    try { source.stop(this.#context.currentTime); } catch {}
    try { source.disconnect(); } catch {}
  }

  #setNodeGain(gainBasisPoints = this.#gainBasisPoints, muted = this.#muted) {
    if (this.#gainNode === null) return;
    const value = muted ? 0 : gainBasisPoints / 10_000;
    this.#gainNode.gain.setValueAtTime(value, this.#context.currentTime);
  }

  #disposeGraph() {
    for (const voiceId of [...this.#active.keys()].sort((left, right) => left - right)) {
      this.#stop(voiceId);
    }
    try { this.#gainNode?.disconnect(); } catch {}
    cleanupContext(this.#context);
    this.#gainNode = null;
    this.#context = null;
  }

  dispose() {
    if (this.#disposed) return false;
    this.#disposed = true;
    this.#disposeGraph();
    return true;
  }

  get state() {
    return frozen({
      activeVoiceCount: this.#active.size,
      audibleStartCount: this.#startCount,
      contextCreated: this.#context !== null,
      disposed: this.#disposed,
      faulted: this.#fault !== null,
      gainBasisPoints: this.#gainBasisPoints,
      muted: this.#muted,
      resumeCount: this.#resumeCount,
      scheduledBufferCount: this.#scheduledPcm.length,
      transactionCount: this.#transactionCount,
      unlockCount: this.#unlockCount,
      unlocked: this.#unlockPromise !== null && this.#fault === null,
    });
  }

  /** Deterministic receipts for PCM buffers actually handed to Web Audio. */
  get scheduledPcmObservations() {
    return frozen(this.#scheduledPcm.map((observation) => ({ ...observation })));
  }

  get scheduledBuffers() {
    return this.scheduledPcmObservations;
  }

  #assertUsable() {
    if (this.#disposed) throw new Error("browser audio sink is disposed");
    if (this.#fault !== null) throw new Error("browser audio sink is permanently faulted");
  }
}
