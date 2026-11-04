import provenanceJson from "./audio-provenance.json" with { type: "json" };

import {
  AUDIO_CUE_TAXONOMY,
  AUDIO_EVENT_MAX_TICK,
  AUDIO_PRODUCTION_CUE_TAXONOMY,
} from "./audio-events.js";
import productionProvenanceJson from "./audio-production-provenance.json" with { type: "json" };

export const AUDIO_RENDERER_MAX_BATCH = 256;
export const AUDIO_RENDERER_MAX_ACTIVE_VOICES = 4_096;
export const AUDIO_RENDERER_MAX_SCHEDULED_VOICES = 16_384;
export const AUDIO_RENDERER_MAX_CLEANUP_TICK = AUDIO_EVENT_MAX_TICK + 120;
export const AUDIO_PCM_SAMPLE_RATE_HZ = 12_000;
export const AUDIO_PCM_SAMPLES_PER_TICK = 200;
export const AUDIO_PCM_FORMAT = "pcm-s16le";
export const AUDIO_PCM_CHANNELS = 1;
export const AUDIO_PRODUCTION_MIX_POLICY = Object.freeze({
  ceiling: 29_491,
  headroomBasisPoints: 900,
  maxPolyphony: 64,
  voiceGainBasisPoints: 275,
});

const AUTHOR_ID = "repository-contributors";
const AUTHOR_STATEMENT =
  "Created from scratch for this repository without third-party or comparison audio.";
const LICENSE_ID = "CC0-1.0";
const LICENSE_STATEMENT =
  "The authors dedicate these procedural recipes and their generated waveforms to the public domain under CC0-1.0.";
const FAMILY_ENTRIES = Object.freeze(Object.entries(AUDIO_CUE_TAXONOMY));
const PRODUCTION_FAMILY_ENTRIES = Object.freeze(
  Object.entries(AUDIO_PRODUCTION_CUE_TAXONOMY),
);
const MAX_PROCEDURAL_PCM_CACHE_ENTRIES = PRODUCTION_FAMILY_ENTRIES.length;
const CUE_TO_FAMILY = new Map(
  PRODUCTION_FAMILY_ENTRIES.map(([family, cueId]) => [cueId, family]),
);
const OSCILLATORS = new Set(["sawtooth", "sine", "square", "triangle"]);
const AUDIO_ASSET_PATTERN = /^src\/audio\/assets\/[a-z0-9][a-z0-9/_-]*\.(?:ogg|wav)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0;
}

function exactRecord(value, keys, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const wanted = [...keys].sort();
  if (actual.some((key) => typeof key !== "string") ||
      actual.length !== wanted.length ||
      [...actual].sort().some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function optionRecord(value) {
  if (!plainObject(value)) throw new TypeError("audio renderer options must be a plain object");
  const allowed = new Set([
    "backend", "gainBasisPoints", "manifest", "muted", "shippedAudioFiles",
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("audio renderer options have an invalid shape");
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`audio renderer options.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  if (!Object.hasOwn(result, "backend")) throw new TypeError("audio renderer options.backend is required");
  return result;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  if (value.length > maximum) throw new RangeError(`${label} exceeds ${maximum}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data properties`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not be sparse`);
  }
  return Array.from(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function isolated(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Bytes(inputValue) {
  const input = inputValue instanceof Uint8Array
    ? inputValue
    : new Uint8Array(inputValue);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 1 - index] = Number(
      bitLength >> BigInt(index * 8) & 0xffn,
    );
  }
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = (
        bytes[start] << 24 |
        bytes[start + 1] << 16 |
        bytes[start + 2] << 8 |
        bytes[start + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ left >>> 3;
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ right >>> 10;
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function sha256Text(text) {
  return sha256Bytes(new TextEncoder().encode(text));
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function checkedRecipe(value, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const hasLayers = Object.hasOwn(descriptors, "layers");
  const recipe = exactRecord(value, [
    "attackTicks", "decayTicks", "durationTicks", "endFrequencyHz",
    "gainBasisPoints", "oscillator", "releaseTicks", "startFrequencyHz",
    ...(hasLayers ? ["layers"] : []),
  ], label);
  integer(recipe.attackTicks, 0, 120, `${label}.attackTicks`);
  integer(recipe.decayTicks, 0, 120, `${label}.decayTicks`);
  integer(recipe.durationTicks, 1, 120, `${label}.durationTicks`);
  integer(recipe.releaseTicks, 0, 120, `${label}.releaseTicks`);
  integer(recipe.startFrequencyHz, 20, 8_000, `${label}.startFrequencyHz`);
  integer(recipe.endFrequencyHz, 20, 8_000, `${label}.endFrequencyHz`);
  integer(recipe.gainBasisPoints, 1, 10_000, `${label}.gainBasisPoints`);
  if (!OSCILLATORS.has(recipe.oscillator)) throw new TypeError(`${label}.oscillator is unsupported`);
  if (recipe.attackTicks + recipe.decayTicks + recipe.releaseTicks > recipe.durationTicks) {
    throw new RangeError(`${label} envelope phases exceed durationTicks`);
  }
  if (hasLayers) {
    const layers = denseArray(recipe.layers, 4, `${label}.layers`).map((value, index) => {
      const layer = exactRecord(value, [
        "frequencyRatioBasisPoints", "gainBasisPoints", "oscillator", "phaseOffset",
      ], `${label}.layers[${index}]`);
      integer(layer.frequencyRatioBasisPoints, 1_000, 40_000,
        `${label}.layers[${index}].frequencyRatioBasisPoints`);
      integer(layer.gainBasisPoints, 1, 10_000,
        `${label}.layers[${index}].gainBasisPoints`);
      integer(layer.phaseOffset, 0, 65_535,
        `${label}.layers[${index}].phaseOffset`);
      if (!OSCILLATORS.has(layer.oscillator)) {
        throw new TypeError(`${label}.layers[${index}].oscillator is unsupported`);
      }
      return { ...layer };
    });
    const layerGain = layers.reduce((total, layer) => total + layer.gainBasisPoints, 0);
    if (layerGain > 10_000) throw new RangeError(`${label}.layers gain exceeds 10000`);
    recipe.layers = layers;
  }
  return { ...recipe };
}

const SINE_QUARTER = Object.freeze([
  0, 804, 1608, 2410, 3212, 4011, 4808, 5602, 6393, 7179, 7962,
  8739, 9512, 10278, 11039, 11793, 12539, 13279, 14010, 14732, 15446,
  16151, 16846, 17530, 18204, 18868, 19519, 20159, 20787, 21403,
  22005, 22594, 23170, 23731, 24279, 24811, 25329, 25832, 26319,
  26790, 27245, 27683, 28105, 28510, 28898, 29268, 29621, 29956,
  30273, 30571, 30852, 31113, 31356, 31580, 31785, 31971, 32137,
  32285, 32412, 32521, 32609, 32678, 32728, 32757, 32767,
]);

function oscillatorSample(oscillator, phase) {
  if (oscillator === "square") return phase < 32_768 ? 32_767 : -32_767;
  if (oscillator === "sawtooth") return phase - 32_768;
  if (oscillator === "triangle") {
    return phase < 32_768 ? phase * 2 - 32_767 : 98_303 - phase * 2;
  }
  const octant = phase >>> 8;
  const quadrant = octant >>> 6;
  const offset = octant & 63;
  const magnitude = SINE_QUARTER[(quadrant & 1) === 0 ? offset : 64 - offset];
  return quadrant < 2 ? magnitude : -magnitude;
}

function envelopeGain(recipe, sampleIndex, sampleCount) {
  const attack = recipe.attackTicks * AUDIO_PCM_SAMPLES_PER_TICK;
  const decay = recipe.decayTicks * AUDIO_PCM_SAMPLES_PER_TICK;
  const release = recipe.releaseTicks * AUDIO_PCM_SAMPLES_PER_TICK;
  const sustain = Number(BigInt(recipe.gainBasisPoints) * 3n / 4n);
  if (attack > 0 && sampleIndex < attack) {
    return Number(BigInt(recipe.gainBasisPoints) * BigInt(sampleIndex + 1) / BigInt(attack));
  }
  if (decay > 0 && sampleIndex < attack + decay) {
    const progress = sampleIndex - attack + 1;
    return recipe.gainBasisPoints - Number(
      BigInt(recipe.gainBasisPoints - sustain) * BigInt(progress) / BigInt(decay),
    );
  }
  const releaseStart = sampleCount - release;
  if (release > 0 && sampleIndex >= releaseStart) {
    return Number(BigInt(sustain) * BigInt(sampleCount - sampleIndex - 1) / BigInt(release));
  }
  return sustain;
}

function synthesizeCheckedProceduralPcm(recipe) {
  const sampleCount = recipe.durationTicks * AUDIO_PCM_SAMPLES_PER_TICK;
  const bytes = new Uint8Array(sampleCount * 2);
  let phase = 0;
  const layers = recipe.layers ?? [];
  const layerPhases = layers.map(({ phaseOffset }) => phaseOffset);
  const layerWeight = layers.reduce((total, layer) => total + layer.gainBasisPoints, 0);
  for (let index = 0; index < sampleCount; index += 1) {
    const frequency = sampleCount === 1
      ? recipe.startFrequencyHz
      : recipe.startFrequencyHz + Number(
        BigInt(recipe.endFrequencyHz - recipe.startFrequencyHz) * BigInt(index) /
        BigInt(sampleCount - 1),
      );
    phase = (phase + Number(BigInt(frequency) * 65_536n / BigInt(AUDIO_PCM_SAMPLE_RATE_HZ))) & 0xffff;
    let amplitude = oscillatorSample(recipe.oscillator, phase);
    if (layers.length > 0) {
      let layered = amplitude * 10_000;
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
        const layer = layers[layerIndex];
        const layerFrequency = Math.max(20, Math.min(8_000,
          Number(BigInt(frequency) * BigInt(layer.frequencyRatioBasisPoints) / 10_000n)));
        layerPhases[layerIndex] = (layerPhases[layerIndex] + Number(
          BigInt(layerFrequency) * 65_536n / BigInt(AUDIO_PCM_SAMPLE_RATE_HZ),
        )) & 0xffff;
        layered += oscillatorSample(layer.oscillator, layerPhases[layerIndex]) *
          layer.gainBasisPoints;
      }
      amplitude = Number(BigInt(layered) / BigInt(10_000 + layerWeight));
    }
    const gain = envelopeGain(recipe, index, sampleCount);
    const sample = Number(BigInt(amplitude) * BigInt(gain) / 10_000n);
    const encoded = sample < 0 ? sample + 65_536 : sample;
    bytes[index * 2] = encoded & 0xff;
    bytes[index * 2 + 1] = encoded >>> 8 & 0xff;
  }
  return Object.freeze({
    bytes,
    channels: AUDIO_PCM_CHANNELS,
    format: AUDIO_PCM_FORMAT,
    sampleCount,
    sampleRateHz: AUDIO_PCM_SAMPLE_RATE_HZ,
  });
}

// Production mix audits run at each accelerated presentation boundary. Keep
// verified source bytes around so the audit spends its time reconstructing
// overlap rather than re-synthesizing an unchanged recipe. The cache is
// deliberately bounded because auditProductionMix also admits direct callers
// with otherwise-valid custom recipes.
const PRODUCTION_PCM_CACHE_LIMIT = 64;
const productionPcmCache = new Map();
const productionScaledPcmCache = new Map();

function cachedProductionPcm(recipe, waveform) {
  const key = `${canonicalJson(recipe)}:${waveform.sha256}`;
  const cached = productionPcmCache.get(key);
  if (cached !== undefined) return { key, pcm: cached };
  const pcm = synthesizeCheckedProceduralPcm(recipe);
  if (sha256Bytes(pcm.bytes) !== waveform.sha256) {
    throw new TypeError("production mix source waveform has an invalid generated waveform hash");
  }
  if (productionPcmCache.size < PRODUCTION_PCM_CACHE_LIMIT) {
    productionPcmCache.set(key, pcm);
  }
  return { key, pcm };
}

function scaledPcmBytes(bytes, gainBasisPoints) {
  if (gainBasisPoints === 10_000) return new Uint8Array(bytes);
  const scaled = new Uint8Array(bytes.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < bytes.length / 2; index += 1) {
    const sample = Number(
      BigInt(view.getInt16(index * 2, true)) * BigInt(gainBasisPoints) / 10_000n,
    );
    const encoded = sample < 0 ? sample + 65_536 : sample;
    scaled[index * 2] = encoded & 0xff;
    scaled[index * 2 + 1] = encoded >>> 8 & 0xff;
  }
  return scaled;
}

/**
 * Reconstruct the deterministic integer mix that the browser sink receives.
 * This is intentionally an offline schedule audit: it proves source bytes,
 * voice gain, overlap, and the signed PCM ceiling, without claiming to model
 * browser acoustics or device output.
 */
export function auditProductionMix(voicesValue, policyValue = AUDIO_PRODUCTION_MIX_POLICY) {
  const voices = denseArray(voicesValue, AUDIO_RENDERER_MAX_ACTIVE_VOICES,
    "production mix voices");
  const policy = exactRecord(policyValue, [
    "ceiling", "headroomBasisPoints", "maxPolyphony", "voiceGainBasisPoints",
  ], "production mix policy");
  integer(policy.ceiling, 1, 32_767, "production mix policy.ceiling");
  integer(policy.headroomBasisPoints, 1, 5_000,
    "production mix policy.headroomBasisPoints");
  integer(policy.maxPolyphony, 1, AUDIO_RENDERER_MAX_ACTIVE_VOICES,
    "production mix policy.maxPolyphony");
  integer(policy.voiceGainBasisPoints, 1, 10_000,
    "production mix policy.voiceGainBasisPoints");
  if (voices.length > policy.maxPolyphony) {
    throw new RangeError("production mix polyphony bound exceeded");
  }
  if (voices.length === 0) {
    return isolated({
      ceiling: policy.ceiling,
      energy: 0,
      headroomBasisPoints: policy.headroomBasisPoints,
      peak: 0,
      rmsBasisPoints: 0,
      voiceCount: 0,
    });
  }
  const checked = voices.map((voice, index) => {
    if (!plainObject(voice)) throw new TypeError(`production mix voice ${index} is invalid`);
    const source = exactRecord(voice.source, [
      "durationTicks", "kind", "recipe", "sha256", "waveform",
    ], `production mix voice ${index}.source`);
    if (source.kind !== "procedural") {
      throw new TypeError(`production mix voice ${index} source is not procedural`);
    }
    const recipe = checkedRecipe(source.recipe, `production mix voice ${index}.recipe`);
    const waveform = checkedWaveformMetadata(source.waveform, recipe,
      `production mix voice ${index}.waveform`);
    if (source.durationTicks !== recipe.durationTicks ||
        !SHA256_PATTERN.test(source.sha256)) {
      throw new TypeError(`production mix voice ${index} source metadata diverges`);
    }
    integer(voice.startTick, 0, AUDIO_EVENT_MAX_TICK, `production mix voice ${index}.startTick`);
    const mixGainBasisPoints = integer(voice.mixGainBasisPoints ?? policy.voiceGainBasisPoints, 1,
      policy.voiceGainBasisPoints,
      `production mix voice ${index}.mixGainBasisPoints`);
    const { key, pcm } = cachedProductionPcm(recipe, waveform);
    if (pcm.sampleCount !== waveform.sampleCount) {
      throw new TypeError(`production mix voice ${index} sample count diverges`);
    }
    const scaledKey = `${key}:${mixGainBasisPoints}`;
    let bytes = productionScaledPcmCache.get(scaledKey);
    if (bytes === undefined) {
      bytes = scaledPcmBytes(pcm.bytes, mixGainBasisPoints);
      if (productionScaledPcmCache.size < PRODUCTION_PCM_CACHE_LIMIT) {
        productionScaledPcmCache.set(scaledKey, bytes);
      }
    }
    return {
      bytes,
      startTick: voice.startTick,
    };
  });
  const startTick = Math.min(...checked.map(({ startTick: tick }) => tick));
  const endTick = Math.max(...checked.map(({ bytes, startTick: tick }) =>
    tick + bytes.length / 2 / AUDIO_PCM_SAMPLES_PER_TICK));
  const mixed = new Int32Array((endTick - startTick) * AUDIO_PCM_SAMPLES_PER_TICK);
  for (const voice of checked) {
    const offset = (voice.startTick - startTick) * AUDIO_PCM_SAMPLES_PER_TICK;
    const view = new DataView(voice.bytes.buffer, voice.bytes.byteOffset, voice.bytes.byteLength);
    for (let index = 0; index < voice.bytes.length / 2; index += 1) {
      mixed[offset + index] += view.getInt16(index * 2, true);
    }
  }
  let peak = 0;
  let energy = 0;
  for (const sample of mixed) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    energy += sample * sample;
  }
  if (peak > policy.ceiling) {
    throw new RangeError(`production mix clipping budget exceeded (${peak} > ${policy.ceiling})`);
  }
  const rms = mixed.length === 0 ? 0 : Math.sqrt(energy / mixed.length);
  return isolated({
    ceiling: policy.ceiling,
    energy,
    headroomBasisPoints: policy.headroomBasisPoints,
    peak,
    rmsBasisPoints: Math.floor(rms * 10_000 / 32_767),
    voiceCount: voices.length,
  });
}

export function synthesizeProceduralPcm(recipeValue) {
  return synthesizeCheckedProceduralPcm(
    checkedRecipe(recipeValue, "procedural audio recipe"),
  );
}

function checkedWaveformMetadata(value, recipe, label) {
  const waveform = exactRecord(value, [
    "channels", "format", "sampleCount", "sampleRateHz", "sha256",
  ], label);
  if (waveform.channels !== AUDIO_PCM_CHANNELS || waveform.format !== AUDIO_PCM_FORMAT ||
      waveform.sampleRateHz !== AUDIO_PCM_SAMPLE_RATE_HZ ||
      waveform.sampleCount !== recipe.durationTicks * AUDIO_PCM_SAMPLES_PER_TICK ||
      !SHA256_PATTERN.test(waveform.sha256)) {
    throw new TypeError(`${label} has invalid PCM metadata`);
  }
  return { ...waveform };
}

function checkedWaveform(value, recipe, label) {
  const waveform = checkedWaveformMetadata(value, recipe, label);
  const generated = synthesizeCheckedProceduralPcm(recipe);
  if (sha256Bytes(generated.bytes) !== waveform.sha256) {
    throw new TypeError(`${label} has an invalid generated waveform hash`);
  }
  return waveform;
}

export function audioRecipeSha256(family, cueId, recipe) {
  if (AUDIO_PRODUCTION_CUE_TAXONOMY[family] !== cueId) {
    throw new TypeError("recipe family and cueId do not match the audio taxonomy");
  }
  const checked = checkedRecipe(recipe, "recipe");
  return sha256Text(canonicalJson({
    cueId,
    family,
    recipe: checked,
    schema: "procedural-cue-v1",
  }));
}

function safeAssetPath(value, label) {
  if (typeof value !== "string" || !AUDIO_ASSET_PATTERN.test(value) ||
      value.includes("..") || value.includes("\\") || value.includes(":") ||
      value.includes("?") || value.includes("#")) {
    throw new TypeError(`${label} must be a repository-local audio asset path`);
  }
  return value;
}

function linkage(record, label) {
  if (record.authorId !== AUTHOR_ID || record.licenseId !== LICENSE_ID) {
    throw new TypeError(`${label} has invalid authorship or license linkage`);
  }
  if (AUDIO_CUE_TAXONOMY[record.family] !== record.cueId) {
    throw new TypeError(`${label} does not match the audio cue taxonomy`);
  }
}

export function auditAudioProvenance(manifestValue, shippedAudioFilesValue = []) {
  if (plainObject(manifestValue)) {
    const descriptors = Object.getOwnPropertyDescriptors(manifestValue);
    const version = descriptors.version;
    if (version?.enumerable && Object.hasOwn(version, "value") && version.value === 2) {
      return auditProductionAudioProvenance(manifestValue, shippedAudioFilesValue);
    }
  }
  const manifest = exactRecord(manifestValue, [
    "assets", "author", "license", "recipes", "schema", "version",
  ], "audio provenance manifest");
  if (manifest.schema !== "original-audio-provenance" || manifest.version !== 1) {
    throw new TypeError("audio provenance schema or version is unsupported");
  }
  const author = exactRecord(manifest.author, ["id", "statement"], "audio provenance author");
  const license = exactRecord(manifest.license, ["id", "statement"], "audio provenance license");
  if (author.id !== AUTHOR_ID || author.statement !== AUTHOR_STATEMENT ||
      license.id !== LICENSE_ID || license.statement !== LICENSE_STATEMENT) {
    throw new TypeError("audio provenance authorship or license assertion is invalid");
  }
  const shippedAudioFiles = denseArray(
    shippedAudioFilesValue,
    64,
    "shipped audio files",
  ).map((value, index) => {
    const record = exactRecord(value, ["path", "sha256"], `shipped audio files[${index}]`);
    const path = safeAssetPath(record.path, `shipped audio files[${index}].path`);
    if (!SHA256_PATTERN.test(record.sha256)) {
      throw new TypeError(`shipped audio files[${index}].sha256 is invalid`);
    }
    return { path, sha256: record.sha256 };
  });
  if (shippedAudioFiles.some(({ path }, index) =>
    index > 0 && path <= shippedAudioFiles[index - 1].path)) {
    throw new TypeError("shipped audio files must be unique and canonically ordered");
  }

  const seenCueIds = new Set();
  let previousRecipeFamily = -1;
  const recipes = denseArray(manifest.recipes, FAMILY_ENTRIES.length, "audio provenance recipes")
    .map((value, index) => {
      const record = exactRecord(value, [
        "authorId", "cueId", "family", "licenseId", "recipe", "sha256", "waveform",
      ], `audio provenance recipes[${index}]`);
      linkage(record, `audio provenance recipes[${index}]`);
      if (seenCueIds.has(record.cueId)) throw new TypeError(`duplicate audio cue ${record.cueId}`);
      const familyIndex = FAMILY_ENTRIES.findIndex(([family]) => family === record.family);
      if (familyIndex <= previousRecipeFamily) {
        throw new TypeError("audio provenance recipes must be canonically ordered");
      }
      previousRecipeFamily = familyIndex;
      seenCueIds.add(record.cueId);
      const recipe = checkedRecipe(record.recipe, `audio provenance recipes[${index}].recipe`);
      const expectedHash = audioRecipeSha256(record.family, record.cueId, recipe);
      if (record.sha256 !== expectedHash) {
        throw new TypeError(`audio provenance recipes[${index}] has an invalid canonical hash`);
      }
      const waveform = checkedWaveform(
        record.waveform,
        recipe,
        `audio provenance recipes[${index}].waveform`,
      );
      return { ...record, recipe, waveform };
    });

  const seenPaths = new Set();
  let previousAssetFamily = -1;
  const assets = denseArray(manifest.assets, FAMILY_ENTRIES.length, "audio provenance assets")
    .map((value, index) => {
      const record = exactRecord(value, [
        "authorId", "cueId", "durationTicks", "family", "licenseId", "path", "sha256",
      ], `audio provenance assets[${index}]`);
      linkage(record, `audio provenance assets[${index}]`);
      if (seenCueIds.has(record.cueId)) throw new TypeError(`duplicate audio cue ${record.cueId}`);
      const familyIndex = FAMILY_ENTRIES.findIndex(([family]) => family === record.family);
      if (familyIndex <= previousAssetFamily) {
        throw new TypeError("audio provenance assets must be canonically ordered");
      }
      previousAssetFamily = familyIndex;
      seenCueIds.add(record.cueId);
      const path = safeAssetPath(record.path, `audio provenance assets[${index}].path`);
      integer(record.durationTicks, 1, 120, `audio provenance assets[${index}].durationTicks`);
      if (seenPaths.has(path)) throw new TypeError(`duplicate audio asset path ${path}`);
      seenPaths.add(path);
      if (!SHA256_PATTERN.test(record.sha256)) {
        throw new TypeError(`audio provenance assets[${index}].sha256 is invalid`);
      }
      return { ...record, path };
    });

  for (const [, cueId] of FAMILY_ENTRIES) {
    if (!seenCueIds.has(cueId)) throw new TypeError(`missing audio source for cue ${cueId}`);
  }
  const listedPaths = [...seenPaths].sort();
  for (const path of listedPaths) {
    const shipped = shippedAudioFiles.find((file) => file.path === path);
    if (shipped === undefined) throw new TypeError(`missing shipped audio asset ${path}`);
    const listed = assets.find((asset) => asset.path === path);
    if (shipped.sha256 !== listed.sha256) {
      throw new TypeError(`shipped audio asset hash mismatch ${path}`);
    }
  }
  for (const { path } of shippedAudioFiles) {
    if (!seenPaths.has(path)) throw new TypeError(`unlisted shipped audio asset ${path}`);
  }
  return isolated({
    assets,
    author,
    license,
    recipes,
    schema: manifest.schema,
    version: manifest.version,
  });
}

/**
 * Validate the version-two production manifest.  The legacy version-one
 * manifest intentionally remains unchanged for replay consumers; production
 * adds the authored UI/movement cues and a pinned integer mix policy.
 */
export function auditProductionAudioProvenance(
  manifestValue,
  shippedAudioFilesValue = [],
) {
  const manifest = exactRecord(manifestValue, [
    "assets", "author", "license", "mix", "recipes", "schema", "version",
  ], "production audio provenance manifest");
  if (manifest.schema !== "original-audio-provenance" || manifest.version !== 2) {
    throw new TypeError("production audio provenance schema or version is unsupported");
  }
  const author = exactRecord(manifest.author, ["id", "statement"],
    "production audio provenance author");
  const license = exactRecord(manifest.license, ["id", "statement"],
    "production audio provenance license");
  if (author.id !== AUTHOR_ID || author.statement !== AUTHOR_STATEMENT ||
      license.id !== LICENSE_ID || license.statement !== LICENSE_STATEMENT) {
    throw new TypeError("production audio provenance authorship or license assertion is invalid");
  }
  const mix = exactRecord(manifest.mix, [
    "ceiling", "headroomBasisPoints", "maxPolyphony", "voiceGainBasisPoints",
  ], "production audio mix policy");
  integer(mix.ceiling, 1, 32_767, "production audio mix policy.ceiling");
  integer(mix.headroomBasisPoints, 1, 5_000,
    "production audio mix policy.headroomBasisPoints");
  integer(mix.maxPolyphony, 1, AUDIO_RENDERER_MAX_ACTIVE_VOICES,
    "production audio mix policy.maxPolyphony");
  integer(mix.voiceGainBasisPoints, 1, 10_000,
    "production audio mix policy.voiceGainBasisPoints");
  for (const key of Object.keys(AUDIO_PRODUCTION_MIX_POLICY)) {
    if (mix[key] !== AUDIO_PRODUCTION_MIX_POLICY[key]) {
      throw new TypeError("production audio mix policy does not match the pinned policy");
    }
  }
  const shippedAudioFiles = denseArray(
    shippedAudioFilesValue,
    64,
    "shipped audio files",
  ).map((value, index) => {
    const record = exactRecord(value, ["path", "sha256"], `shipped audio files[${index}]`);
    const path = safeAssetPath(record.path, `shipped audio files[${index}].path`);
    if (!SHA256_PATTERN.test(record.sha256)) {
      throw new TypeError(`shipped audio files[${index}].sha256 is invalid`);
    }
    return { path, sha256: record.sha256 };
  });
  if (shippedAudioFiles.some(({ path }, index) =>
    index > 0 && path <= shippedAudioFiles[index - 1].path)) {
    throw new TypeError("shipped audio files must be unique and canonically ordered");
  }

  const seenCueIds = new Set();
  let previousRecipeFamily = -1;
  const recipes = denseArray(
    manifest.recipes,
    PRODUCTION_FAMILY_ENTRIES.length,
    "production audio provenance recipes",
  ).map((value, index) => {
    const record = exactRecord(value, [
      "authorId", "cueId", "family", "licenseId", "recipe", "sha256", "waveform",
    ], `production audio provenance recipes[${index}]`);
    if (record.authorId !== AUTHOR_ID || record.licenseId !== LICENSE_ID) {
      throw new TypeError(`production audio provenance recipes[${index}] has invalid authorship or license linkage`);
    }
    if (seenCueIds.has(record.cueId)) {
      throw new TypeError(`duplicate audio cue ${record.cueId}`);
    }
    const familyIndex = PRODUCTION_FAMILY_ENTRIES.findIndex(([family]) => family === record.family);
    if (familyIndex <= previousRecipeFamily) {
      throw new TypeError("production audio provenance recipes must be canonically ordered");
    }
    if (AUDIO_PRODUCTION_CUE_TAXONOMY[record.family] !== record.cueId) {
      throw new TypeError(`production audio provenance recipes[${index}] does not match the audio cue taxonomy`);
    }
    previousRecipeFamily = familyIndex;
    seenCueIds.add(record.cueId);
    const recipe = checkedRecipe(record.recipe,
      `production audio provenance recipes[${index}].recipe`);
    const expectedHash = audioRecipeSha256(record.family, record.cueId, recipe);
    if (record.sha256 !== expectedHash) {
      throw new TypeError(`production audio provenance recipes[${index}] has an invalid canonical hash`);
    }
    const waveform = checkedWaveform(
      record.waveform,
      recipe,
      `production audio provenance recipes[${index}].waveform`,
    );
    return { ...record, recipe, waveform };
  });

  const seenPaths = new Set();
  let previousAssetFamily = -1;
  const assets = denseArray(
    manifest.assets,
    PRODUCTION_FAMILY_ENTRIES.length,
    "production audio provenance assets",
  ).map((value, index) => {
    const record = exactRecord(value, [
      "authorId", "cueId", "durationTicks", "family", "licenseId", "path", "sha256",
    ], `production audio provenance assets[${index}]`);
    if (record.authorId !== AUTHOR_ID || record.licenseId !== LICENSE_ID) {
      throw new TypeError(`production audio provenance assets[${index}] has invalid authorship or license linkage`);
    }
    if (seenCueIds.has(record.cueId)) {
      throw new TypeError(`duplicate audio cue ${record.cueId}`);
    }
    const familyIndex = PRODUCTION_FAMILY_ENTRIES.findIndex(([family]) => family === record.family);
    if (familyIndex <= previousAssetFamily) {
      throw new TypeError("production audio provenance assets must be canonically ordered");
    }
    if (AUDIO_PRODUCTION_CUE_TAXONOMY[record.family] !== record.cueId) {
      throw new TypeError(`production audio provenance assets[${index}] does not match the audio cue taxonomy`);
    }
    previousAssetFamily = familyIndex;
    seenCueIds.add(record.cueId);
    const path = safeAssetPath(record.path, `production audio provenance assets[${index}].path`);
    integer(record.durationTicks, 1, 120,
      `production audio provenance assets[${index}].durationTicks`);
    if (seenPaths.has(path)) throw new TypeError(`duplicate audio asset path ${path}`);
    seenPaths.add(path);
    if (!SHA256_PATTERN.test(record.sha256)) {
      throw new TypeError(`production audio provenance assets[${index}].sha256 is invalid`);
    }
    return { ...record, path };
  });

  for (const cueId of CUE_TO_FAMILY.keys()) {
    if (!seenCueIds.has(cueId)) throw new TypeError(`missing audio source for cue ${cueId}`);
  }
  const listedPaths = [...seenPaths].sort();
  for (const path of listedPaths) {
    const shipped = shippedAudioFiles.find((file) => file.path === path);
    if (shipped === undefined) throw new TypeError(`missing shipped audio asset ${path}`);
    const listed = assets.find((asset) => asset.path === path);
    if (shipped.sha256 !== listed.sha256) {
      throw new TypeError(`shipped audio asset hash mismatch ${path}`);
    }
  }
  for (const { path } of shippedAudioFiles) {
    if (!seenPaths.has(path)) throw new TypeError(`unlisted shipped audio asset ${path}`);
  }
  return isolated({
    assets,
    author,
    license,
    mix,
    recipes,
    schema: manifest.schema,
    version: manifest.version,
  });
}

const DEFAULT_PROVENANCE = auditAudioProvenance(provenanceJson, []);
const PRODUCTION_MANIFEST_INPUT = {
  assets: [...provenanceJson.assets, ...productionProvenanceJson.assets],
  author: productionProvenanceJson.author,
  license: productionProvenanceJson.license,
  mix: productionProvenanceJson.mix,
  recipes: [...provenanceJson.recipes, ...productionProvenanceJson.recipes],
  schema: productionProvenanceJson.schema,
  version: productionProvenanceJson.version,
};
const DEFAULT_PRODUCTION_PROVENANCE = auditProductionAudioProvenance(
  PRODUCTION_MANIFEST_INPUT,
  [],
);
const productionRendererOptions = new WeakSet();

export function createAudioProvenanceManifest() {
  return isolated(DEFAULT_PROVENANCE);
}

export function createProductionAudioProvenanceManifest() {
  return isolated(DEFAULT_PRODUCTION_PROVENANCE);
}

function checkedBackend(value) {
  if (value instanceof InMemoryPcmAudioBackend) return { apply: value.apply };
  const backend = exactRecord(value, ["apply"], "audio backend");
  if (typeof backend.apply !== "function") throw new TypeError("audio backend.apply must be a function");
  return backend;
}

function checkedTransaction(value) {
  const transaction = exactRecord(value, ["commands", "transactionId"], "audio transaction");
  integer(transaction.transactionId, 1, Number.MAX_SAFE_INTEGER, "audio transaction.transactionId");
  const commands = denseArray(
    transaction.commands,
    AUDIO_RENDERER_MAX_ACTIVE_VOICES,
    "audio transaction.commands",
  )
    .map((command, index) => {
      if (!plainObject(command)) throw new TypeError(`audio transaction.commands[${index}] must be a plain object`);
      return structuredClone(command);
    });
  return { commands, transactionId: transaction.transactionId };
}

export class InMemoryPcmAudioBackend {
  #faultTransactionId = null;
  #gainBasisPoints = 10_000;
  #muted = false;
  // A backend owns this bounded-by-taxonomy cache. A cache hit still fully
  // checks untrusted recipe/waveform data before it reuses a previously
  // verified internal PCM value; every outward voice receives fresh bytes.
  #proceduralPcm = new Map();
  #sink;
  #transactions = [];
  #voices = new Map();

  constructor(options = {}) {
    if (!plainObject(options)) throw new TypeError("PCM backend options must be a plain object");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).some((key) => key !== "sink")) {
      throw new TypeError("PCM backend options have an invalid shape");
    }
    if (Object.hasOwn(descriptors, "sink")) {
      if (!descriptors.sink.enumerable || !Object.hasOwn(descriptors.sink, "value") ||
          typeof descriptors.sink.value !== "function") {
        throw new TypeError("PCM backend sink must be an enumerable function data property");
      }
      this.#sink = descriptors.sink.value;
    }
    Object.defineProperty(this, "apply", {
      enumerable: true,
      value: this.#applyTransaction.bind(this),
    });
  }

  get state() {
    return isolated({
      activeVoiceCount: this.#voices.size,
      faultTransactionId: this.#faultTransactionId,
      faulted: this.#faultTransactionId !== null,
      gainBasisPoints: this.#gainBasisPoints,
      muted: this.#muted,
      transactionCount: this.#transactions.length,
    });
  }

  get activeVoices() {
    return Object.freeze([...this.#voices.values()]
      .sort((left, right) => left.voiceId - right.voiceId)
      .map((voice) => Object.freeze({ ...voice, bytes: new Uint8Array(voice.bytes) })));
  }

  get transactions() {
    return isolated(this.#transactions);
  }

  #checkedProceduralPcm(recipeValue, waveformValue) {
    const recipe = checkedRecipe(recipeValue, "procedural audio recipe");
    const waveform = checkedWaveformMetadata(
      waveformValue,
      recipe,
      "start source waveform",
    );
    const key = `${waveform.sha256}:${canonicalJson(recipe)}`;
    let pcm = this.#proceduralPcm.get(key);
    if (pcm === undefined) {
      pcm = synthesizeCheckedProceduralPcm(recipe);
      if (sha256Bytes(pcm.bytes) !== waveform.sha256) {
        throw new TypeError("start source waveform has an invalid generated waveform hash");
      }
      // InMemoryPcmAudioBackend also has a direct hostile-input API, so do
      // not let distinct otherwise-valid external recipes grow this cache.
      // The shipped taxonomy has one recipe per family and fits this bound.
      if (this.#proceduralPcm.size < MAX_PROCEDURAL_PCM_CACHE_ENTRIES) {
        this.#proceduralPcm.set(key, pcm);
      }
    }
    return { pcm, waveform };
  }

  #applyTransaction(transactionValue) {
    if (this.#faultTransactionId !== null) {
      throw new Error("PCM backend is permanently faulted");
    }
    const transaction = checkedTransaction(transactionValue);
    const signature = sha256Text(canonicalJson(transaction.commands));
    const prior = this.#transactions.find(({ transactionId }) =>
      transactionId === transaction.transactionId);
    if (prior !== undefined) {
      if (prior.signature !== signature) throw new Error("divergent duplicate audio transaction");
      return;
    }
    const expectedId = this.#transactions.length + 1;
    if (transaction.transactionId !== expectedId) {
      throw new RangeError(`audio transaction ID must be ${expectedId}`);
    }
    const voices = new Map(this.#voices);
    let gainBasisPoints = this.#gainBasisPoints;
    let muted = this.#muted;
    for (const command of transaction.commands) {
      if (command.kind === "output") {
        gainBasisPoints = integer(command.gainBasisPoints, 0, 10_000, "output gainBasisPoints");
        if (command.muted !== true && command.muted !== false) {
          throw new TypeError("output muted must be a boolean");
        }
        muted = command.muted;
      } else if (command.kind === "stop") {
        integer(command.voiceId, 1, Number.MAX_SAFE_INTEGER, "stop voiceId");
        voices.delete(command.voiceId);
      } else if (command.kind === "start") {
        integer(command.voiceId, 1, Number.MAX_SAFE_INTEGER, "start voiceId");
        const mixGainBasisPoints = integer(
          command.mixGainBasisPoints ?? 10_000,
          0,
          10_000,
          "start mixGainBasisPoints",
        );
        if (voices.has(command.voiceId)) throw new Error("duplicate active audio voice");
        if (command.source?.kind !== "procedural") {
          throw new TypeError("PCM backend supports procedural sources only");
        }
        const { pcm, waveform } = this.#checkedProceduralPcm(
          command.source.recipe,
          command.source.waveform,
        );
        voices.set(command.voiceId, {
          bytes: scaledPcmBytes(pcm.bytes, mixGainBasisPoints),
          cueId: command.cueId,
          effectiveGainBasisPoints: command.effectiveGainBasisPoints,
          endTick: command.endTick,
          family: command.family,
          mixGainBasisPoints,
          sampleCount: pcm.sampleCount,
          sampleRateHz: pcm.sampleRateHz,
          sequence: command.sequence,
          startTick: command.startTick,
          sourceType: command.sourceType,
          voiceId: command.voiceId,
          waveformSha256: waveform.sha256,
        });
      } else {
        throw new TypeError("unknown PCM backend command");
      }
    }
    if (this.#sink !== undefined) {
      try {
        const pcmVoices = Object.freeze(transaction.commands
          .filter(({ kind }) => kind === "start")
          .map(({ voiceId }) => {
            const voice = voices.get(voiceId);
            return Object.freeze({ ...voice, bytes: new Uint8Array(voice.bytes) });
          }));
        const result = this.#sink(isolated(transaction), pcmVoices);
        if (result !== undefined) {
          throw new TypeError("PCM backend sink must complete synchronously without a return value");
        }
      } catch (error) {
        this.#faultTransactionId = transaction.transactionId;
        throw error;
      }
    }
    this.#voices = voices;
    this.#gainBasisPoints = gainBasisPoints;
    this.#muted = muted;
    this.#transactions.push({ signature, transactionId: transaction.transactionId });
  }
}

function checkedCue(value, label) {
  const cue = exactRecord(
    value,
    ["cueId", "family", "reason", "sequence", "tick", "type"],
    label,
  );
  if (AUDIO_PRODUCTION_CUE_TAXONOMY[cue.family] !== cue.cueId || cue.reason !== "mapped") {
    throw new TypeError(`${label} is not a mapped audio cue`);
  }
  integer(cue.sequence, 0, Number.MAX_SAFE_INTEGER, `${label}.sequence`);
  integer(cue.tick, 0, AUDIO_EVENT_MAX_TICK, `${label}.tick`);
  if (typeof cue.type !== "string" || !/^[a-z0-9_-]{1,128}$/u.test(cue.type)) {
    throw new TypeError(`${label}.type must be a canonical event type`);
  }
  return { ...cue };
}

function effectiveGain(recipeGain, masterGain, muted) {
  if (muted) return 0;
  return Number(BigInt(recipeGain) * BigInt(masterGain) / 10_000n);
}

function effectiveMixedGain(recipeGain, masterGain, mixGain, muted) {
  if (muted) return 0;
  return Number(
    BigInt(recipeGain) * BigInt(masterGain) * BigInt(mixGain) / 100_000_000n,
  );
}

export class AudioRenderer {
  #active = [];
  #backend;
  #cleanupTick = 0;
  #disposed = false;
  #fault = null;
  #gainBasisPoints;
  #lastSequence = null;
  #lastTick = null;
  #lastUiSequence = null;
  #lastUiTick = null;
  #muted;
  #nextVoiceId = 1;
  #nextTransactionId = 1;
  #mixPolicy = null;
  #scheduledCount = 0;
  #sources = new Map();

  constructor(optionsValue) {
    const hasTrustedProductionProvenance = productionRendererOptions.has(optionsValue);
    const options = optionRecord(optionsValue);
    this.#backend = checkedBackend(options.backend);
    this.#gainBasisPoints = integer(
      options.gainBasisPoints ?? 10_000,
      0,
      10_000,
      "audio renderer gainBasisPoints",
    );
    if ((options.muted ?? false) !== true && (options.muted ?? false) !== false) {
      throw new TypeError("audio renderer muted must be a boolean");
    }
    this.#muted = options.muted ?? false;
    const provenance = hasTrustedProductionProvenance
      ? DEFAULT_PRODUCTION_PROVENANCE
      : auditAudioProvenance(
        options.manifest ?? DEFAULT_PROVENANCE,
        options.shippedAudioFiles ?? [],
      );
    if (provenance.version === 2) this.#mixPolicy = provenance.mix;
    for (const entry of provenance.recipes) {
      this.#sources.set(entry.cueId, {
        durationTicks: entry.recipe.durationTicks,
        kind: "procedural",
        recipe: entry.recipe,
        sha256: entry.sha256,
        waveform: entry.waveform,
      });
    }
    for (const entry of provenance.assets) {
      this.#sources.set(entry.cueId, {
        durationTicks: entry.durationTicks,
        kind: "asset",
        path: entry.path,
        sha256: entry.sha256,
      });
    }
    this.#apply([{
      gainBasisPoints: this.#gainBasisPoints,
      kind: "output",
      muted: this.#muted,
    }]);
  }

  get state() {
    return isolated({
      activeVoiceCount: this.#active.length,
      cleanupTick: this.#cleanupTick,
      disposed: this.#disposed,
      faultTransactionId: this.#fault?.transactionId ?? null,
      faulted: this.#fault !== null,
      gainBasisPoints: this.#gainBasisPoints,
      lastSequence: this.#lastSequence,
      lastTick: this.#lastTick,
      muted: this.#muted,
      nextVoiceId: this.#nextVoiceId,
      nextTransactionId: this.#nextTransactionId,
      scheduledCount: this.#scheduledCount,
    });
  }

  get activeVoices() {
    return isolated(this.#active);
  }

  get mixAudit() {
    return this.#mixPolicy === null
      ? null
      : auditProductionMix(this.#active, this.#mixPolicy);
  }

  renderBatch(cuesValue) {
    return this.#renderBatch(cuesValue, "simulation");
  }

  /** Render authenticated UI cues on a sequence domain independent of replay. */
  renderUiBatch(cuesValue) {
    return this.#renderBatch(cuesValue, "ui");
  }

  #renderBatch(cuesValue, domain) {
    this.#assertLive();
    const values = denseArray(cuesValue, AUDIO_RENDERER_MAX_BATCH, "audio cue batch");
    if (values.length > AUDIO_RENDERER_MAX_ACTIVE_VOICES - this.#active.length) {
      throw new RangeError("audio renderer active voice bound exceeded");
    }
    if (values.length > AUDIO_RENDERER_MAX_SCHEDULED_VOICES - this.#scheduledCount) {
      throw new RangeError("audio renderer scheduled voice bound exceeded");
    }
    if (this.#mixPolicy !== null &&
        this.#active.length + values.length > this.#mixPolicy.maxPolyphony) {
      throw new RangeError("production mix polyphony bound exceeded");
    }
    const cues = [];
    let lastSequence = domain === "ui" ? this.#lastUiSequence : this.#lastSequence;
    let lastTick = domain === "ui" ? this.#lastUiTick : this.#lastTick;
    for (let index = 0; index < values.length; index += 1) {
      const cue = checkedCue(values[index], `audio cue batch[${index}]`);
      if (lastSequence !== null && cue.sequence <= lastSequence) {
        throw new RangeError(`audio cue batch[${index}].sequence must increase`);
      }
      if (lastTick !== null && cue.tick < lastTick) {
        throw new RangeError(`audio cue batch[${index}].tick must not move backwards`);
      }
      if (cue.tick < this.#cleanupTick) {
        throw new RangeError(`audio cue batch[${index}].tick precedes cleanup`);
      }
      cues.push(cue);
      lastSequence = cue.sequence;
      lastTick = cue.tick;
    }
    let voices = cues.map((cue, index) => {
      const source = this.#sources.get(cue.cueId);
      const durationTicks = source.durationTicks;
      const voiceId = this.#nextVoiceId + index;
      return {
        cueId: cue.cueId,
        effectiveGainBasisPoints: source.kind === "procedural"
          ? (this.#mixPolicy === null
            ? effectiveGain(source.recipe.gainBasisPoints, this.#gainBasisPoints, this.#muted)
            : effectiveMixedGain(source.recipe.gainBasisPoints, this.#gainBasisPoints,
              this.#mixPolicy.voiceGainBasisPoints, this.#muted))
          : this.#muted ? 0 : this.#gainBasisPoints,
        endTick: cue.tick + durationTicks,
        family: cue.family,
        kind: "start",
        sequence: cue.sequence,
        source,
        sourceType: cue.type,
        startTick: cue.tick,
        voiceGainBasisPoints: source.kind === "procedural"
          ? source.recipe.gainBasisPoints
          : 10_000,
        mixGainBasisPoints: this.#mixPolicy?.voiceGainBasisPoints ?? 10_000,
        voiceId,
      };
    });
    if (this.#mixPolicy !== null && voices.length > 0) {
      const mixGainBasisPoints = this.#mixPolicy.voiceGainBasisPoints;
      voices = voices.map((voice) => ({
        ...voice,
        effectiveGainBasisPoints: voice.source.kind === "procedural"
          ? effectiveMixedGain(voice.source.recipe.gainBasisPoints,
            this.#gainBasisPoints, mixGainBasisPoints, this.#muted)
          : voice.effectiveGainBasisPoints,
        mixGainBasisPoints,
      }));
      auditProductionMix([...this.#active, ...voices], this.#mixPolicy);
    }
    const commands = isolated(voices);
    if (commands.length > 0) this.#apply(commands);
    this.#active.push(...voices.map((voice) => isolated(voice)));
    this.#nextVoiceId += voices.length;
    this.#scheduledCount += voices.length;
    if (cues.length > 0) {
      if (domain === "ui") {
        this.#lastUiSequence = cues.at(-1).sequence;
        this.#lastUiTick = cues.at(-1).tick;
      } else {
        this.#lastSequence = cues.at(-1).sequence;
        this.#lastTick = cues.at(-1).tick;
      }
    }
    return commands;
  }

  setGainBasisPoints(value) {
    this.#assertLive();
    const gain = integer(value, 0, 10_000, "audio renderer gainBasisPoints");
    if (gain === this.#gainBasisPoints) return this.state;
    this.#apply([{ gainBasisPoints: gain, kind: "output", muted: this.#muted }]);
    this.#gainBasisPoints = gain;
    return this.state;
  }

  setMuted(value) {
    this.#assertLive();
    if (value !== true && value !== false) throw new TypeError("audio renderer muted must be a boolean");
    if (value === this.#muted) return this.state;
    this.#apply([{
      gainBasisPoints: this.#gainBasisPoints,
      kind: "output",
      muted: value,
    }]);
    this.#muted = value;
    return this.state;
  }

  cleanupThroughTick(value) {
    this.#assertLive();
    const tick = integer(value, 0, AUDIO_RENDERER_MAX_CLEANUP_TICK, "audio cleanup tick");
    if (tick < this.#cleanupTick) throw new RangeError("audio cleanup tick must not move backwards");
    const completed = this.#active
      .filter((voice) => voice.endTick <= tick)
      .sort((left, right) => left.endTick - right.endTick || left.voiceId - right.voiceId);
    const commands = isolated(completed.map(({ voiceId }) => ({ kind: "stop", voiceId })));
    if (commands.length > 0) this.#apply(commands);
    const completedIds = new Set(completed.map(({ voiceId }) => voiceId));
    this.#active = this.#active.filter(({ voiceId }) => !completedIds.has(voiceId));
    this.#cleanupTick = tick;
    return commands;
  }

  dispose() {
    this.#assertNotFaulted();
    if (this.#disposed) return isolated([]);
    const commands = isolated(
      [...this.#active]
        .sort((left, right) => left.voiceId - right.voiceId)
        .map(({ voiceId }) => ({ kind: "stop", voiceId })),
    );
    if (commands.length > 0) this.#apply(commands);
    this.#active = [];
    this.#disposed = true;
    return commands;
  }

  #apply(commandsValue) {
    const commands = isolated(commandsValue);
    const transaction = isolated({ commands, transactionId: this.#nextTransactionId });
    try {
      const result = this.#backend.apply(transaction);
      if (result !== undefined) {
        throw new TypeError("audio backend.apply must complete synchronously without a return value");
      }
    } catch (error) {
      this.#fault = { transactionId: transaction.transactionId };
      throw error;
    }
    this.#nextTransactionId += 1;
  }

  #assertLive() {
    this.#assertNotFaulted();
    if (this.#disposed) throw new Error("audio renderer is disposed");
  }

  #assertNotFaulted() {
    if (this.#fault !== null) throw new Error("audio renderer is permanently faulted");
  }
}

export function createProductionAudioRenderer(optionsValue) {
  const options = optionRecord(optionsValue);
  if (Object.hasOwn(options, "manifest") || Object.hasOwn(options, "shippedAudioFiles")) {
    throw new TypeError("production audio renderer does not accept custom provenance");
  }
  const trustedOptions = Object.freeze(options);
  productionRendererOptions.add(trustedOptions);
  return new AudioRenderer(trustedOptions);
}
