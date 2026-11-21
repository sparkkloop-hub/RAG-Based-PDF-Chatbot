import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

const DEPRECATED_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
]);

const DEFAULT_EXTRA_INFO_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
const CONFIGURED_EXTRA_INFO_MODELS: string[] = (process.env.EXTRA_INFO_MODELS ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => Boolean(m) && !DEPRECATED_MODELS.has(m.toLowerCase()));

const MODEL_CONFIG = {
  chat: process.env.CHAT_MODEL?.trim() || 'gemini-3.1-flash-lite',
  embedding: process.env.EMBEDDING_MODEL?.trim() || 'gemini-embedding-001',
  embeddingDimension: 768,
  tts: process.env.TTS_MODEL?.trim() || 'gemini-3.8-flash-lite-tts',
  multiTts: process.env.MULTI_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts',
  searchGrounding:
    CONFIGURED_EXTRA_INFO_MODELS.length > 0
      ? CONFIGURED_EXTRA_INFO_MODELS
      : DEFAULT_EXTRA_INFO_MODELS,
};

const CHAT_MODEL = MODEL_CONFIG.chat;
const EMBEDDING_MODEL = MODEL_CONFIG.embedding;
const EMBEDDING_DIMENSION = MODEL_CONFIG.embeddingDimension;

function getAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error(
      'GEMINI_API_KEY is not configured. Please check your API key in Settings > Secrets.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 500;
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractRetryDelaySeconds(err: unknown): number | undefined {
  const raw = err instanceof Error ? err.message : String(err);

  // Check structured Google RPC RetryInfo in error details if available
  const retryDelayJsonMatch = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayJsonMatch) {
    const secs = Math.ceil(Number(retryDelayJsonMatch[1]));
    if (Number.isFinite(secs) && secs > 0) return secs;
  }

  // Check plain text "Please retry in 14.5s" or "retry after 20 seconds"
  const retryTextMatch = raw.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/i);
  if (retryTextMatch) {
    const secs = Math.ceil(Number(retryTextMatch[1]));
    if (Number.isFinite(secs) && secs > 0) return secs;
  }

  // Check numeric retryAfter property if attached to error object
  if (typeof err === 'object' && err !== null && 'retryAfter' in err) {
    const val = Number((err as { retryAfter?: unknown }).retryAfter);
    if (Number.isFinite(val) && val > 0) return Math.ceil(val);
  }

  return undefined;
}

function classifyGeminiError(
  err: unknown,
  modelName?: string
): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const statusFromErr =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : typeof err === 'object' && err !== null && 'statusCode' in err
      ? Number((err as { statusCode?: unknown }).statusCode)
      : undefined;

  if (
    statusFromErr === 429 ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    const retryAfterSeconds = extractRetryDelaySeconds(err);
    return {
      status: 429,
      code: 'RATE_LIMITED',
      message: retryAfterSeconds
        ? `Rate limit reached on the Gemini API. Retry after ${retryAfterSeconds}s.`
        : 'Rate limit reached on the Gemini API. Please wait a moment and try again, or check your quota in Settings > Secrets.',
      retryable: true,
      retryAfterSeconds,
    };
  }

  if (
    statusFromErr === 404 ||
    lower.includes('not_found') ||
    lower.includes('is not found') ||
    lower.includes('model not found') ||
    lower.includes('invalid model') ||
    lower.includes('not supported for embedcontent')
  ) {
    return {
      status: 404,
      code: 'INVALID_MODEL',
      message: modelName
        ? `Embedding model "${modelName}" is invalid or unavailable. Check that "${modelName}" is supported by your Gemini API access.`
        : 'The requested Gemini model is invalid or unavailable.',
      retryable: false,
    };
  }

  if (
    statusFromErr === 401 ||
    statusFromErr === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('missing_api_key')
  ) {
    return {
      status: statusFromErr === 403 ? 403 : statusFromErr === 401 ? 401 : 400,
      code: 'API_KEY_INVALID',
      message:
        'Gemini API authentication failed. Please verify your API key in Settings > Secrets.',
      retryable: false,
    };
  }

  if (
    statusFromErr === 503 ||
    statusFromErr === 500 ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('deadline')
  ) {
    return {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'The AI service is temporarily busy. Please try again in a few seconds.',
      retryable: true,
    };
  }

  return {
    status: statusFromErr && statusFromErr >= 400 && statusFromErr < 600 ? statusFromErr : 500,
    code: 'AI_ERROR',
    message: raw || 'An unexpected error occurred while calling the Gemini API.',
    retryable: false,
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const info = classifyGeminiError(err);
      if (!info.retryable || attempt === maxAttempts - 1) {
        throw err;
      }
      const delayMs = Math.min(600 * Math.pow(2, attempt) + Math.random() * 250, 5000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function buildSchema(schemaType: string | undefined) {
  if (schemaType === 'mcqs') {
    return {
      type: Type.OBJECT,
      properties: {
        questions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING, description: 'Clear multiple-choice question grounded in the context.' },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Exactly 4 answer choices.',
              },
              correctIndex: {
                type: Type.INTEGER,
                description: 'Zero-based index (0 to 3) of the correct option.',
              },
              explanation: {
                type: Type.STRING,
                description: 'Brief explanation citing why the correct answer is right based on the context.',
              },
              sourceFile: { type: Type.STRING, description: 'Exact filename from the provided context.' },
              sourcePage: { type: Type.INTEGER, description: 'Exact page number from the provided context.' },
            },
            required: ['question', 'options', 'correctIndex', 'explanation', 'sourceFile', 'sourcePage'],
          },
        },
      },
      required: ['questions'],
    };
  }

  if (schemaType === 'short_answers') {
    return {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              answer: { type: Type.STRING },
              keyPoints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              sourceFile: { type: Type.STRING },
              sourcePage: { type: Type.INTEGER },
            },
            required: ['question', 'answer', 'keyPoints', 'sourceFile', 'sourcePage'],
          },
        },
      },
      required: ['items'],
    };
  }

  if (schemaType === 'suggested_questions') {
    return {
      type: Type.OBJECT,
      properties: {
        questions: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['questions'],
    };
  }

  if (schemaType === 'audio_overview_script') {
    return {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: {
            type: Type.STRING,
            description: 'Must be exactly "Host A" or "Host B".',
          },
          text: {
            type: Type.STRING,
            description: 'Spoken dialogue line for this host, plain spoken prose without markdown.',
          },
        },
        required: ['speaker', 'text'],
      },
    };
  }

  return undefined;
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      models: MODEL_CONFIG,
    });
  });

  // Batch embedding endpoint
  app.post('/api/embed', async (req: Request, res: Response) => {
    const { texts, taskType, batchIndex } = req.body as {
      texts?: unknown;
      taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
      batchIndex?: number;
    };

    try {
      if (!Array.isArray(texts) || texts.length === 0) {
        res.status(400).json({
          error: 'texts must be a non-empty array of strings.',
          code: 'INVALID_INPUT',
          model: EMBEDDING_MODEL,
        });
        return;
      }

      if (texts.length > 64) {
        res.status(400).json({
          error: 'Maximum 64 texts per embedding batch.',
          code: 'BATCH_TOO_LARGE',
          model: EMBEDDING_MODEL,
        });
        return;
      }

      const sanitizedTexts = texts.map((t) =>
        typeof t === 'string' ? t.trim().slice(0, 2000) : ''
      );
      if (sanitizedTexts.some((t) => t.length === 0)) {
        res.status(400).json({
          error: 'Every text in the embedding batch must be a non-empty string.',
          code: 'EMPTY_TEXT',
          model: EMBEDDING_MODEL,
        });
        return;
      }

      const ai = getAIClient();
      const validTaskType =
        taskType === 'RETRIEVAL_QUERY' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';

      const result = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: sanitizedTexts,
        config: {
          taskType: validTaskType,
          outputDimensionality: EMBEDDING_DIMENSION,
        },
      });

      const rawList = Array.isArray(result?.embeddings) ? result.embeddings : [];
      const vectors: number[][] = rawList.map((item) =>
        Array.isArray(item?.values) ? item.values : []
      );

      const hasInvalidVector = vectors.some(
        (vec) =>
          vec.length !== EMBEDDING_DIMENSION ||
          vec.some((v) => typeof v !== 'number' || !Number.isFinite(v))
      );

      if (vectors.length !== sanitizedTexts.length || hasInvalidVector) {
        const msg = `Embedding model "${EMBEDDING_MODEL}" returned ${vectors.length} of ${sanitizedTexts.length} expected vectors (expected dimension ${EMBEDDING_DIMENSION}).`;
        console.error('[/api/embed] incomplete response:', {
          batchIndex: batchIndex ?? null,
          batchSize: sanitizedTexts.length,
          receivedCount: vectors.length,
          receivedDimensions: vectors.slice(0, 5).map((v) => v.length),
          model: EMBEDDING_MODEL,
          taskType: validTaskType,
        });
        res.status(502).json({
          error: msg,
          code: 'INCOMPLETE_EMBEDDING',
          model: EMBEDDING_MODEL,
          expectedDimension: EMBEDDING_DIMENSION,
        });
        return;
      }

      res.json({
        embeddings: vectors,
        model: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSION,
      });
    } catch (err) {
      const info = classifyGeminiError(err, EMBEDDING_MODEL);
      console.error('[/api/embed] error:', {
        status: info.status,
        code: info.code,
        message: info.message,
        retryAfterSeconds: info.retryAfterSeconds ?? null,
        batchIndex: batchIndex ?? null,
        batchSize: Array.isArray(texts) ? texts.length : 0,
        model: EMBEDDING_MODEL,
        rawError: err,
      });
      if (info.retryAfterSeconds) {
        res.setHeader('Retry-After', String(info.retryAfterSeconds));
      }
      res.status(info.status).json({
        error: info.message,
        code: info.code,
        status: info.status,
        retryAfterSeconds: info.retryAfterSeconds,
        model: EMBEDDING_MODEL,
      });
    }
  });

  // Streaming chat endpoint (SSE)
  app.post('/api/chat/stream', async (req: Request, res: Response) => {
    const { systemInstruction, contents } = req.body as {
      systemInstruction?: string;
      contents?: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    };

    if (!Array.isArray(contents) || contents.length === 0) {
      res.status(400).json({ error: 'contents must be a non-empty array.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const ai = getAIClient();
      const config: Record<string, unknown> = {};
      if (systemInstruction && systemInstruction.trim()) {
        config.systemInstruction = systemInstruction;
      }

      const stream = await withRetry(() =>
        ai.models.generateContentStream({
          model: CHAT_MODEL,
          contents,
          config: Object.keys(config).length > 0 ? config : undefined,
        })
      );

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[/api/chat/stream] error:', err);
      const info = classifyGeminiError(err);
      res.write(`data: ${JSON.stringify({ error: info.message, code: info.code })}\n\n`);
      res.end();
    }
  });

  // Non-streaming structured or markdown generation (study tools, map-reduce, suggestions)
  app.post('/api/generate', async (req: Request, res: Response) => {
    try {
      const { systemInstruction, prompt, schemaType } = req.body as {
        systemInstruction?: string;
        prompt?: string;
        schemaType?: 'mcqs' | 'short_answers' | 'suggested_questions' | 'audio_overview_script';
      };

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required.' });
        return;
      }

      const ai = getAIClient();
      const responseSchema = buildSchema(schemaType);
      const config: Record<string, unknown> = {};
      if (systemInstruction && systemInstruction.trim()) {
        config.systemInstruction = systemInstruction;
      }
      if (responseSchema) {
        config.responseMimeType = 'application/json';
        config.responseSchema = responseSchema;
      }

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: CHAT_MODEL,
          contents: prompt,
          config: Object.keys(config).length > 0 ? config : undefined,
        })
      );

      res.json({ text: response.text ?? '', model: CHAT_MODEL });
    } catch (err) {
      console.error('[/api/generate] error:', err);
      const info = classifyGeminiError(err, CHAT_MODEL);
      if (info.retryAfterSeconds) {
        res.setHeader('Retry-After', String(info.retryAfterSeconds));
      }
      res.status(info.status).json({
        error: info.message,
        code: info.code,
        retryAfterSeconds: info.retryAfterSeconds,
        model: CHAT_MODEL,
      });
    }
  });

  // Text-to-Speech endpoint using Gemini TTS
  const TTS_MODEL = MODEL_CONFIG.tts;
  const ALLOWED_VOICES = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr']);

  app.post('/api/tts', async (req: Request, res: Response) => {
    try {
      const { text, voiceName, language } = req.body as {
        text?: string;
        voiceName?: string;
        language?: 'en' | 'ta';
      };

      const cleaned = typeof text === 'string' ? text.trim() : '';
      if (!cleaned) {
        res.status(400).json({ error: 'text is required.' });
        return;
      }

      const selectedVoice =
        voiceName && ALLOWED_VOICES.has(voiceName) ? voiceName : 'Kore';

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        res.status(500).json({
          error: 'GEMINI_API_KEY is not configured. Please check Settings > Secrets.',
          code: 'MISSING_API_KEY',
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey,
        apiVersion: 'v1beta',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const styleInstruction =
        language === 'ta'
          ? 'Read the Tamil text in a calm, clear, steady tone at a consistent pace.'
          : 'Read in a calm, clear, steady tone at a consistent pace.';

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: TTS_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: cleaned,
                  speechMetadata: {
                    style: styleInstruction,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: selectedVoice,
                },
              },
            },
          },
        })
      );

      const inlineData =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData;

      if (!inlineData?.data) {
        res.status(502).json({
          error: 'Gemini TTS did not return audio data.',
          code: 'EMPTY_AUDIO',
        });
        return;
      }

      res.json({
        audioBase64: inlineData.data,
        mimeType: inlineData.mimeType ?? 'audio/wav',
        model: TTS_MODEL,
        voiceName: selectedVoice,
      });
    } catch (err) {
      console.error('[/api/tts] error:', err);
      const info = classifyGeminiError(err, TTS_MODEL);
      if (info.retryAfterSeconds) {
        res.setHeader('Retry-After', String(info.retryAfterSeconds));
      }
      res.status(info.status).json({
        error: info.message,
        code: info.code,
        retryAfterSeconds: info.retryAfterSeconds,
        model: TTS_MODEL,
      });
    }
  });

  // Multi-speaker podcast TTS endpoint using gemini-3.8-flash-tts
  const MULTI_TTS_MODEL = MODEL_CONFIG.multiTts;

  app.post('/api/tts/multi', async (req: Request, res: Response) => {
    try {
      const { turns, voiceA, voiceB, language } = req.body as {
        turns?: Array<{ speaker?: string; text?: string }>;
        voiceA?: string;
        voiceB?: string;
        language?: 'en' | 'ta';
      };

      if (!Array.isArray(turns) || turns.length === 0) {
        res.status(400).json({ error: 'turns must be a non-empty array of dialogue lines.' });
        return;
      }

      const normalizedTurns = turns
        .map((t) => ({
          speaker: t.speaker === 'Host B' ? 'Host B' : 'Host A',
          text: typeof t.text === 'string' ? t.text.trim() : '',
        }))
        .filter((t) => t.text.length > 0);

      if (normalizedTurns.length === 0) {
        res.status(400).json({ error: 'turns must contain non-empty spoken text.' });
        return;
      }

      const selectedVoiceA =
        voiceA && ALLOWED_VOICES.has(voiceA) ? voiceA : 'Kore';
      const selectedVoiceB =
        voiceB && ALLOWED_VOICES.has(voiceB) ? voiceB : 'Puck';

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        res.status(500).json({
          error: 'GEMINI_API_KEY is not configured. Please check Settings > Secrets.',
          code: 'MISSING_API_KEY',
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey,
        apiVersion: 'v1beta',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const styleA =
        language === 'ta'
          ? 'Warm, clear, natural spoken Tamil podcast host'
          : 'Warm, clear, articulate podcast host';
      const styleB =
        language === 'ta'
          ? 'Curious, engaging spoken Tamil podcast co-host'
          : 'Curious, thoughtful, conversational podcast co-host';

      const parts = normalizedTurns.map((turn) => ({
        text: `${turn.speaker}: ${turn.text}`,
        speechMetadata: {
          speaker: turn.speaker,
          style: turn.speaker === 'Host A' ? styleA : styleB,
        },
      }));

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MULTI_TTS_MODEL,
          contents: [
            {
              role: 'user',
              parts,
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: [
                  {
                    speaker: 'Host A',
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: selectedVoiceA,
                      },
                    },
                  },
                  {
                    speaker: 'Host B',
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: selectedVoiceB,
                      },
                    },
                  },
                ],
              },
            },
          },
        })
      );

      const inlineData =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData;

      if (!inlineData?.data) {
        res.status(502).json({
          error: 'Gemini multi-speaker TTS did not return audio data.',
          code: 'EMPTY_AUDIO',
        });
        return;
      }

      res.json({
        audioBase64: inlineData.data,
        mimeType: inlineData.mimeType ?? 'audio/wav',
      });
    } catch (err) {
      console.error('[/api/tts/multi] error:', err);
      const info = classifyGeminiError(err);
      res.status(info.status).json({ error: info.message, code: info.code });
    }
  });

  // Additional Information endpoint using configurable AI Studio Gemini model list + Google Search grounding
  const ACTIVE_EXTRA_INFO_MODELS = MODEL_CONFIG.searchGrounding;

  const MAX_GROUNDED_RETRY_DELAY_SEC = 15;
  const UNGROUNDED_FALLBACK_NOTICE =
    "Live web search is unavailable right now. This is from the AI's general knowledge and is not verified.";

  interface GroundedErrorEntry {
    model: string;
    status: number | null;
    message: string;
  }

  interface ParsedGeminiError {
    status: number;
    code: string;
    message: string;
    rawMessage: string;
    retryDelaySeconds?: number;
    isRateLimit: boolean;
    isZeroQuota: boolean;
    isTransientServerError: boolean;
  }

  function inspectGeminiError(err: unknown): ParsedGeminiError {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const lower = rawMessage.toLowerCase();

    let statusFromObj: number | undefined;
    if (typeof err === 'object' && err !== null) {
      if ('status' in err && Number.isFinite(Number((err as { status?: unknown }).status))) {
        statusFromObj = Number((err as { status?: unknown }).status);
      } else if (
        'statusCode' in err &&
        Number.isFinite(Number((err as { statusCode?: unknown }).statusCode))
      ) {
        statusFromObj = Number((err as { statusCode?: unknown }).statusCode);
      }
    }

    // Extract inner message, status, and QuotaFailure details if the SDK serialized a JSON error payload
    let parsedMessage = rawMessage;
    let parsedStatus = statusFromObj;
    const jsonStart = rawMessage.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const obj = JSON.parse(rawMessage.slice(jsonStart)) as {
          error?: {
            code?: number;
            message?: string;
            status?: string;
            details?: Array<{
              '@type'?: string;
              violations?: Array<{
                quotaMetric?: string;
                quotaId?: string;
                quotaValue?: string;
              }>;
              retryDelay?: string;
            }>;
          };
        };
        if (typeof obj?.error?.code === 'number' && !parsedStatus) {
          parsedStatus = obj.error.code;
        }
        const rawInnerMsg = obj?.error?.message ?? rawMessage;
        // Trim repetitive rate-limit help links so the actual reason/metric fits inside 300 chars
        const conciseMsg = rawInnerMsg
          .replace(/For more information on this error,?\s*head to:\s*https?:\/\/\S+\.?\s*/gi, '')
          .replace(/To monitor your current usage,?\s*head to:\s*https?:\/\/\S+\.?\s*/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        const quotaDetails = (obj?.error?.details ?? [])
          .flatMap((d) => d.violations ?? [])
          .map((v) => {
            const metric = v.quotaMetric || v.quotaId || '';
            const val = v.quotaValue !== undefined ? `limit=${v.quotaValue}` : '';
            return [metric, val].filter(Boolean).join(' ');
          })
          .filter(Boolean);

        parsedMessage =
          quotaDetails.length > 0 && !conciseMsg.includes(quotaDetails[0])
            ? `${conciseMsg} [${quotaDetails.slice(0, 2).join('; ')}]`
            : conciseMsg || rawInnerMsg;
      } catch {
        // Keep rawMessage
      }
    }

    const retryDelaySeconds = extractRetryDelaySeconds(err);

    const isZeroQuota =
      /\blimit\s*[:=]\s*0\b/i.test(rawMessage) ||
      /"quota_limit_value"\s*:\s*"0"/i.test(rawMessage) ||
      /free_tier[^\n]*limit\s*[:=]\s*0/i.test(rawMessage);

    const isRateLimit =
      parsedStatus === 429 ||
      lower.includes('resource_exhausted') ||
      lower.includes('quota exceeded') ||
      lower.includes('rate limit') ||
      lower.includes('too many requests');

    if (isRateLimit) {
      return {
        status: 429,
        code: 'RATE_LIMITED',
        message: parsedMessage,
        rawMessage,
        retryDelaySeconds,
        isRateLimit: true,
        isZeroQuota,
        isTransientServerError: false,
      };
    }

    if (
      parsedStatus === 401 ||
      parsedStatus === 403 ||
      lower.includes('permission_denied') ||
      lower.includes('api_key_invalid') ||
      lower.includes('api key not valid') ||
      lower.includes('missing_api_key')
    ) {
      return {
        status: parsedStatus === 403 ? 403 : parsedStatus === 401 ? 401 : 403,
        code: 'API_KEY_INVALID',
        message: parsedMessage,
        rawMessage,
        retryDelaySeconds,
        isRateLimit: false,
        isZeroQuota: false,
        isTransientServerError: false,
      };
    }

    if (
      parsedStatus === 404 ||
      lower.includes('not_found') ||
      lower.includes('is not found') ||
      lower.includes('model not found')
    ) {
      return {
        status: 404,
        code: 'INVALID_MODEL',
        message: parsedMessage,
        rawMessage,
        retryDelaySeconds,
        isRateLimit: false,
        isZeroQuota: false,
        isTransientServerError: false,
      };
    }

    if (parsedStatus === 400 || lower.includes('invalid_argument')) {
      return {
        status: 400,
        code: 'BAD_REQUEST',
        message: parsedMessage,
        rawMessage,
        retryDelaySeconds,
        isRateLimit: false,
        isZeroQuota: false,
        isTransientServerError: false,
      };
    }

    if (
      parsedStatus === 500 ||
      parsedStatus === 502 ||
      parsedStatus === 503 ||
      parsedStatus === 504 ||
      lower.includes('unavailable') ||
      lower.includes('overloaded') ||
      lower.includes('deadline')
    ) {
      return {
        status: parsedStatus && parsedStatus >= 500 ? parsedStatus : 503,
        code: 'SERVICE_UNAVAILABLE',
        message: parsedMessage,
        rawMessage,
        retryDelaySeconds,
        isRateLimit: false,
        isZeroQuota: false,
        isTransientServerError: true,
      };
    }

    return {
      status: parsedStatus && parsedStatus >= 400 && parsedStatus < 600 ? parsedStatus : 500,
      code: 'AI_ERROR',
      message: parsedMessage || 'An unexpected error occurred while calling the Gemini API.',
      rawMessage,
      retryDelaySeconds,
      isRateLimit: false,
      isZeroQuota: false,
      isTransientServerError: false,
    };
  }

  function stripUrlsAndInlineCitations(rawText: string): string {
    return rawText
      // Convert markdown links [label](https://...) to just label
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/gi, '$1')
      // Remove angle-bracketed URLs <https://...>
      .replace(/<(?:https?:\/\/|www\.)[^>]+>/gi, '')
      // Remove bare URLs
      .replace(/\b(?:https?:\/\/|www\.)[^\s)\]>,"']+/gi, '')
      // Remove inline numeric citations like [1], [1, 2], [1][2]
      .replace(/\s*(?:\[\d+(?:\s*,\s*\d+)*\])+/g, '')
      // Clean empty parentheses/brackets left behind after stripping URLs
      .replace(/\(\s*\)/g, '')
      .replace(/\[\s*\]/g, '')
      // Clean trailing punctuation spacing and excess blank lines
      .replace(/[ \t]+([.,;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractWebSources(response: unknown): Array<{
    title: string;
    uri: string;
    domain: string;
  }> {
    const candidates = (
      response as {
        candidates?: Array<{
          groundingMetadata?: {
            groundingChunks?: Array<{
              web?: { uri?: string; title?: string };
            }>;
          };
        }>;
      }
    )?.candidates;

    const chunks = candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const sources: Array<{ title: string; uri: string; domain: string }> = [];

    for (const chunk of chunks) {
      const rawUri = chunk?.web?.uri?.trim();
      if (!rawUri) continue;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUri);
      } catch {
        continue;
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        continue;
      }

      const normalizedKey = parsedUrl.href;
      if (seen.has(normalizedKey)) continue;
      seen.add(normalizedKey);

      const host = parsedUrl.hostname.replace(/^www\./i, '');
      const rawTitle = chunk?.web?.title?.trim() ?? '';
      const isRedirectHost = host === 'vertexaisearch.cloud.google.com';

      let domain = host;
      let title = rawTitle || host;

      if (isRedirectHost) {
        const looksLikeDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(rawTitle);
        if (looksLikeDomain) {
          domain = rawTitle.replace(/^www\./i, '').toLowerCase();
          title = domain;
        } else if (rawTitle) {
          domain = rawTitle;
          title = rawTitle;
        } else {
          domain = 'Web source';
          title = 'Web source';
        }
      }

      sources.push({
        title,
        uri: parsedUrl.href,
        domain,
      });
    }

    return sources;
  }

  async function tryGenerateWithSmartRetry(
    ai: GoogleGenAI,
    model: string,
    prompt: string,
    useGoogleSearch: boolean,
    groundedErrors?: GroundedErrorEntry[]
  ): Promise<
    | { ok: true; response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>> }
    | { ok: false; error: ParsedGeminiError }
  > {
    const mode = useGoogleSearch ? 'grounded' : 'ungrounded';

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: useGoogleSearch ? { tools: [{ googleSearch: {} }] } : undefined,
        });

        const text = (response.text ?? '').trim();
        if (!text) {
          const emptyErr: ParsedGeminiError = {
            status: 200,
            code: 'EMPTY_RESPONSE',
            message: 'Model returned empty text.',
            rawMessage: 'Model returned empty text.',
            isRateLimit: false,
            isZeroQuota: false,
            isTransientServerError: false,
          };
          console.warn('[/api/extra-info] Gemini call returned empty text:', {
            mode,
            model,
            attempt,
            status: 200,
            message: emptyErr.message,
          });
          if (attempt === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (useGoogleSearch && groundedErrors) {
            groundedErrors.push({
              model,
              status: 200,
              message: emptyErr.message.slice(0, 300),
            });
          }
          return { ok: false, error: emptyErr };
        }

        return { ok: true, response };
      } catch (err) {
        const parsed = inspectGeminiError(err);
        const shortMessage = (parsed.message || parsed.rawMessage || 'Unknown Gemini error')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);

        console.warn('[/api/extra-info] Gemini attempt failed:', {
          mode,
          model,
          attempt,
          status: parsed.status,
          code: parsed.code,
          retryDelaySeconds: parsed.retryDelaySeconds ?? null,
          isZeroQuota: parsed.isZeroQuota,
          message: shortMessage,
        });

        // Retry once on transient 5xx, or on short retryDelay (<= 15s) when quota limit != 0
        const hasShortRetryDelay =
          typeof parsed.retryDelaySeconds === 'number' &&
          parsed.retryDelaySeconds > 0 &&
          parsed.retryDelaySeconds <= MAX_GROUNDED_RETRY_DELAY_SEC;

        const canRetrySameModel =
          attempt === 1 &&
          !parsed.isZeroQuota &&
          (parsed.isTransientServerError || (parsed.isRateLimit && hasShortRetryDelay));

        if (canRetrySameModel) {
          const waitSec = hasShortRetryDelay ? parsed.retryDelaySeconds! : 2;
          await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
          continue;
        }

        if (useGoogleSearch && groundedErrors) {
          groundedErrors.push({
            model,
            status: parsed.status,
            message: shortMessage,
          });
        }

        return { ok: false, error: parsed };
      }
    }

    return {
      ok: false,
      error: {
        status: 500,
        code: 'AI_ERROR',
        message: 'Unexpected retry loop termination.',
        rawMessage: 'Unexpected retry loop termination.',
        isRateLimit: false,
        isZeroQuota: false,
        isTransientServerError: false,
      },
    };
  }

  const TOPIC_STOPWORDS = new Set([
    // Common English stopwords
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where',
    'which', 'what', 'who', 'whom', 'whose', 'why', 'how', 'is', 'are', 'was',
    'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'done',
    'have', 'has', 'had', 'having', 'can', 'could', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'not', 'no', 'nor', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'also', 'more', 'most', 'some', 'any',
    'all', 'both', 'each', 'few', 'many', 'much', 'other', 'such', 'into', 'onto',
    'from', 'with', 'without', 'about', 'above', 'below', 'between', 'under',
    'over', 'through', 'during', 'before', 'after', 'that', 'this', 'these',
    'those', 'there', 'here', 'they', 'them', 'their', 'your', 'you', 'our',
    'its', 'for', 'per', 'via',
    // Generic question / scaffold / RAG boilerplate words that shouldn't alone validate topic match
    'cell', 'cells', 'produce', 'produces', 'produced', 'producing', 'make',
    'makes', 'made', 'making', 'create', 'creates', 'created', 'form', 'forms',
    'formed', 'give', 'gives', 'given', 'help', 'helps', 'used', 'using', 'use',
    'uses', 'call', 'called', 'known', 'name', 'named', 'type', 'types', 'kind',
    'kinds', 'part', 'parts', 'main', 'major', 'role', 'roles', 'function',
    'functions', 'process', 'processes', 'system', 'systems', 'body', 'human',
    'structure', 'structures', 'tissue', 'layer', 'layers', 'thing', 'things',
    'example', 'examples', 'explain', 'describe', 'define', 'list', 'tell',
    'difference', 'different', 'important', 'primary', 'found', 'find', 'could',
    'couldn', 'information', 'uploaded', 'document', 'documents', 'answer',
    'question', 'based', 'according', 'text', 'page', 'section', 'summary',
    'provide', 'additional', 'context', 'related', 'concept', 'concepts',
    'specifically', 'include', 'includes', 'including', 'within', 'around',
    // Common Tamil question/scaffold words
    'என்ன', 'எந்த', 'எப்படி', 'ஏன்', 'யார்', 'எங்கே', 'எப்போது', 'பற்றி',
    'மற்றும்', 'அல்லது', 'இது', 'அது', 'இந்த', 'அந்த', 'உள்ள', 'ஒரு', 'ஆகும்',
    'என்பது', 'தகவல்', 'ஆவணங்களில்', 'இல்லை', 'பதில்', 'கேள்வி',
  ]);

  const NO_DOC_ANSWER_PATTERNS = [
    /couldn['’]?t find this information in your uploaded documents/i,
    /not found in (?:your |the )?uploaded documents/i,
    /உங்கள் பதிவேற்றிய ஆவணங்களில் இந்தத் தகவல் கிடைக்கவில்லை/i,
  ];

  function normalizeTopicToken(token: string): string {
    const lower = token.toLowerCase().replace(/^['’\-]+|['’\-]+$/g, '');
    if (!lower) return '';
    // Light English plural/suffix normalization for reliable matching (e.g., fibers -> fiber, fibroblasts -> fibroblast)
    if (/^[a-z]+$/.test(lower) && lower.length > 4) {
      if (lower.endsWith('ies')) return lower.slice(0, -3) + 'y';
      if (lower.endsWith('es') && /(?:ch|sh|x|z|s)es$/.test(lower)) {
        return lower.slice(0, -2);
      }
      if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) {
        return lower.slice(0, -1);
      }
    }
    return lower;
  }

  function extractKeyTerms(text: string): { specific: Set<string>; fallback: Set<string> } {
    const cleaned = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');
    const rawTokens = cleaned.split(/\s+/).filter(Boolean);
    const specific = new Set<string>();
    const fallback = new Set<string>();

    for (const raw of rawTokens) {
      const norm = normalizeTopicToken(raw);
      if (!norm) continue;

      const isLatin = /^[a-z0-9'-]+$/.test(norm);
      if (isLatin && norm.length < 3) continue;
      if (!isLatin && norm.length < 2) continue;

      if (!TOPIC_STOPWORDS.has(norm) && !TOPIC_STOPWORDS.has(raw.toLowerCase())) {
        specific.add(norm);
      } else if (norm.length >= 4 && !/^(?:what|which|where|when|that|this|these|those|with|from|into|about|your|their|have|does|could|would|should|information|uploaded|document|documents|answer|question)$/.test(norm)) {
        fallback.add(norm);
      }
    }

    return { specific, fallback };
  }

  function passesTopicRelevanceCheck(
    question: string,
    answer: string,
    responseText: string
  ): { isRelevant: boolean; matchedTerms: string[]; expectedTerms: string[] } {
    const isMissingDocAnswer = NO_DOC_ANSWER_PATTERNS.some((rx) => rx.test(answer));
    const sourceText = isMissingDocAnswer ? question : `${question}\n${answer}`;

    const { specific, fallback } = extractKeyTerms(sourceText);
    const keyTerms = specific.size > 0 ? specific : fallback;

    if (keyTerms.size === 0) {
      return { isRelevant: true, matchedTerms: [], expectedTerms: [] };
    }

    const responseLower = responseText.toLowerCase();
    const responseTokenSet = new Set(
      responseText
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .map(normalizeTopicToken)
        .filter(Boolean)
    );

    const matchedTerms: string[] = [];
    for (const term of keyTerms) {
      if (responseTokenSet.has(term)) {
        matchedTerms.push(term);
        continue;
      }
      // Allow stem/compound substring match for longer technical terms (e.g., "collagen" in "collagenous", "fibroblast" in "myofibroblast")
      if (term.length >= 5 && responseLower.includes(term)) {
        matchedTerms.push(term);
      }
    }

    return {
      isRelevant: matchedTerms.length > 0,
      matchedTerms,
      expectedTerms: Array.from(keyTerms).slice(0, 12),
    };
  }

  app.post('/api/extra-info', async (req: Request, res: Response) => {
    try {
      const { messageId, question, answer, language, topicHints } = req.body as {
        messageId?: string;
        question?: string;
        answer?: string;
        language?: 'en' | 'ta';
        topicHints?: unknown;
      };

      const safeMessageId =
        typeof messageId === 'string' ? messageId.trim().slice(0, 120) : '';
      const safeQuestion =
        typeof question === 'string' ? question.trim().slice(0, 1500) : '';
      const safeAnswer =
        typeof answer === 'string' ? answer.trim().slice(0, 4000) : '';
      const targetLang: 'en' | 'ta' = language === 'ta' ? 'ta' : 'en';
      const safeTopicHints: string[] = Array.isArray(topicHints)
        ? topicHints
            .filter((h): h is string => typeof h === 'string')
            .map((h) => h.replace(/\s+/g, ' ').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 2)
        : [];

      // Log exact question and answer received (first 200 chars) to verify message alignment
      console.log('[/api/extra-info] request received:', {
        messageId: safeMessageId || null,
        language: targetLang,
        question: safeQuestion.slice(0, 200),
        answer: safeAnswer.slice(0, 200),
        topicHints: safeTopicHints,
      });

      if (!safeQuestion || !safeAnswer) {
        res.status(400).json({
          error: 'Both question and answer are required to fetch additional information.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const ai = getAIClient();

      const languageRule =
        targetLang === 'ta'
          ? 'Write your entire response in natural, clear Tamil using Tamil script only (do not use romanized Tamil / Tanglish). When the question or answer uses English technical or scientific terms, include the exact English term in parentheses on first mention (for example: கொலாஜன் (collagen)) so terminology stays clear. Keep only optional control tags in English on line 1 if applicable.'
          : 'Write your response in clear, simple English.';

      const topicHintsLine =
        safeTopicHints.length > 0
          ? `Document section topic hints (headings only, for subject alignment): ${safeTopicHints.join(' | ')}`
          : '';

      const strictTopicInstruction =
        `Stay strictly on the topic of the user's question: ${safeQuestion}. Expand on the same subject (here: the cells, concepts, and structures named in the question and answer). Do not switch to a different topic. If you cannot add relevant information, say so.`;

      const groundedPrompt = [
        `The user asked: ${safeQuestion}.`,
        `The document-based answer was: ${safeAnswer}.`,
        topicHintsLine,
        strictTopicInstruction,
        'Search the web and provide additional, accurate information that is NOT already in the answer: deeper explanation, examples, recent developments, related aspects of the SAME subject. Be concise, use simple language, and do not contradict the document without saying so. If you find nothing reliable or cannot add relevant information on this exact topic, reply with [[NO_RELEVANT_INFO]].',
        '',
        'Formatting and sourcing rules:',
        '- Provide 3 to 6 concise Markdown bullet points (each starting with "- ") focused directly on the exact subject asked about. Do not repeat what the document-based answer already stated, and do NOT drift to unrelated topics.',
        '- Do NOT include any URLs, web links, markdown links, or inline bracket citations like [1] in your text. Verified web sources will be displayed separately.',
        '- If reliable web information contradicts or significantly updates the document-based answer, explicitly mention the difference in your bullet point AND place the exact token [[DOCUMENT_CONFLICT]] on the very first line of your response.',
        `- ${languageRule}`,
      ]
        .filter(Boolean)
        .join('\n');

      let lastGroundedError: ParsedGeminiError | null = null;
      const groundedErrors: GroundedErrorEntry[] = [];
      let hadNonQuotaGroundedError = false;

      // 1. Try each model in ACTIVE_EXTRA_INFO_MODELS with Google Search grounding
      for (const model of ACTIVE_EXTRA_INFO_MODELS) {
        const result = await tryGenerateWithSmartRetry(
          ai,
          model,
          groundedPrompt,
          true,
          groundedErrors
        );
        if (!result.ok) {
          lastGroundedError = result.error;
          if (!result.error.isRateLimit && !result.error.isTransientServerError) {
            hadNonQuotaGroundedError = true;
          }
          continue;
        }

        const sources = extractWebSources(result.response);
        if (sources.length === 0) {
          res.json({
            content: '',
            sources: [],
            hasConflict: false,
            noReliableSources: true,
            noRelevantInfo: false,
            isGeneralKnowledgeFallback: false,
            groundedErrors,
          });
          return;
        }

        let rawText = (result.response.text ?? '').trim();
        if (/\[\[NO_RELEVANT_INFO\]\]/i.test(rawText)) {
          res.json({
            content: '',
            sources: [],
            hasConflict: false,
            noReliableSources: false,
            noRelevantInfo: true,
            isGeneralKnowledgeFallback: false,
            groundedErrors,
          });
          return;
        }

        const conflictMarkerRegex = /\[\[DOCUMENT_CONFLICT\]\]/gi;
        const hasConflictMarker = conflictMarkerRegex.test(rawText);
        rawText = rawText.replace(conflictMarkerRegex, '').trim();

        const cleanedContent = stripUrlsAndInlineCitations(rawText);
        if (!cleanedContent) {
          groundedErrors.push({
            model,
            status: 200,
            message: 'Grounded response was empty after stripping raw URLs.',
          });
          console.warn('[/api/extra-info] Grounded response empty after URL stripping:', {
            model,
          });
          continue;
        }

        const topicCheck = passesTopicRelevanceCheck(
          safeQuestion,
          safeAnswer,
          cleanedContent
        );
        if (!topicCheck.isRelevant) {
          console.warn('[/api/extra-info] Discarded off-topic grounded response:', {
            messageId: safeMessageId || null,
            model,
            expectedTerms: topicCheck.expectedTerms,
            responsePreview: cleanedContent.slice(0, 200),
          });
          res.json({
            content: '',
            sources: [],
            hasConflict: false,
            noReliableSources: false,
            noRelevantInfo: true,
            isGeneralKnowledgeFallback: false,
            groundedErrors,
          });
          return;
        }

        res.json({
          content: cleanedContent,
          sources,
          hasConflict: hasConflictMarker,
          noReliableSources: false,
          noRelevantInfo: false,
          isGeneralKnowledgeFallback: false,
          groundedErrors,
          model,
        });
        return;
      }

      if (groundedErrors.length > 0) {
        console.warn(
          '[/api/extra-info] Grounded search unavailable; falling back to ungrounded model:',
          groundedErrors
        );
      }

      // 2. All grounded attempts failed -> call Gemini WITHOUT Google Search grounding
      const ungroundedPrompt = [
        `The user asked: ${safeQuestion}.`,
        `The document-based answer was: ${safeAnswer}.`,
        topicHintsLine,
        strictTopicInstruction,
        'Provide helpful additional context, simple explanations, or practical examples strictly about the SAME subject that are NOT already in the document-based answer. Be concise, use simple language, and do not contradict the document without clearly noting the difference. If you cannot add relevant information on this exact topic, reply with [[NO_RELEVANT_INFO]].',
        '',
        'Formatting rules:',
        '- Provide 3 to 6 concise Markdown bullet points (each starting with "- ") focused strictly on the exact subject asked about. Do not repeat what the document-based answer already stated, and do NOT switch to unrelated topics.',
        '- Do NOT include any URLs, web links, markdown links, or inline bracket citations like [1].',
        '- If standard knowledge differs from what the document-based answer stated, explicitly note the difference AND place the exact token [[DOCUMENT_CONFLICT]] on the very first line of your response.',
        `- ${languageRule}`,
      ]
        .filter(Boolean)
        .join('\n');

      // Prefer CHAT_MODEL first if not already in the list, or iterate deduplicated models
      const ungroundedModels = Array.from(
        new Set([CHAT_MODEL, ...ACTIVE_EXTRA_INFO_MODELS])
      );

      let lastFallbackError: ParsedGeminiError | null = null;

      // Do not falsely map non-quota errors (400/403/404) to the generic "unavailable" message
      const allNonQuotaFailures =
        hadNonQuotaGroundedError &&
        groundedErrors.length > 0 &&
        groundedErrors.every((e) => e.status !== 429 && (e.status === null || e.status < 500));

      const fallbackNotice = allNonQuotaFailures
        ? `Live web search failed (${groundedErrors[0].model}: HTTP ${groundedErrors[0].status ?? 'error'}). This is from the AI's general knowledge and is not verified.`
        : UNGROUNDED_FALLBACK_NOTICE;

      for (const model of ungroundedModels) {
        const fallbackResult = await tryGenerateWithSmartRetry(
          ai,
          model,
          ungroundedPrompt,
          false
        );

        if (!fallbackResult.ok) {
          lastFallbackError = fallbackResult.error;
          continue;
        }

        let rawText = (fallbackResult.response.text ?? '').trim();
        if (/\[\[NO_RELEVANT_INFO\]\]/i.test(rawText)) {
          res.json({
            content: '',
            sources: [],
            hasConflict: false,
            noReliableSources: false,
            noRelevantInfo: true,
            isGeneralKnowledgeFallback: true,
            fallbackNotice,
            groundedErrors,
          });
          return;
        }

        const conflictMarkerRegex = /\[\[DOCUMENT_CONFLICT\]\]/gi;
        const hasConflictMarker = conflictMarkerRegex.test(rawText);
        rawText = rawText.replace(conflictMarkerRegex, '').trim();

        const cleanedContent = stripUrlsAndInlineCitations(rawText);
        if (!cleanedContent) {
          continue;
        }

        const topicCheck = passesTopicRelevanceCheck(
          safeQuestion,
          safeAnswer,
          cleanedContent
        );
        if (!topicCheck.isRelevant) {
          console.warn('[/api/extra-info] Discarded off-topic fallback response:', {
            messageId: safeMessageId || null,
            model,
            expectedTerms: topicCheck.expectedTerms,
            responsePreview: cleanedContent.slice(0, 200),
          });
          res.json({
            content: '',
            sources: [],
            hasConflict: false,
            noReliableSources: false,
            noRelevantInfo: true,
            isGeneralKnowledgeFallback: true,
            fallbackNotice,
            groundedErrors,
          });
          return;
        }

        res.json({
          content: cleanedContent,
          sources: [],
          hasConflict: hasConflictMarker,
          noReliableSources: false,
          noRelevantInfo: false,
          isGeneralKnowledgeFallback: true,
          fallbackNotice,
          groundedErrors,
          model,
        });
        return;
      }

      // 3. Both grounded and ungrounded attempts failed -> log fatal error and return real details
      const finalErr = lastFallbackError ?? lastGroundedError;
      if (finalErr) {
        console.error('[/api/extra-info] All grounded and fallback attempts failed:', {
          status: finalErr.status,
          code: finalErr.code,
          message: finalErr.message.slice(0, 300),
          groundedErrors,
        });
        const userMessage = finalErr.isRateLimit
          ? finalErr.retryDelaySeconds
            ? `Gemini API rate limit reached. Please wait ${finalErr.retryDelaySeconds} seconds and try again.`
            : finalErr.message ||
              'Gemini API rate limit or quota reached. Please wait a moment and try again.'
          : finalErr.code === 'API_KEY_INVALID'
          ? 'Gemini API authentication failed. Please check your API key in Settings > Secrets.'
          : finalErr.message || 'Unable to fetch additional information right now.';

        res.status(finalErr.status).json({
          error: userMessage,
          code: finalErr.code,
          retryable: finalErr.isRateLimit || finalErr.isTransientServerError,
          retryAfterSeconds: finalErr.retryDelaySeconds,
          groundedErrors,
        });
        return;
      }

      res.status(500).json({
        error: 'Unable to fetch additional information right now.',
        code: 'AI_ERROR',
        retryable: false,
        groundedErrors,
      });
    } catch (err) {
      const parsed = inspectGeminiError(err);
      console.error('[/api/extra-info] unhandled error:', {
        status: parsed.status,
        code: parsed.code,
        retryDelaySeconds: parsed.retryDelaySeconds ?? null,
        message: parsed.message,
      });
      res.status(parsed.status).json({
        error: parsed.message || 'Unable to fetch additional information right now.',
        code: parsed.code,
        retryable: parsed.isRateLimit || parsed.isTransientServerError,
        retryAfterSeconds: parsed.retryDelaySeconds,
      });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DocuMind AI server running on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
