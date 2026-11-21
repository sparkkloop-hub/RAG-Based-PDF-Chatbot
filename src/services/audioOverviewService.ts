import type {
  AudioOverviewCacheRecord,
  AudioOverviewSegmentRange,
  AudioOverviewSpeaker,
  AudioOverviewTurn,
  DocumentChunk,
  DocumentRecord,
  GeminiVoiceName,
  ResponseLanguage,
} from '../types';
import { getAudioOverviewCache, saveAudioOverviewCache } from './storageService';
import { vectorStore } from './vectorStore';

export const DEFAULT_HOST_A_VOICE: GeminiVoiceName = 'Kore';
export const DEFAULT_HOST_B_VOICE: GeminiVoiceName = 'Puck';

/**
 * Deterministic 64-bit hash key over selected documents + language + voice pair.
 */
export function computeAudioOverviewCacheKey(
  docs: DocumentRecord[],
  language: ResponseLanguage,
  voiceA: GeminiVoiceName,
  voiceB: GeminiVoiceName
): string {
  const docFingerprints = [...docs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => `${d.id}:${d.chunkCount}:${d.characterCount}`)
    .join('|');

  const input = `ao_v1::${language}::${voiceA}::${voiceB}::${docFingerprints}`;
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `ao_${(h2 >>> 0).toString(16)}_${(h1 >>> 0).toString(16)}`;
}

// ---------- WAV binary helpers ----------

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isRiffWave(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

export interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationSec: number;
}

export function parseWavInfo(bytes: Uint8Array): WavInfo {
  const fallbackRate = 24000;
  const fallbackChannels = 1;
  const fallbackBits = 16;

  if (!isRiffWave(bytes)) {
    const byteRate = (fallbackRate * fallbackChannels * fallbackBits) / 8;
    return {
      sampleRate: fallbackRate,
      numChannels: fallbackChannels,
      bitsPerSample: fallbackBits,
      dataOffset: 0,
      dataLength: bytes.byteLength,
      durationSec: bytes.byteLength / byteRate,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = fallbackRate;
  let numChannels = fallbackChannels;
  let bitsPerSample = fallbackBits;
  let dataOffset = 44;
  let dataLength = Math.max(0, bytes.byteLength - 44);

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ' && offset + 24 <= bytes.byteLength) {
      numChannels = view.getUint16(offset + 10, true) || fallbackChannels;
      sampleRate = view.getUint32(offset + 12, true) || fallbackRate;
      bitsPerSample = view.getUint16(offset + 22, true) || fallbackBits;
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, bytes.byteLength - dataOffset);
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const byteRate = Math.max(1, (sampleRate * numChannels * bitsPerSample) / 8);
  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    dataOffset,
    dataLength,
    durationSec: dataLength / byteRate,
  };
}

function buildWavFromPcm(
  pcmData: Uint8Array,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16
): Uint8Array {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.byteLength;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmData);
  return new Uint8Array(buffer);
}

function base64ToWavBlobWithDuration(base64Audio: string): { blob: Blob; durationSec: number } {
  const raw = base64ToUint8Array(base64Audio);
  const wavBytes = isRiffWave(raw) ? raw : buildWavFromPcm(raw);
  const info = parseWavInfo(wavBytes);
  return {
    blob: new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
    durationSec: Math.max(0.5, info.durationSec),
  };
}

/**
 * Concatenate multiple WAV chunk blobs into a single valid WAV file for download.
 */
export async function concatenateWavBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) {
    throw new Error('No audio segments are available to download.');
  }
  if (blobs.length === 1) {
    return blobs[0];
  }

  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const segments = buffers.map((ab) => {
    const bytes = new Uint8Array(ab);
    const info = parseWavInfo(bytes);
    return {
      info,
      pcm: bytes.subarray(info.dataOffset, info.dataOffset + info.dataLength),
    };
  });

  const first = segments[0].info;
  const totalPcmBytes = segments.reduce((sum, s) => sum + s.pcm.byteLength, 0);
  const combinedPcm = new Uint8Array(totalPcmBytes);

  let writeOffset = 0;
  for (const seg of segments) {
    combinedPcm.set(seg.pcm, writeOffset);
    writeOffset += seg.pcm.byteLength;
  }

  const finalWav = buildWavFromPcm(
    combinedPcm,
    first.sampleRate,
    first.numChannels,
    first.bitsPerSample
  );
  return new Blob([finalWav.buffer as ArrayBuffer], { type: 'audio/wav' });
}

// ---------- API retry helper ----------

async function postJsonWithRetry<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  maxAttempts = 4
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      const errJson = await res.json().catch(() => ({ error: res.statusText }));
      const message =
        typeof errJson?.error === 'string'
          ? errJson.error
          : `Request failed (${res.status}).`;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts - 1) {
        throw new Error(message);
      }
      lastError = new Error(message);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      const errObj = err instanceof Error ? err : new Error(String(err));
      lastError = errObj;
      if (attempt === maxAttempts - 1) {
        throw errObj;
      }
    }

    const delayMs = Math.min(900 * Math.pow(2, attempt) + Math.random() * 350, 7500);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  }

  throw lastError ?? new Error('Unable to complete request.');
}

// ---------- Context preparation (map-reduce over chunks) ----------

function groupChunksIntoBatches(
  chunks: DocumentChunk[],
  maxBatchChars = 8500
): DocumentChunk[][] {
  const batches: DocumentChunk[][] = [];
  let current: DocumentChunk[] = [];
  let chars = 0;

  for (const chunk of chunks) {
    if (chars + chunk.text.length > maxBatchChars && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += chunk.text.length;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

async function buildAudioOverviewContext(
  docIds: string[],
  onStatus: (detail: string, percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  await vectorStore.hydrate();
  const chunks = vectorStore.getChunks(docIds.length > 0 ? docIds : undefined);
  if (chunks.length === 0) {
    throw new Error('No document content is indexed yet. Upload a PDF first.');
  }

  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  if (totalChars <= 16000) {
    onStatus('Reading document excerpts...', 18);
    return chunks
      .map((c) => `[${c.fileName} | Page ${c.pageNumber}]\n${c.text}`)
      .join('\n\n---\n\n');
  }

  // Map-reduce condensation for larger documents (cap evenly at 8 batches)
  const allBatches = groupChunksIntoBatches(chunks, 8500);
  const workingBatches =
    allBatches.length > 8
      ? Array.from({ length: 8 }, (_, i) =>
          allBatches[Math.floor((i * allBatches.length) / 8)]
        )
      : allBatches;

  const distilledNotes: string[] = [];

  for (let i = 0; i < workingBatches.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const pct = Math.round(8 + ((i + 0.5) / workingBatches.length) * 32);
    onStatus(`Reviewing section ${i + 1} of ${workingBatches.length}...`, pct);

    const sectionText = workingBatches[i]
      .map((c) => `[${c.fileName} | Page ${c.pageNumber}]\n${c.text}`)
      .join('\n\n');

    const res = await postJsonWithRetry<{ text?: string }>(
      '/api/generate',
      {
        systemInstruction:
          'You are extracting factual key points, concrete examples, numbers, and conclusions strictly from the provided document excerpts for a spoken audio overview. Never invent facts or add external knowledge.',
        prompt: `Extract concise bullet notes of the main ideas, explanations, and examples from section ${i + 1} of ${workingBatches.length}:\n\n${sectionText}`,
      },
      signal
    );

    if (res.text?.trim()) {
      distilledNotes.push(`### Section ${i + 1}\n${res.text.trim()}`);
    }
  }

  if (distilledNotes.length === 0) {
    throw new Error('Could not extract notes from the selected documents.');
  }

  return distilledNotes.join('\n\n---\n\n');
}

// ---------- Script generation ----------

function cleanSpokenLine(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(Host\s*[AB]|Speaker\s*[AB])\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generateAudioOverviewScript(
  docIds: string[],
  language: ResponseLanguage,
  onStatus: (detail: string, percent: number) => void,
  signal?: AbortSignal
): Promise<AudioOverviewTurn[]> {
  const context = await buildAudioOverviewContext(docIds, onStatus, signal);

  onStatus('Writing host conversation script...', 55);

  const langRules =
    language === 'ta'
      ? `LANGUAGE REQUIREMENT (TAMIL):
- Write the entire spoken dialogue in natural, warm, everyday spoken Tamil using Tamil script (தமிழ்).
- Avoid stiff literary prose; make it sound like two thoughtful Tamil speakers having a clear, engaging discussion.
- Keep technical terms or proper nouns clear and natural as spoken in Tamil.
- Still use the exact English JSON speaker keys "Host A" and "Host B".`
      : `LANGUAGE REQUIREMENT (ENGLISH):
- Write the entire spoken dialogue in clear, natural, plain spoken English.
- Keep sentences easy to follow aloud; avoid jargon unless you explain it simply right away.`;

  const systemInstruction = `You are writing a podcast-style Audio Overview script for two hosts, "Host A" and "Host B", discussing the user's uploaded documents.

STRICT GROUNDING RULES:
1. Ground EVERY statement, claim, figure, and example ONLY in the provided DOCUMENT CONTENT.
2. Never invent facts, statistics, external studies, or claims not supported by the documents.
3. If an example is used to explain a point, base it strictly on the document's concepts and details.

SCRIPT STRUCTURE & LENGTH:
- Target length: 4 to 6 minutes when spoken aloud (approximately 680 to 880 words across 18 to 24 alternating turns).
- Opening (2 turns): Short, welcoming intro stating what the document(s) are about.
- Main body (14 to 20 turns): Walk through 3 to 5 key points from the document(s) in plain language, explaining each with simple examples and natural back-and-forth questions between Host A and Host B.
- Wrap-up (2 turns): Brief summary of the core takeaways.
- Plain spoken text only: NO markdown, NO bullet points, NO emojis, NO stage directions like [laughs] or (pause).

${langRules}

OUTPUT FORMAT:
Return a JSON array of objects: [{"speaker": "Host A" | "Host B", "text": "..."}].`;

  const res = await postJsonWithRetry<{ text?: string }>(
    '/api/generate',
    {
      systemInstruction,
      prompt: `Create the Audio Overview conversation strictly from this document content:\n\n${context}`,
      schemaType: 'audio_overview_script',
    },
    signal
  );

  const rawJson = (res.text ?? '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    const match = rawJson.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error('The script response could not be parsed. Try generating again.');
    }
    parsed = JSON.parse(match[0]);
  }

  const rawItems: Array<{ speaker?: string; text?: string }> = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { script?: unknown }).script)
    ? ((parsed as { script: Array<{ speaker?: string; text?: string }> }).script)
    : [];

  const turns: AudioOverviewTurn[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const text = typeof item?.text === 'string' ? cleanSpokenLine(item.text) : '';
    if (!text) continue;
    const rawSpeaker = typeof item?.speaker === 'string' ? item.speaker.trim() : '';
    const speaker: AudioOverviewSpeaker =
      rawSpeaker === 'Host B' || rawSpeaker.toLowerCase().includes('b')
        ? 'Host B'
        : rawSpeaker === 'Host A' || rawSpeaker.toLowerCase().includes('a')
        ? 'Host A'
        : i % 2 === 0
        ? 'Host A'
        : 'Host B';
    turns.push({ speaker, text });
  }

  if (turns.length === 0) {
    throw new Error('No dialogue lines were produced from the selected documents.');
  }

  onStatus('Script ready', 100);
  return turns;
}

// ---------- Segmenting turns for progressive multi-speaker TTS ----------

export function groupTurnsIntoAudioSegments(
  script: AudioOverviewTurn[],
  maxTurnsPerSegment = 4,
  maxCharsPerSegment = 800
): AudioOverviewSegmentRange[] {
  const ranges: AudioOverviewSegmentRange[] = [];
  let start = 0;

  while (start < script.length) {
    let end = start;
    let chars = 0;

    while (end < script.length && end - start < maxTurnsPerSegment) {
      const len = script[end].text.length;
      if (end > start && chars + len > maxCharsPerSegment) {
        break;
      }
      chars += len;
      end++;
    }

    ranges.push({ startTurn: start, endTurn: end });
    start = end;
  }

  return ranges;
}

export async function generateMultiSpeakerSegmentAudio(params: {
  turns: AudioOverviewTurn[];
  voiceA: GeminiVoiceName;
  voiceB: GeminiVoiceName;
  language: ResponseLanguage;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; durationSec: number }> {
  const res = await postJsonWithRetry<{ audioBase64?: string; mimeType?: string }>(
    '/api/tts/multi',
    {
      turns: params.turns,
      voiceA: params.voiceA,
      voiceB: params.voiceB,
      language: params.language,
    },
    params.signal,
    4
  );

  if (!res.audioBase64) {
    throw new Error('Gemini voice synthesis returned an empty audio segment.');
  }

  return base64ToWavBlobWithDuration(res.audioBase64);
}

/**
 * Compute per-turn start/end timestamps within the timeline based on actual chunk durations.
 */
export function computeTurnTimeRanges(
  script: AudioOverviewTurn[],
  segmentRanges: AudioOverviewSegmentRange[],
  chunkDurations: number[]
): Array<{ startSec: number; endSec: number; segmentIndex: number }> {
  const result: Array<{ startSec: number; endSec: number; segmentIndex: number }> = [];
  let cursor = 0;

  for (let segIdx = 0; segIdx < segmentRanges.length; segIdx++) {
    const range = segmentRanges[segIdx];
    const segDuration = chunkDurations[segIdx] ?? 0;
    const slice = script.slice(range.startTurn, range.endTurn);
    const totalWeight = slice.reduce((sum, t) => sum + Math.max(12, t.text.length), 0) || 1;

    let innerCursor = cursor;
    for (let i = 0; i < slice.length; i++) {
      const weight = Math.max(12, slice[i].text.length) / totalWeight;
      const dur = segDuration * weight;
      result.push({
        startSec: innerCursor,
        endSec: innerCursor + dur,
        segmentIndex: segIdx,
      });
      innerCursor += dur;
    }

    cursor += segDuration;
  }

  return result;
}

export { getAudioOverviewCache, saveAudioOverviewCache };
export type { AudioOverviewCacheRecord };
