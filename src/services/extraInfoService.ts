import type {
  ExtraInfoRecord,
  GroundedSearchError,
  ResponseLanguage,
  WebSource,
} from '../types';
import {
  deleteExtraInfoCacheByMessageId,
  getExtraInfoCache,
  saveExtraInfoCache,
} from './storageService';

const DEFAULT_QUOTA_COOLDOWN_SEC = 30;
const CACHE_KEY_VERSION = 'v2';
const FALLBACK_NOTICE =
  "Live web search is unavailable right now. This is from the AI's general knowledge and is not verified.";

// Fast in-memory cache backed by IndexedDB (only stores verified, on-topic grounded results)
const memoryCache = new Map<string, ExtraInfoRecord>();

// Deduplicates concurrent in-flight requests per answer+language
const inFlightRequests = new Map<
  string,
  {
    promise: Promise<ExtraInfoRecord>;
    controller: AbortController;
  }
>();

export class ExtraInfoError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly isQuotaError: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      code: string;
      status?: number;
      isQuotaError?: boolean;
      retryAfterSeconds?: number;
    }
  ) {
    super(message);
    this.name = 'ExtraInfoError';
    this.code = options.code;
    this.status = options.status;
    this.isQuotaError = Boolean(options.isQuotaError);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function buildExtraInfoCacheKey(
  messageId: string,
  language: ResponseLanguage
): string {
  return `${CACHE_KEY_VERSION}::${messageId}::${language}`;
}

export function isExtraInfoInFlight(
  messageId: string,
  language: ResponseLanguage
): boolean {
  return inFlightRequests.has(buildExtraInfoCacheKey(messageId, language));
}

export function abortExtraInfoRequest(
  messageId: string,
  language?: ResponseLanguage
): void {
  const keys = language
    ? [buildExtraInfoCacheKey(messageId, language)]
    : [
        buildExtraInfoCacheKey(messageId, 'en'),
        buildExtraInfoCacheKey(messageId, 'ta'),
      ];

  for (const key of keys) {
    const entry = inFlightRequests.get(key);
    if (entry) {
      entry.controller.abort();
      inFlightRequests.delete(key);
    }
  }
}

export function abortAllExtraInfoRequests(): void {
  inFlightRequests.forEach((entry) => entry.controller.abort());
  inFlightRequests.clear();
}

export async function getCachedExtraInfo(
  messageId: string,
  language: ResponseLanguage
): Promise<ExtraInfoRecord | null> {
  const key = buildExtraInfoCacheKey(messageId, language);
  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory;

  try {
    const persisted = await getExtraInfoCache(key);
    // Never serve ungrounded fallback or discarded off-topic entries from cache
    if (
      persisted &&
      persisted.messageId === messageId &&
      !persisted.isGeneralKnowledgeFallback &&
      !persisted.noRelevantInfo
    ) {
      memoryCache.set(key, persisted);
      return persisted;
    }
  } catch {
    // IndexedDB unavailable — fall back to memory cache only
  }

  return null;
}

export async function clearExtraInfoCacheForMessage(messageId: string): Promise<void> {
  abortExtraInfoRequest(messageId);
  memoryCache.delete(buildExtraInfoCacheKey(messageId, 'en'));
  memoryCache.delete(buildExtraInfoCacheKey(messageId, 'ta'));
  try {
    await deleteExtraInfoCacheByMessageId(messageId);
  } catch {
    // Ignore storage cleanup errors
  }
}

function stripRawUrls(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/gi, '$1')
    .replace(/<(?:https?:\/\/|www\.)[^>]+>/gi, '')
    .replace(/\b(?:https?:\/\/|www\.)[^\s)\]>,"']+/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

interface ExtraInfoApiResponse {
  content?: string;
  sources?: WebSource[];
  hasConflict?: boolean;
  noReliableSources?: boolean;
  noRelevantInfo?: boolean;
  isGeneralKnowledgeFallback?: boolean;
  fallbackNotice?: string;
  groundedErrors?: GroundedSearchError[];
  error?: string;
  code?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

export interface FetchExtraInfoParams {
  messageId: string;
  question: string;
  answer: string;
  topicHints?: string[];
  language: ResponseLanguage;
  forceRefresh?: boolean;
}

export async function fetchExtraInfo({
  messageId,
  question,
  answer,
  topicHints = [],
  language,
  forceRefresh = false,
}: FetchExtraInfoParams): Promise<ExtraInfoRecord> {
  const cacheKey = buildExtraInfoCacheKey(messageId, language);

  // Prevent duplicate in-flight requests per answer+language
  const existingInFlight = inFlightRequests.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight.promise;
  }

  if (!forceRefresh) {
    const cached = await getCachedExtraInfo(messageId, language);
    if (cached) {
      return cached;
    }
  }

  const trimmedQuestion = question.trim().slice(0, 1500);
  const trimmedAnswer = answer.trim().slice(0, 4000);
  const cleanTopicHints = topicHints
    .map((h) => h.replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 2);

  const controller = new AbortController();

  const requestPromise = (async (): Promise<ExtraInfoRecord> => {
    try {
      const response = await fetch('/api/extra-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          question: trimmedQuestion,
          answer: trimmedAnswer,
          topicHints: cleanTopicHints,
          language,
        }),
        signal: controller.signal,
      });

      let payload: ExtraInfoApiResponse = {};
      try {
        payload = (await response.json()) as ExtraInfoApiResponse;
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const status = response.status;
        const code = payload.code || (status === 429 ? 'RATE_LIMITED' : 'API_ERROR');
        const isQuotaError = status === 429 || code === 'RATE_LIMITED';
        const retryAfterSeconds =
          typeof payload.retryAfterSeconds === 'number' && payload.retryAfterSeconds > 0
            ? Math.ceil(payload.retryAfterSeconds)
            : isQuotaError
            ? DEFAULT_QUOTA_COOLDOWN_SEC
            : undefined;

        const message =
          payload.error?.trim() ||
          (isQuotaError
            ? 'Gemini API rate limit or quota reached. Please wait before trying again.'
            : `Request failed with status ${status}. Please try again.`);

        throw new ExtraInfoError(message, {
          code,
          status,
          isQuotaError,
          retryAfterSeconds,
        });
      }

      const isGeneralKnowledgeFallback = Boolean(payload.isGeneralKnowledgeFallback);
      const noRelevantInfo = Boolean(payload.noRelevantInfo);

      const sources: WebSource[] =
        isGeneralKnowledgeFallback || noRelevantInfo
          ? []
          : Array.isArray(payload.sources)
          ? payload.sources.filter(
              (s): s is WebSource =>
                Boolean(s) &&
                typeof s.uri === 'string' &&
                typeof s.title === 'string' &&
                typeof s.domain === 'string'
            )
          : [];

      const noReliableSources =
        !isGeneralKnowledgeFallback &&
        !noRelevantInfo &&
        (Boolean(payload.noReliableSources) || sources.length === 0);

      const content =
        noReliableSources || noRelevantInfo
          ? ''
          : stripRawUrls(String(payload.content ?? '').trim());

      const groundedErrors: GroundedSearchError[] = Array.isArray(payload.groundedErrors)
        ? payload.groundedErrors
            .filter(
              (item): item is GroundedSearchError =>
                Boolean(item) &&
                typeof item.model === 'string' &&
                typeof item.message === 'string'
            )
            .map((item) => ({
              model: item.model,
              status: typeof item.status === 'number' ? item.status : null,
              message: item.message.slice(0, 300),
            }))
        : [];

      const record: ExtraInfoRecord = {
        cacheKey,
        messageId,
        language,
        content,
        sources:
          noReliableSources || noRelevantInfo || isGeneralKnowledgeFallback ? [] : sources,
        hasConflict:
          noReliableSources || noRelevantInfo ? false : Boolean(payload.hasConflict),
        noReliableSources,
        noRelevantInfo,
        isGeneralKnowledgeFallback,
        fallbackNotice: isGeneralKnowledgeFallback
          ? payload.fallbackNotice || FALLBACK_NOTICE
          : undefined,
        groundedErrors: groundedErrors.length > 0 ? groundedErrors : undefined,
        fetchedAt: Date.now(),
      };

      // Cache ONLY verified, on-topic grounded responses
      if (!isGeneralKnowledgeFallback && !noRelevantInfo) {
        memoryCache.set(cacheKey, record);
        try {
          await saveExtraInfoCache(record);
        } catch {
          // Keep in-memory cache even if IndexedDB write fails
        }
      }

      return record;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      if (err instanceof ExtraInfoError) {
        throw err;
      }

      const isNetworkErr =
        err instanceof TypeError ||
        (err instanceof Error &&
          (err.message.toLowerCase().includes('failed to fetch') ||
            err.message.toLowerCase().includes('networkerror')));

      if (isNetworkErr) {
        throw new ExtraInfoError(
          'Network connection failed while loading additional information. Check your internet connection and try again.',
          { code: 'NETWORK_ERROR', isQuotaError: false }
        );
      }

      throw new ExtraInfoError(
        err instanceof Error
          ? err.message
          : 'Unable to load additional information right now.',
        { code: 'UNKNOWN_ERROR', isQuotaError: false }
      );
    } finally {
      if (inFlightRequests.get(cacheKey)?.controller === controller) {
        inFlightRequests.delete(cacheKey);
      }
    }
  })();

  inFlightRequests.set(cacheKey, { promise: requestPromise, controller });
  return requestPromise;
}
