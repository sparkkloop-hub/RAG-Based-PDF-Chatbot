import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { GroundedSearchError, VectorRecord } from '../types';
import { ttsService } from './ttsService';
import { vectorStore } from './vectorStore';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface HealthModelConfig {
  chat: string;
  embedding: string;
  embeddingDimension: number;
  tts: string;
  multiTts: string;
  searchGrounding: string[];
}

export const DEFAULT_MODEL_CONFIG: HealthModelConfig = {
  chat: 'gemini-3.1-flash-lite',
  embedding: 'gemini-embedding-001',
  embeddingDimension: 768,
  tts: 'gemini-3.8-flash-lite-tts',
  multiTts: 'gemini-3.8-flash-tts',
  searchGrounding: ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
};

export type HealthCheckId =
  | 'chat'
  | 'embedding'
  | 'vector-store'
  | 'tts-gemini'
  | 'search-grounding'
  | 'browser-speech'
  | 'microphone'
  | 'pdf-worker';

export type HealthCheckStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface HealthCheckResult {
  id: HealthCheckId;
  name: string;
  model: string;
  status: HealthCheckStatus;
  durationMs: number | null;
  summary: string;
  explanation: string | null;
  rawStatus: string | null;
  rawError: string | null;
  checkedAt: number | null;
}

export const HEALTH_CHECK_ORDER: HealthCheckId[] = [
  'chat',
  'embedding',
  'vector-store',
  'tts-gemini',
  'search-grounding',
  'browser-speech',
  'microphone',
  'pdf-worker',
];

export function createInitialHealthChecks(config: HealthModelConfig): HealthCheckResult[] {
  return [
    {
      id: 'chat',
      name: 'Chat model',
      model: config.chat,
      status: 'idle',
      durationMs: null,
      summary: 'One-word reply via /api/generate',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'embedding',
      name: 'Embedding model',
      model: config.embedding,
      status: 'idle',
      durationMs: null,
      summary: 'Embed one short sentence via /api/embed',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'vector-store',
      name: 'Vector store',
      model: 'IndexedDB (local)',
      status: 'idle',
      durationMs: null,
      summary: 'Write, search, and delete a test vector',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'tts-gemini',
      name: 'TTS (Gemini)',
      model: config.tts,
      status: 'idle',
      durationMs: null,
      summary: 'Generate short English audio via /api/tts',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'search-grounding',
      name: 'Search grounding',
      model: config.searchGrounding.join(', '),
      status: 'idle',
      durationMs: null,
      summary: 'One grounded query via /api/extra-info',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'browser-speech',
      name: 'Browser speech',
      model: 'Web Speech Synthesis',
      status: 'idle',
      durationMs: null,
      summary: 'Available voices and Tamil voice support',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'microphone',
      name: 'Microphone / SpeechRecognition',
      model: 'Web Speech API',
      status: 'idle',
      durationMs: null,
      summary: 'Browser voice input and microphone support',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
    {
      id: 'pdf-worker',
      name: 'PDF.js worker',
      model: `pdfjs-dist v${pdfjsLib.version}`,
      status: 'idle',
      durationMs: null,
      summary: 'Load worker and parse a minimal test PDF',
      explanation: null,
      rawStatus: null,
      rawError: null,
      checkedAt: null,
    },
  ];
}

/**
 * Fetches server model configuration metadata from /api/health without invoking any Gemini API.
 */
export async function fetchHealthModelConfig(): Promise<HealthModelConfig> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_MODEL_CONFIG;
    const data = (await res.json()) as { models?: Partial<HealthModelConfig> };
    const m = data.models;
    if (!m) return DEFAULT_MODEL_CONFIG;

    return {
      chat: typeof m.chat === 'string' && m.chat.trim() ? m.chat.trim() : DEFAULT_MODEL_CONFIG.chat,
      embedding:
        typeof m.embedding === 'string' && m.embedding.trim()
          ? m.embedding.trim()
          : DEFAULT_MODEL_CONFIG.embedding,
      embeddingDimension:
        typeof m.embeddingDimension === 'number' && m.embeddingDimension > 0
          ? m.embeddingDimension
          : DEFAULT_MODEL_CONFIG.embeddingDimension,
      tts: typeof m.tts === 'string' && m.tts.trim() ? m.tts.trim() : DEFAULT_MODEL_CONFIG.tts,
      multiTts:
        typeof m.multiTts === 'string' && m.multiTts.trim()
          ? m.multiTts.trim()
          : DEFAULT_MODEL_CONFIG.multiTts,
      searchGrounding:
        Array.isArray(m.searchGrounding) && m.searchGrounding.length > 0
          ? m.searchGrounding.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          : DEFAULT_MODEL_CONFIG.searchGrounding,
    };
  } catch {
    return DEFAULT_MODEL_CONFIG;
  }
}

function parseRetrySecondsFromText(text: string): number | undefined {
  const jsonMatch = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (jsonMatch) {
    const secs = Math.ceil(Number(jsonMatch[1]));
    if (Number.isFinite(secs) && secs > 0) return secs;
  }
  const plainMatch = text.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/i);
  if (plainMatch) {
    const secs = Math.ceil(Number(plainMatch[1]));
    if (Number.isFinite(secs) && secs > 0) return secs;
  }
  return undefined;
}

export function explainHealthError(params: {
  httpStatus?: number | null;
  code?: string | null;
  message?: string | null;
  retryAfterSeconds?: number | null;
  isNetworkError?: boolean;
}): string {
  const { httpStatus, code, message, isNetworkError } = params;
  const raw = (message ?? '').trim();
  const lower = raw.toLowerCase();
  const codeUpper = (code ?? '').toUpperCase();

  if (
    isNetworkError ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('load failed') ||
    lower.includes('econnrefused')
  ) {
    return 'Network failure: could not reach the server. Check your internet connection and verify the app server is running.';
  }

  const retrySeconds =
    typeof params.retryAfterSeconds === 'number' && params.retryAfterSeconds > 0
      ? Math.ceil(params.retryAfterSeconds)
      : parseRetrySecondsFromText(raw);

  if (
    httpStatus === 429 ||
    codeUpper === 'RATE_LIMITED' ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return retrySeconds
      ? `Quota or rate limit exceeded. Retry after ${retrySeconds}s.`
      : 'Quota or rate limit exceeded on the Gemini API. Wait a moment or check your API quota.';
  }

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    codeUpper === 'API_KEY_INVALID' ||
    codeUpper === 'MISSING_API_KEY' ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('missing_api_key') ||
    lower.includes('gemini_api_key is not configured') ||
    lower.includes('permission_denied') ||
    lower.includes('authentication failed')
  ) {
    return 'Invalid or missing API key. Check GEMINI_API_KEY in Settings > Secrets.';
  }

  if (
    httpStatus === 404 ||
    codeUpper === 'INVALID_MODEL' ||
    lower.includes('not_found') ||
    lower.includes('model not found') ||
    lower.includes('is not found') ||
    lower.includes('invalid model') ||
    lower.includes('not supported for')
  ) {
    return 'Model not found or unavailable for this API key. Verify the configured model name.';
  }

  if (httpStatus && httpStatus >= 500) {
    return `Server error (HTTP ${httpStatus}). The upstream service may be temporarily unavailable.`;
  }

  return raw || 'Check failed. Expand Details for raw diagnostic output.';
}

function computeAudioDurationSeconds(base64Audio: string): number {
  const binary = atob(base64Audio);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // RIFF....WAVE container
  if (
    len >= 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    const view = new DataView(bytes.buffer);
    const byteRate = view.getUint32(28, true);
    if (byteRate > 0) {
      let offset = 12;
      while (offset + 8 <= len) {
        const chunkId =
          String.fromCharCode(bytes[offset]) +
          String.fromCharCode(bytes[offset + 1]) +
          String.fromCharCode(bytes[offset + 2]) +
          String.fromCharCode(bytes[offset + 3]);
        const chunkSize = view.getUint32(offset + 4, true);
        if (chunkId === 'data') {
          return Math.max(0, chunkSize / byteRate);
        }
        offset += 8 + chunkSize + (chunkSize % 2);
      }
      return Math.max(0, (len - 44) / byteRate);
    }
  }

  // Raw 24kHz 16-bit mono PCM fallback
  return len / (24000 * 2);
}

function buildMinimalPdfBytes(): Uint8Array {
  const parts: string[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const push = (str: string) => {
    parts.push(str);
    cursor += str.length;
  };

  push('%PDF-1.4\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ];

  for (const obj of objects) {
    offsets.push(cursor);
    push(obj);
  }

  const xrefOffset = cursor;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return new TextEncoder().encode(parts.join(''));
}

async function runChatCheck(config: HealthModelConfig): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = { id: 'chat' as const, name: 'Chat model', model: config.chat, checkedAt };

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        prompt: 'Reply with only the single word: OK',
      }),
    });
    const durationMs = Math.round(performance.now() - start);
    const data = (await res.json().catch(() => ({}))) as {
      text?: string;
      model?: string;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };
    const modelUsed = data.model || config.chat;

    if (!res.ok) {
      const retryHeader = Number(res.headers.get('Retry-After'));
      const retryAfter =
        data.retryAfterSeconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null);
      const rawError = data.error || res.statusText || `HTTP ${res.status}`;
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Failed',
        explanation: explainHealthError({
          httpStatus: res.status,
          code: data.code,
          message: rawError,
          retryAfterSeconds: retryAfter,
        }),
        rawStatus: `HTTP ${res.status}${data.code ? ` (${data.code})` : ''}`,
        rawError,
      };
    }

    const reply = (data.text ?? '').trim();
    if (!reply) {
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Empty reply',
        explanation: 'The chat model returned an empty response.',
        rawStatus: `HTTP ${res.status}`,
        rawError: 'Response text was empty.',
      };
    }

    const singleLine = reply.replace(/\s+/g, ' ').slice(0, 48);
    return {
      ...base,
      model: modelUsed,
      status: 'pass',
      durationMs,
      summary: `Reply: "${singleLine}"`,
      explanation: null,
      rawStatus: `HTTP ${res.status} OK`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Network error',
      explanation: explainHealthError({ message: rawError, isNetworkError: true }),
      rawStatus: 'NETWORK_ERROR',
      rawError,
    };
  }
}

async function runEmbeddingCheck(config: HealthModelConfig): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'embedding' as const,
    name: 'Embedding model',
    model: config.embedding,
    checkedAt,
  };

  try {
    const res = await fetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        texts: ['DocuMind health check embedding test sentence.'],
        taskType: 'RETRIEVAL_QUERY',
      }),
    });
    const durationMs = Math.round(performance.now() - start);
    const data = (await res.json().catch(() => ({}))) as {
      embeddings?: number[][];
      model?: string;
      dimension?: number;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };
    const modelUsed = data.model || config.embedding;

    if (!res.ok) {
      const retryHeader = Number(res.headers.get('Retry-After'));
      const retryAfter =
        data.retryAfterSeconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null);
      const rawError = data.error || res.statusText || `HTTP ${res.status}`;
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Failed',
        explanation: explainHealthError({
          httpStatus: res.status,
          code: data.code,
          message: rawError,
          retryAfterSeconds: retryAfter,
        }),
        rawStatus: `HTTP ${res.status}${data.code ? ` (${data.code})` : ''}`,
        rawError,
      };
    }

    const vec = Array.isArray(data.embeddings) ? data.embeddings[0] : null;
    if (!Array.isArray(vec) || vec.length === 0) {
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Empty vector',
        explanation: 'Embedding endpoint returned an empty vector.',
        rawStatus: `HTTP ${res.status}`,
        rawError: 'embeddings[0] was missing or empty.',
      };
    }

    return {
      ...base,
      model: modelUsed,
      status: 'pass',
      durationMs,
      summary: `Dimension: ${vec.length} (expected ${config.embeddingDimension})`,
      explanation: null,
      rawStatus: `HTTP ${res.status} OK`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Network error',
      explanation: explainHealthError({ message: rawError, isNetworkError: true }),
      rawStatus: 'NETWORK_ERROR',
      rawError,
    };
  }
}

async function runVectorStoreCheck(config: HealthModelConfig): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'vector-store' as const,
    name: 'Vector store',
    model: 'IndexedDB (local)',
    checkedAt,
  };

  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testDocId = `__health_check_doc_${token}__`;
  const testVecId = `__health_check_vec_${token}__`;
  const dim = Math.max(8, Math.min(config.embeddingDimension || 768, 768));

  // Build deterministic unit test vector
  const testEmbedding = new Array<number>(dim).fill(0);
  testEmbedding[0] = 0.6;
  testEmbedding[1] = 0.8;

  const testRecord: VectorRecord = {
    id: testVecId,
    docId: testDocId,
    fileName: '__health_check__.pdf',
    pageNumber: 1,
    chunkIndex: 0,
    text: 'DocuMind IndexedDB health check test vector.',
    embedding: testEmbedding,
  };

  let wrote = false;
  try {
    await vectorStore.addVectors([testRecord]);
    wrote = true;

    const hits = await vectorStore.similaritySearch(testEmbedding, {
      docIds: [testDocId],
      topK: 1,
      minScore: 0.9,
    });

    if (hits.length !== 1 || hits[0].id !== testVecId) {
      throw new Error('Test vector was written but not returned by similarity search.');
    }

    const matchScore = hits[0].score;

    await vectorStore.deleteDocumentVectors(testDocId);
    wrote = false;

    const afterDelete = await vectorStore.similaritySearch(testEmbedding, {
      docIds: [testDocId],
      topK: 1,
      minScore: 0.1,
    });

    if (afterDelete.length !== 0) {
      throw new Error('Test vector remained searchable after deletion.');
    }

    const durationMs = Math.round(performance.now() - start);
    return {
      ...base,
      status: 'pass',
      durationMs,
      summary: `Write, search (score ${matchScore.toFixed(2)}), and delete passed`,
      explanation: null,
      rawStatus: `IndexedDB OK (${dim}-dim test vector)`,
      rawError: null,
    };
  } catch (err) {
    if (wrote) {
      await vectorStore.deleteDocumentVectors(testDocId).catch(() => {});
    }
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'IndexedDB operation failed',
      explanation:
        'Browser IndexedDB vector storage failed. Check that site storage is enabled and not in a restricted private mode.',
      rawStatus: 'INDEXEDDB_ERROR',
      rawError,
    };
  }
}

async function runGeminiTtsCheck(config: HealthModelConfig): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'tts-gemini' as const,
    name: 'TTS (Gemini)',
    model: config.tts,
    checkedAt,
  };

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        text: 'DocuMind health check audio test.',
        voiceName: 'Kore',
        language: 'en',
      }),
    });
    const durationMs = Math.round(performance.now() - start);
    const data = (await res.json().catch(() => ({}))) as {
      audioBase64?: string;
      mimeType?: string;
      model?: string;
      voiceName?: string;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };
    const modelUsed = data.model || config.tts;

    if (!res.ok) {
      const retryHeader = Number(res.headers.get('Retry-After'));
      const retryAfter =
        data.retryAfterSeconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null);
      const rawError = data.error || res.statusText || `HTTP ${res.status}`;
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Failed',
        explanation: explainHealthError({
          httpStatus: res.status,
          code: data.code,
          message: rawError,
          retryAfterSeconds: retryAfter,
        }),
        rawStatus: `HTTP ${res.status}${data.code ? ` (${data.code})` : ''}`,
        rawError,
      };
    }

    if (!data.audioBase64) {
      return {
        ...base,
        model: modelUsed,
        status: 'fail',
        durationMs,
        summary: 'Empty audio payload',
        explanation: 'Gemini TTS responded without audio data.',
        rawStatus: `HTTP ${res.status}`,
        rawError: 'audioBase64 was empty.',
      };
    }

    const audioSec = computeAudioDurationSeconds(data.audioBase64);
    return {
      ...base,
      model: modelUsed,
      status: 'pass',
      durationMs,
      summary: `Audio duration: ${audioSec.toFixed(2)}s (${data.voiceName ?? 'Kore'})`,
      explanation: null,
      rawStatus: `HTTP ${res.status} OK (${data.mimeType ?? 'audio/wav'})`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Network error',
      explanation: explainHealthError({ message: rawError, isNetworkError: true }),
      rawStatus: 'NETWORK_ERROR',
      rawError,
    };
  }
}

async function runSearchGroundingCheck(config: HealthModelConfig): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const defaultModelDisplay = config.searchGrounding.join(', ');
  const base = {
    id: 'search-grounding' as const,
    name: 'Search grounding',
    model: defaultModelDisplay,
    checkedAt,
  };

  try {
    const res = await fetch('/api/extra-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        messageId: `health-check-${Date.now()}`,
        question: 'What is the capital city of France and which river runs through it?',
        answer: 'Paris is the capital of France.',
        language: 'en',
      }),
    });
    const durationMs = Math.round(performance.now() - start);
    const data = (await res.json().catch(() => ({}))) as {
      sources?: Array<{ title: string; uri: string; domain: string }>;
      isGeneralKnowledgeFallback?: boolean;
      fallbackNotice?: string;
      groundedErrors?: GroundedSearchError[];
      model?: string;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };

    const groundedErrText =
      Array.isArray(data.groundedErrors) && data.groundedErrors.length > 0
        ? data.groundedErrors
            .map((e) => `${e.model} (HTTP ${e.status ?? 'err'}): ${e.message}`)
            .join('\n')
        : null;

    if (!res.ok) {
      const retryHeader = Number(res.headers.get('Retry-After'));
      const retryAfter =
        data.retryAfterSeconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null);
      const rawError = [data.error || res.statusText || `HTTP ${res.status}`, groundedErrText]
        .filter(Boolean)
        .join('\n');
      return {
        ...base,
        model: data.model || defaultModelDisplay,
        status: 'fail',
        durationMs,
        summary: 'Failed',
        explanation: explainHealthError({
          httpStatus: res.status,
          code: data.code,
          message: rawError,
          retryAfterSeconds: retryAfter,
        }),
        rawStatus: `HTTP ${res.status}${data.code ? ` (${data.code})` : ''}`,
        rawError,
      };
    }

    const sourcesCount = Array.isArray(data.sources) ? data.sources.length : 0;

    if (data.isGeneralKnowledgeFallback) {
      const firstErr = data.groundedErrors?.[0];
      return {
        ...base,
        model: firstErr?.model || defaultModelDisplay,
        status: 'fail',
        durationMs,
        summary: 'No web sources (fell back to ungrounded model)',
        explanation: explainHealthError({
          httpStatus: firstErr?.status ?? null,
          message: firstErr?.message || data.fallbackNotice || 'Live web search failed.',
        }),
        rawStatus: `HTTP ${res.status} (ungrounded fallback)`,
        rawError: groundedErrText || data.fallbackNotice || 'Grounded web search failed.',
      };
    }

    if (sourcesCount === 0) {
      return {
        ...base,
        model: data.model || defaultModelDisplay,
        status: 'fail',
        durationMs,
        summary: '0 web sources returned',
        explanation: 'The grounded query succeeded, but no web sources were returned in groundingMetadata.',
        rawStatus: `HTTP ${res.status} (0 sources)`,
        rawError: groundedErrText || 'groundingMetadata.groundingChunks was empty.',
      };
    }

    return {
      ...base,
      model: data.model || config.searchGrounding[0] || defaultModelDisplay,
      status: 'pass',
      durationMs,
      summary: `${sourcesCount} web ${sourcesCount === 1 ? 'source' : 'sources'} returned`,
      explanation: null,
      rawStatus: `HTTP ${res.status} OK (${sourcesCount} sources)`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Network error',
      explanation: explainHealthError({ message: rawError, isNetworkError: true }),
      rawStatus: 'NETWORK_ERROR',
      rawError,
    };
  }
}

async function runBrowserSpeechCheck(): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'browser-speech' as const,
    name: 'Browser speech',
    model: 'Web Speech Synthesis',
    checkedAt,
  };

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    const durationMs = Math.round(performance.now() - start);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Not supported',
      explanation: 'This browser does not support Web Speech Synthesis (window.speechSynthesis).',
      rawStatus: 'UNSUPPORTED',
      rawError: 'window.speechSynthesis is undefined.',
    };
  }

  try {
    const voices = await ttsService.waitForBrowserVoices(2000);
    const durationMs = Math.round(performance.now() - start);
    const tamilVoices = voices.filter(
      (v) =>
        v.lang.toLowerCase().startsWith('ta') ||
        v.name.toLowerCase().includes('tamil')
    );

    if (voices.length === 0) {
      return {
        ...base,
        status: 'fail',
        durationMs,
        summary: '0 voices available · Tamil: No',
        explanation:
          'SpeechSynthesis API exists, but no system voices were returned within 2 seconds. Use Gemini voice instead.',
        rawStatus: '0_VOICES',
        rawError: 'speechSynthesis.getVoices() returned an empty list after 2000ms.',
      };
    }

    return {
      ...base,
      status: 'pass',
      durationMs,
      summary: `${voices.length} ${voices.length === 1 ? 'voice' : 'voices'} · Tamil voice: ${
        tamilVoices.length > 0 ? `Yes (${tamilVoices.length})` : 'No'
      }`,
      explanation: null,
      rawStatus: `OK (${voices.length} total, ${tamilVoices.length} Tamil)`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Error querying voices',
      explanation: 'Could not query installed browser speech voices.',
      rawStatus: 'SPEECH_ERROR',
      rawError,
    };
  }
}

async function runMicrophoneCheck(): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'microphone' as const,
    name: 'Microphone / SpeechRecognition',
    model: 'Web Speech API',
    checkedAt,
  };

  if (typeof window === 'undefined') {
    return {
      ...base,
      status: 'fail',
      durationMs: 0,
      summary: 'Unavailable',
      explanation: 'Browser window context is not available.',
      rawStatus: 'UNSUPPORTED',
      rawError: 'window is undefined.',
    };
  }

  const win = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const hasStandard = typeof win.SpeechRecognition === 'function';
  const hasWebkit = typeof win.webkitSpeechRecognition === 'function';
  const recognitionImpl = hasStandard
    ? 'SpeechRecognition'
    : hasWebkit
    ? 'webkitSpeechRecognition'
    : null;

  const hasMediaDevices =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';

  let permissionState: string | null = null;
  if (typeof navigator !== 'undefined' && typeof navigator.permissions?.query === 'function') {
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      permissionState = status.state;
    } catch {
      permissionState = null;
    }
  }

  const durationMs = Math.round(performance.now() - start);

  if (!recognitionImpl) {
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'SpeechRecognition unsupported',
      explanation:
        'This browser does not support Web SpeechRecognition. Voice input works best in Chrome or Edge.',
      rawStatus: `UNSUPPORTED (mediaDevices=${hasMediaDevices})`,
      rawError: 'Neither window.SpeechRecognition nor window.webkitSpeechRecognition is available.',
    };
  }

  if (permissionState === 'denied') {
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: `${recognitionImpl} · Permission denied`,
      explanation:
        'Microphone permission is denied for this site. Allow microphone access in browser settings.',
      rawStatus: `PERMISSION_DENIED (${recognitionImpl})`,
      rawError: 'navigator.permissions.query("microphone") returned "denied".',
    };
  }

  const permLabel = permissionState ? `permission: ${permissionState}` : 'permission: unknown';
  const mediaLabel = hasMediaDevices ? 'mic API ready' : 'getUserMedia unavailable';

  return {
    ...base,
    status: 'pass',
    durationMs,
    summary: `${recognitionImpl} supported · ${mediaLabel} (${permLabel})`,
    explanation: null,
    rawStatus: `OK (${recognitionImpl}, ${mediaLabel}, ${permLabel})`,
    rawError: null,
  };
}

async function runPdfWorkerCheck(): Promise<HealthCheckResult> {
  const start = performance.now();
  const checkedAt = Date.now();
  const base = {
    id: 'pdf-worker' as const,
    name: 'PDF.js worker',
    model: `pdfjs-dist v${pdfjsLib.version}`,
    checkedAt,
  };

  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  try {
    // 1. Verify worker script URL is reachable and non-empty
    const workerRes = await fetch(pdfWorkerUrl, { cache: 'no-store' });
    if (!workerRes.ok) {
      throw new Error(`Worker script fetch failed with HTTP ${workerRes.status} (${pdfWorkerUrl}).`);
    }
    const workerText = await workerRes.text();
    if (workerText.length < 100) {
      throw new Error(`Worker script at ${pdfWorkerUrl} appears empty or truncated.`);
    }

    // 2. Parse a minimal 1-page PDF through the real PDF.js worker
    loadingTask = pdfjsLib.getDocument({
      data: buildMinimalPdfBytes(),
      useSystemFonts: true,
    });
    const pdfDoc = await loadingTask.promise;
    const pages = pdfDoc.numPages;

    if (pages !== 1) {
      throw new Error(`Expected 1 page from test PDF, got ${pages}.`);
    }

    const durationMs = Math.round(performance.now() - start);
    return {
      ...base,
      status: 'pass',
      durationMs,
      summary: `Worker loaded & parsed test PDF (${pages} page)`,
      explanation: null,
      rawStatus: `HTTP ${workerRes.status} OK (worker ${(workerText.length / 1024).toFixed(0)} KB)`,
      rawError: null,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'fail',
      durationMs,
      summary: 'Worker failed to load',
      explanation: explainHealthError({
        message: rawError,
        isNetworkError: rawError.toLowerCase().includes('failed to fetch'),
      }),
      rawStatus: 'PDF_WORKER_ERROR',
      rawError,
    };
  } finally {
    if (loadingTask) {
      await loadingTask.destroy().catch(() => {});
    }
  }
}

/**
 * Executes a single live health check (never cached).
 */
export async function runSingleHealthCheck(
  id: HealthCheckId,
  config: HealthModelConfig
): Promise<HealthCheckResult> {
  switch (id) {
    case 'chat':
      return runChatCheck(config);
    case 'embedding':
      return runEmbeddingCheck(config);
    case 'vector-store':
      return runVectorStoreCheck(config);
    case 'tts-gemini':
      return runGeminiTtsCheck(config);
    case 'search-grounding':
      return runSearchGroundingCheck(config);
    case 'browser-speech':
      return runBrowserSpeechCheck();
    case 'microphone':
      return runMicrophoneCheck();
    case 'pdf-worker':
      return runPdfWorkerCheck();
  }
}

/**
 * Formats all current health check rows as a clean plain-text report for sharing.
 */
export function formatHealthReportText(
  checks: HealthCheckResult[],
  config: HealthModelConfig
): string {
  const lines: string[] = [
    'DocuMind AI — Health Check Report',
    `Generated: ${new Date().toISOString()}`,
    `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    `Configured models: chat=${config.chat}, embedding=${config.embedding}, tts=${config.tts}, search=${config.searchGrounding.join(' | ')}`,
    '',
  ];

  for (const item of checks) {
    const statusLabel = item.status.toUpperCase();
    const timing = item.durationMs !== null ? `${item.durationMs} ms` : 'not run';
    lines.push(`[${statusLabel}] ${item.name}`);
    lines.push(`  Model: ${item.model}`);
    lines.push(`  Response time: ${timing}`);
    lines.push(`  Result: ${item.summary}`);
    if (item.explanation) {
      lines.push(`  Explanation: ${item.explanation}`);
    }
    if (item.rawStatus) {
      lines.push(`  Raw status: ${item.rawStatus}`);
    }
    if (item.rawError) {
      lines.push(`  Raw error: ${item.rawError.replace(/\n/g, ' | ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
