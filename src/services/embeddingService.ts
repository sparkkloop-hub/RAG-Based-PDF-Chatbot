import type { DocumentChunk, VectorRecord } from '../types';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSION = 768;

const BATCH_SIZE = 20;
const INTER_BATCH_DELAY_MS = 300;
const MIN_CHUNK_CHARS = 20;
const MAX_CHUNK_CHARS = 2000;
const MAX_BATCH_RETRIES = 3; // exponential backoff: 1s, 2s, 4s
const MAX_RATE_LIMIT_RETRIES = 6;

class EmbeddingRequestError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  model: string;
  batchIndex: number;
  fatal: boolean;

  constructor(params: {
    message: string;
    status: number;
    code: string;
    retryAfterSeconds?: number;
    model?: string;
    batchIndex: number;
    fatal?: boolean;
  }) {
    super(params.message);
    this.name = 'EmbeddingRequestError';
    this.status = params.status;
    this.code = params.code;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.model = params.model ?? EMBEDDING_MODEL;
    this.batchIndex = params.batchIndex;
    this.fatal = Boolean(params.fatal);
  }
}

export interface EmbedDocumentChunksResult {
  records: VectorRecord[];
  skippedCount: number;
  skippedChunkIds: string[];
  filteredOutCount: number;
  totalPrepared: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Embedding cancelled.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Embedding cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function isRateLimitError(err: unknown): err is EmbeddingRequestError {
  if (err instanceof EmbeddingRequestError) {
    const lower = err.message.toLowerCase();
    return (
      err.status === 429 ||
      err.code === 'RATE_LIMITED' ||
      lower.includes('resource_exhausted') ||
      lower.includes('rate limit')
    );
  }
  return false;
}

function isFatalConfigError(status: number, code: string, message: string): boolean {
  const lower = message.toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    code === 'API_KEY_INVALID' ||
    code === 'MISSING_API_KEY' ||
    code === 'INVALID_MODEL' ||
    lower.includes('model not found') ||
    lower.includes('is not found')
  );
}

/**
 * Clean chunks before embedding while keeping chunk metadata strictly aligned:
 * - Trim whitespace
 * - Drop empty chunks and chunks shorter than 20 characters
 * - Cap each chunk at 2000 characters
 */
export function prepareChunksForEmbedding(chunks: DocumentChunk[]): {
  cleanedChunks: DocumentChunk[];
  filteredOutCount: number;
} {
  const cleanedChunks: DocumentChunk[] = [];
  let filteredOutCount = 0;

  for (const chunk of chunks) {
    const trimmed = chunk.text.replace(/\0/g, '').trim();
    if (trimmed.length < MIN_CHUNK_CHARS) {
      filteredOutCount++;
      continue;
    }

    const capped =
      trimmed.length > MAX_CHUNK_CHARS ? trimmed.slice(0, MAX_CHUNK_CHARS).trim() : trimmed;
    if (capped.length < MIN_CHUNK_CHARS) {
      filteredOutCount++;
      continue;
    }

    cleanedChunks.push({
      ...chunk,
      text: capped,
    });
  }

  return { cleanedChunks, filteredOutCount };
}

function validateEmbeddingVectors(
  rawEmbeddings: unknown,
  expectedCount: number,
  expectedDimension = EMBEDDING_DIMENSION
): number[][] | null {
  if (!Array.isArray(rawEmbeddings) || rawEmbeddings.length !== expectedCount) {
    return null;
  }

  const vectors: number[][] = [];
  for (let i = 0; i < rawEmbeddings.length; i++) {
    const vec = rawEmbeddings[i];
    if (
      !Array.isArray(vec) ||
      vec.length !== expectedDimension ||
      vec.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      return null;
    }
    vectors.push(vec as number[]);
  }

  return vectors;
}

function parseRetrySecondsFromMessage(msg: string): number | undefined {
  const match = msg.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/i);
  if (!match) return undefined;
  const secs = Math.ceil(Number(match[1]));
  return Number.isFinite(secs) && secs > 0 ? secs : undefined;
}

async function callEmbedEndpoint(
  texts: string[],
  taskType: EmbeddingTaskType,
  batchIndex: number,
  signal?: AbortSignal
): Promise<number[][]> {
  if (signal?.aborted) {
    throw new DOMException('Embedding cancelled.', 'AbortError');
  }

  let response: Response;
  try {
    response = await fetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, taskType, batchIndex }),
      signal,
    });
  } catch (networkErr) {
    if (isAbortError(networkErr)) throw networkErr;
    const msg =
      networkErr instanceof Error
        ? networkErr.message
        : 'Network error while contacting the embedding server.';
    console.error('[embeddingService] network error:', {
      status: 0,
      message: msg,
      batchIndex,
      batchSize: texts.length,
      model: EMBEDDING_MODEL,
      error: networkErr,
    });
    throw new EmbeddingRequestError({
      message: `Network error during embedding: ${msg}`,
      status: 0,
      code: 'NETWORK_ERROR',
      batchIndex,
      model: EMBEDDING_MODEL,
    });
  }

  if (response.ok) {
    let data: { embeddings?: unknown; model?: string; dimension?: number };
    try {
      data = (await response.json()) as {
        embeddings?: unknown;
        model?: string;
        dimension?: number;
      };
    } catch (parseErr) {
      console.error('[embeddingService] JSON parse error:', {
        status: response.status,
        message: 'Could not parse JSON embedding response.',
        batchIndex,
        batchSize: texts.length,
        model: EMBEDDING_MODEL,
        error: parseErr,
      });
      throw new EmbeddingRequestError({
        message: 'Received an unreadable embedding response from the server.',
        status: response.status,
        code: 'INVALID_JSON',
        batchIndex,
        model: EMBEDDING_MODEL,
      });
    }

    const validated = validateEmbeddingVectors(data.embeddings, texts.length, EMBEDDING_DIMENSION);
    if (!validated) {
      const receivedCount = Array.isArray(data.embeddings) ? data.embeddings.length : 0;
      const firstLen =
        Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])
          ? data.embeddings[0].length
          : 0;
      const msg = `Embedding response was incomplete: received ${receivedCount} of ${texts.length} vectors (dimension ${firstLen}, expected ${EMBEDDING_DIMENSION}) from model "${data.model ?? EMBEDDING_MODEL}".`;
      console.error('[embeddingService] validation failed:', {
        status: response.status,
        message: msg,
        batchIndex,
        batchSize: texts.length,
        receivedCount,
        firstLen,
        expectedDimension: EMBEDDING_DIMENSION,
        model: data.model ?? EMBEDDING_MODEL,
      });
      throw new EmbeddingRequestError({
        message: msg,
        status: 502,
        code: 'INCOMPLETE_EMBEDDING',
        batchIndex,
        model: data.model ?? EMBEDDING_MODEL,
      });
    }

    return validated;
  }

  const errBody = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    status?: number;
    retryAfterSeconds?: number;
    model?: string;
  };

  const modelUsed = errBody.model || EMBEDDING_MODEL;
  const code = errBody.code || `HTTP_${response.status}`;
  let message =
    typeof errBody.error === 'string' && errBody.error.trim().length > 0
      ? errBody.error.trim()
      : `Embedding request failed with status ${response.status}.`;

  if (response.status === 404 || code === 'INVALID_MODEL') {
    if (!message.includes(modelUsed)) {
      message = `Embedding model "${modelUsed}" is invalid or unavailable.`;
    }
  }

  const headerRetry = Number(response.headers.get('Retry-After'));
  const retryAfterSeconds =
    typeof errBody.retryAfterSeconds === 'number' && errBody.retryAfterSeconds > 0
      ? errBody.retryAfterSeconds
      : Number.isFinite(headerRetry) && headerRetry > 0
      ? Math.ceil(headerRetry)
      : parseRetrySecondsFromMessage(message);

  console.error('[embeddingService] request error:', {
    status: response.status,
    code,
    message,
    retryAfterSeconds: retryAfterSeconds ?? null,
    batchIndex,
    batchSize: texts.length,
    model: modelUsed,
    responseBody: errBody,
  });

  throw new EmbeddingRequestError({
    message,
    status: response.status,
    code,
    retryAfterSeconds,
    model: modelUsed,
    batchIndex,
    fatal: isFatalConfigError(response.status, code, message),
  });
}

async function fetchBatchWithRetry(
  texts: string[],
  taskType: EmbeddingTaskType,
  batchIndex: number,
  onRateLimitWait?: (waitSeconds: number) => void,
  signal?: AbortSignal
): Promise<number[][]> {
  let standardAttempt = 0;
  let rateLimitAttempt = 0;
  let lastError: unknown;

  while (true) {
    try {
      return await callEmbedEndpoint(texts, taskType, batchIndex, signal);
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error('Embedding cancelled.');
      }

      lastError = err;

      // Fatal configuration errors (invalid model / invalid API key) stop immediately
      if (err instanceof EmbeddingRequestError && err.fatal) {
        throw err;
      }

      // Rate limits (HTTP 429 / RESOURCE_EXHAUSTED): wait and resume the same batch
      if (isRateLimitError(err)) {
        rateLimitAttempt++;
        if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }
        const fallbackWait = Math.min(30, 10 + (rateLimitAttempt - 1) * 7); // 10s, 17s, 24s, 30s...
        const waitSeconds =
          err.retryAfterSeconds && err.retryAfterSeconds > 0
            ? Math.min(60, Math.max(5, err.retryAfterSeconds))
            : fallbackWait;

        onRateLimitWait?.(waitSeconds);
        await sleep(waitSeconds * 1000, signal);
        continue;
      }

      // Non-rate-limit failures: retry up to 3 times with exponential backoff (1s, 2s, 4s)
      if (standardAttempt >= MAX_BATCH_RETRIES) {
        throw lastError;
      }

      const backoffMs = 1000 * Math.pow(2, standardAttempt); // 1000ms, 2000ms, 4000ms
      standardAttempt++;
      await sleep(backoffMs, signal);
    }
  }
}

/**
 * Embed document chunks in sequential batches of 20 with:
 * - Cleaning & length capping aligned to metadata
 * - Exact dimension validation (768)
 * - 3x exponential backoff (1s, 2s, 4s) per batch
 * - Recursive batch splitting down to single chunks on persistent failure
 * - Single-chunk skip fallback (never fails the entire document for one bad chunk)
 * - Rate-limit pause & resume from the same batch
 */
export async function embedDocumentChunks(
  rawChunks: DocumentChunk[],
  onProgress?: (progress: number, detail: string) => void,
  signal?: AbortSignal
): Promise<EmbedDocumentChunksResult> {
  const { cleanedChunks, filteredOutCount } = prepareChunksForEmbedding(rawChunks);

  if (cleanedChunks.length === 0) {
    return {
      records: [],
      skippedCount: 0,
      skippedChunkIds: [],
      filteredOutCount,
      totalPrepared: 0,
    };
  }

  const totalPrepared = cleanedChunks.length;
  const records: VectorRecord[] = [];
  const skippedChunkIds: string[] = [];
  let processedCount = 0;

  const emitChunkProgress = (customDetail?: string) => {
    const pct = Math.min(100, Math.round((processedCount / totalPrepared) * 100));
    onProgress?.(pct, customDetail ?? `Embedding ${processedCount} / ${totalPrepared} chunks`);
  };

  const embedSliceResilient = async (
    slice: DocumentChunk[],
    batchIndex: number
  ): Promise<void> => {
    if (slice.length === 0) return;

    emitChunkProgress();

    try {
      const vectors = await fetchBatchWithRetry(
        slice.map((c) => c.text),
        'RETRIEVAL_DOCUMENT',
        batchIndex,
        (waitSeconds) => {
          emitChunkProgress(
            `Waiting for rate limit (${waitSeconds}s)... (${processedCount} / ${totalPrepared} chunks)`
          );
        },
        signal
      );

      for (let i = 0; i < slice.length; i++) {
        records.push({
          ...slice[i],
          embedding: vectors[i],
        });
      }
      processedCount += slice.length;
      emitChunkProgress();
    } catch (err) {
      if (isAbortError(err) || (err instanceof Error && err.message === 'Embedding cancelled.')) {
        throw err;
      }

      // Surface fatal config/auth/invalid-model errors immediately
      if (err instanceof EmbeddingRequestError && err.fatal) {
        throw err;
      }

      // If batch has more than 1 chunk, split in half and retry each half sequentially
      if (slice.length > 1) {
        const mid = Math.floor(slice.length / 2);
        console.warn('[embeddingService] splitting failed batch in half:', {
          batchIndex,
          batchSize: slice.length,
          leftSize: mid,
          rightSize: slice.length - mid,
          error: err,
        });
        await sleep(INTER_BATCH_DELAY_MS, signal);
        await embedSliceResilient(slice.slice(0, mid), batchIndex);
        await sleep(INTER_BATCH_DELAY_MS, signal);
        await embedSliceResilient(slice.slice(mid), batchIndex);
        return;
      }

      // Single chunk still failed after retries: record as skipped and continue
      const badChunk = slice[0];
      skippedChunkIds.push(badChunk.id);
      processedCount += 1;
      console.error('[embeddingService] skipping unembeddable chunk:', {
        batchIndex,
        chunkId: badChunk.id,
        fileName: badChunk.fileName,
        pageNumber: badChunk.pageNumber,
        chunkLength: badChunk.text.length,
        error: err,
      });
      emitChunkProgress();
    }
  };

  const totalBatches = Math.ceil(totalPrepared / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const batch = cleanedChunks.slice(start, start + BATCH_SIZE);

    await embedSliceResilient(batch, batchIdx);

    if (batchIdx < totalBatches - 1) {
      await sleep(INTER_BATCH_DELAY_MS, signal);
    }
  }

  onProgress?.(
    100,
    skippedChunkIds.length > 0
      ? `Embedded ${records.length} / ${totalPrepared} chunks (${skippedChunkIds.length} skipped)`
      : `Embedding ${records.length} / ${totalPrepared} chunks`
  );

  return {
    records,
    skippedCount: skippedChunkIds.length,
    skippedChunkIds,
    filteredOutCount,
    totalPrepared,
  };
}

/**
 * Embed a search query using the exact same model (gemini-embedding-001) and
 * outputDimensionality (768) as document chunks.
 */
export async function embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
  const cleaned = query.replace(/\0/g, '').trim().slice(0, MAX_CHUNK_CHARS).trim();
  if (!cleaned) {
    throw new Error('Query cannot be empty.');
  }

  const [embedding] = await fetchBatchWithRetry(
    [cleaned],
    'RETRIEVAL_QUERY',
    0,
    undefined,
    signal
  );

  if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Query embedding returned an invalid dimension using model "${EMBEDDING_MODEL}".`
    );
  }

  return embedding;
}
