import type {
  ChatMessage,
  DocumentChunk,
  MCQItem,
  ResponseLanguage,
  RetrievedChunk,
  ShortAnswerItem,
} from '../types';
import { embedQuery } from './embeddingService';
import { vectorStore } from './vectorStore';

export const NOT_FOUND_REPLY =
  "I couldn't find this information in your uploaded documents.";

function languageInstruction(language: ResponseLanguage): string {
  if (language === 'ta') {
    return 'Respond in clear, natural Tamil (தமிழ்) using simple everyday language. Keep technical terms or code readable where appropriate. However, if the answer is NOT in the provided context (and the user did not explicitly request general knowledge), you MUST reply with the exact English sentence: "I couldn\'t find this information in your uploaded documents."';
  }
  return 'Respond in clear, simple English that is easy to understand.';
}

function buildRAGSystemPrompt(language: ResponseLanguage): string {
  return `You are DocuMind AI, a precise, helpful document knowledge assistant.

STRICT GROUNDING RULES:
1. Answer ONLY from the provided DOCUMENT CONTEXT below.
2. If the answer is not contained in the provided DOCUMENT CONTEXT, reply with this exact sentence and nothing else:
${NOT_FOUND_REPLY}
3. NEVER invent facts, figures, quotes, page numbers, or citations. The UI automatically displays verified source cards from the retrieved metadata, so do not fabricate page citations or external references.
4. ONLY use general knowledge if the user EXPLICITLY asks you to use general knowledge or answer outside their documents (for example: "use general knowledge", "from outside my documents", "general knowledge:"). When you do, start that section clearly with the exact heading:
**General knowledge (not from your documents)**
5. ${languageInstruction(language)}
6. Format your answers in clean Markdown. Use headings, concise bullet lists, tables when helpful, and fenced code blocks with language tags for any code or formulas.`;
}

function formatContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (chunk, idx) =>
        `[Excerpt ${idx + 1} | Document: ${chunk.fileName} | Page: ${chunk.pageNumber}]\n${chunk.text}`
    )
    .join('\n\n---\n\n');
}

function userExplicitlyRequestedGeneralKnowledge(question: string): boolean {
  const lower = question.toLowerCase();
  return (
    lower.includes('general knowledge') ||
    lower.includes('outside my document') ||
    lower.includes('outside the document') ||
    lower.includes('outside my pdf') ||
    lower.includes('your own knowledge') ||
    lower.includes('not in the document') ||
    lower.includes('பொது அறிவு')
  );
}

export interface AskRAGOptions {
  question: string;
  history: ChatMessage[];
  selectedDocIds: string[];
  language: ResponseLanguage;
  topK?: number;
  onToken: (delta: string, fullText: string) => void;
  onSourcesRetrieved?: (sources: RetrievedChunk[]) => void;
  signal?: AbortSignal;
}

export interface AskRAGResult {
  answer: string;
  sources: RetrievedChunk[];
  generalKnowledgeUsed: boolean;
}

export async function askQuestionStream(options: AskRAGOptions): Promise<AskRAGResult> {
  const {
    question,
    history,
    selectedDocIds,
    language,
    topK = 5,
    onToken,
    onSourcesRetrieved,
    signal,
  } = options;

  await vectorStore.hydrate();

  const wantsGeneral = userExplicitlyRequestedGeneralKnowledge(question);
  const queryEmbedding = await embedQuery(question, signal);
  const retrievedChunks = await vectorStore.similaritySearch(queryEmbedding, {
    topK,
    docIds: selectedDocIds.length > 0 ? selectedDocIds : undefined,
    minScore: 0.25,
  });

  onSourcesRetrieved?.(retrievedChunks);

  // If nothing relevant was found and user did not ask for general knowledge,
  // short-circuit with the exact required message.
  if (retrievedChunks.length === 0 && !wantsGeneral) {
    onToken(NOT_FOUND_REPLY, NOT_FOUND_REPLY);
    return {
      answer: NOT_FOUND_REPLY,
      sources: [],
      generalKnowledgeUsed: false,
    };
  }

  const contextSection =
    retrievedChunks.length > 0
      ? `DOCUMENT CONTEXT:\n${formatContextBlock(retrievedChunks)}`
      : 'DOCUMENT CONTEXT:\n(No matching excerpts were retrieved from the uploaded documents.)';

  // Include last 6 turns of prior conversation for natural follow-ups
  const recentHistory = history
    .filter((m) => !m.isError && !m.isStreaming && m.content.trim().length > 0)
    .slice(-6)
    .map((m) => ({
      role: m.role === 'user' ? ('user' as const) : ('model' as const),
      parts: [{ text: m.content }],
    }));

  const currentUserMessage = `${contextSection}\n\nUSER QUESTION:\n${question}`;

  const contents = [
    ...recentHistory,
    {
      role: 'user' as const,
      parts: [{ text: currentUserMessage }],
    },
  ];

  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: buildRAGSystemPrompt(language),
      contents,
    }),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errBody?.error || `Request failed (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body unavailable.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const line = event.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        break;
      }
      try {
        const parsed = JSON.parse(payload) as { text?: string; error?: string };
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        if (parsed.text) {
          fullText += parsed.text;
          onToken(parsed.text, fullText);
        }
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) continue;
        throw parseErr;
      }
    }
  }

  const trimmed = fullText.trim();
  const isNotFound = trimmed === NOT_FOUND_REPLY;
  const usedGeneral =
    wantsGeneral || trimmed.toLowerCase().includes('general knowledge (not from your documents)');

  return {
    answer: trimmed || NOT_FOUND_REPLY,
    sources: isNotFound ? [] : retrievedChunks,
    generalKnowledgeUsed: usedGeneral,
  };
}

async function callGenerateAPI(payload: {
  systemInstruction?: string;
  prompt: string;
  schemaType?: 'mcqs' | 'short_answers' | 'suggested_questions';
}): Promise<string> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errBody?.error || `Generation failed (${response.status})`);
  }

  const data = (await response.json()) as { text?: string };
  return data.text ?? '';
}

function sampleRepresentativeChunks(chunks: DocumentChunk[], maxChars = 18000): DocumentChunk[] {
  if (chunks.length === 0) return [];
  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  if (totalChars <= maxChars) return chunks;

  const selected: DocumentChunk[] = [];
  const targetCount = Math.max(6, Math.min(chunks.length, Math.floor(maxChars / 900)));
  const step = chunks.length / targetCount;

  let currentChars = 0;
  for (let i = 0; i < targetCount; i++) {
    const chunk = chunks[Math.min(chunks.length - 1, Math.floor(i * step))];
    if (currentChars + chunk.text.length > maxChars && selected.length > 0) break;
    selected.push(chunk);
    currentChars += chunk.text.length;
  }

  return selected;
}

function groupChunksIntoBatches(chunks: DocumentChunk[], maxBatchChars = 8500): DocumentChunk[][] {
  const batches: DocumentChunk[][] = [];
  let current: DocumentChunk[] = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    if (currentChars + chunk.text.length > maxBatchChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunk.text.length;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

// Map-Reduce summarization for documents of any size
export async function summarizeDocuments(
  docIds: string[],
  language: ResponseLanguage,
  onProgress?: (status: string, percent: number) => void
): Promise<{ summary: string; strategy: 'direct' | 'map-reduce'; chunksProcessed: number }> {
  await vectorStore.hydrate();
  const chunks = vectorStore.getChunks(docIds.length > 0 ? docIds : undefined);
  if (chunks.length === 0) {
    throw new Error('No document content available to summarize. Please upload a PDF first.');
  }

  const langRule =
    language === 'ta'
      ? 'Write the entire summary in clear, simple Tamil (தமிழ்).'
      : 'Write the entire summary in clear, simple English.';

  const batches = groupChunksIntoBatches(chunks, 8500);

  if (batches.length === 1) {
    onProgress?.('Synthesizing document summary...', 45);
    const context = batches[0]
      .map((c) => `[${c.fileName}, Page ${c.pageNumber}]\n${c.text}`)
      .join('\n\n');

    const summary = await callGenerateAPI({
      systemInstruction: `You are DocuMind AI. Create a well-structured, accurate Markdown study summary strictly from the provided document excerpts. Never add facts not present in the text. ${langRule}`,
      prompt: `Summarize the following document content into:\n1. **Executive Overview**\n2. **Key Takeaways** (bullet points)\n3. **Core Concepts & Definitions**\n4. **Important Details & Conclusions**\n\nDOCUMENT CONTENT:\n${context}`,
    });

    onProgress?.('Summary ready', 100);
    return { summary: summary.trim(), strategy: 'direct', chunksProcessed: chunks.length };
  }

  // Map-Reduce for large documents (cap at 14 batches if gigantic by evenly sampling)
  const workingBatches =
    batches.length > 14
      ? Array.from({ length: 14 }, (_, i) => batches[Math.floor((i * batches.length) / 14)])
      : batches;

  const partialSummaries: string[] = [];

  for (let i = 0; i < workingBatches.length; i++) {
    const batch = workingBatches[i];
    const pct = Math.round(((i + 0.5) / (workingBatches.length + 1)) * 90);
    onProgress?.(
      `Map stage: summarizing section ${i + 1} of ${workingBatches.length}...`,
      pct
    );

    const sectionText = batch
      .map((c) => `[${c.fileName}, Page ${c.pageNumber}]\n${c.text}`)
      .join('\n\n');

    const sectionSummary = await callGenerateAPI({
      systemInstruction:
        'You are DocuMind AI performing the Map step of a Map-Reduce document summarization. Extract all key facts, themes, definitions, and conclusions strictly from this section. Do not invent information.',
      prompt: `Extract concise structured notes from Section ${i + 1} of ${workingBatches.length}:\n\n${sectionText}`,
    });

    partialSummaries.push(`### Section ${i + 1} Notes\n${sectionSummary.trim()}`);
  }

  onProgress?.('Reduce stage: combining section summaries into final synthesis...', 92);

  const combinedNotes = partialSummaries.join('\n\n---\n\n');
  const finalSummary = await callGenerateAPI({
    systemInstruction: `You are DocuMind AI performing the Reduce step of a Map-Reduce summarization. Combine the section notes into one cohesive, clean Markdown study summary strictly grounded in the notes. ${langRule}`,
    prompt: `Synthesize the following section summaries into a unified document summary with:\n1. **Executive Overview**\n2. **Key Takeaways**\n3. **Core Concepts & Themes**\n4. **Notable Details & Conclusions**\n\nSECTION NOTES:\n${combinedNotes}`,
  });

  onProgress?.('Summary ready', 100);
  return {
    summary: finalSummary.trim(),
    strategy: 'map-reduce',
    chunksProcessed: chunks.length,
  };
}

export async function generateMCQs(
  docIds: string[],
  count: number,
  language: ResponseLanguage
): Promise<MCQItem[]> {
  await vectorStore.hydrate();
  const chunks = vectorStore.getChunks(docIds.length > 0 ? docIds : undefined);
  if (chunks.length === 0) {
    throw new Error('No uploaded documents available for MCQ generation.');
  }

  const sampled = sampleRepresentativeChunks(chunks, 18000);
  const context = sampled
    .map((c) => `[File: ${c.fileName} | Page: ${c.pageNumber}]\n${c.text}`)
    .join('\n\n---\n\n');

  const safeCount = Math.max(1, Math.min(15, Math.round(count)));
  const langRule =
    language === 'ta'
      ? 'Write all questions, options, and explanations in clear Tamil (தமிழ்). Keep sourceFile as the exact original filename.'
      : 'Write all questions, options, and explanations in clear, simple English.';

  const rawJson = await callGenerateAPI({
    systemInstruction: `You are DocuMind AI. Generate strictly grounded multiple-choice study questions ONLY from the provided document context. Every question must have exactly 4 distinct options and a valid correctIndex (0-3), an explanation grounded in the text, and the exact sourceFile and sourcePage from the excerpt used. ${langRule}`,
    prompt: `Create exactly ${safeCount} multiple-choice questions testing understanding of the key facts and concepts in these excerpts:\n\n${context}`,
    schemaType: 'mcqs',
  });

  const parsed = JSON.parse(rawJson || '{"questions":[]}') as { questions?: MCQItem[] };
  return (parsed.questions ?? []).filter(
    (q) =>
      q.question &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      typeof q.correctIndex === 'number'
  );
}

export async function generateShortAnswers(
  docIds: string[],
  count: number,
  language: ResponseLanguage
): Promise<ShortAnswerItem[]> {
  await vectorStore.hydrate();
  const chunks = vectorStore.getChunks(docIds.length > 0 ? docIds : undefined);
  if (chunks.length === 0) {
    throw new Error('No uploaded documents available for short-answer generation.');
  }

  const sampled = sampleRepresentativeChunks(chunks, 18000);
  const context = sampled
    .map((c) => `[File: ${c.fileName} | Page: ${c.pageNumber}]\n${c.text}`)
    .join('\n\n---\n\n');

  const safeCount = Math.max(1, Math.min(12, Math.round(count)));
  const langRule =
    language === 'ta'
      ? 'Write all questions, model answers, and key points in clear Tamil (தமிழ்). Keep sourceFile as the exact filename.'
      : 'Write all questions, model answers, and key points in clear, simple English.';

  const rawJson = await callGenerateAPI({
    systemInstruction: `You are DocuMind AI. Generate strictly grounded short-answer study questions and concise model answers ONLY from the provided document excerpts. Never invent facts. ${langRule}`,
    prompt: `Generate exactly ${safeCount} short-answer study questions with model answers, 2-4 bullet key points, and exact sourceFile/sourcePage from:\n\n${context}`,
    schemaType: 'short_answers',
  });

  const parsed = JSON.parse(rawJson || '{"items":[]}') as { items?: ShortAnswerItem[] };
  return parsed.items ?? [];
}

export async function explainConceptSimply(
  topic: string,
  docIds: string[],
  language: ResponseLanguage
): Promise<{ explanation: string; sources: RetrievedChunk[] }> {
  await vectorStore.hydrate();
  const query = topic.trim() || 'Explain the main concepts of this document simply';
  const queryEmbedding = await embedQuery(query);
  const retrieved = await vectorStore.similaritySearch(queryEmbedding, {
    topK: 5,
    docIds: docIds.length > 0 ? docIds : undefined,
    minScore: 0.22,
  });

  if (retrieved.length === 0) {
    return {
      explanation: NOT_FOUND_REPLY,
      sources: [],
    };
  }

  const context = formatContextBlock(retrieved);
  const langRule =
    language === 'ta'
      ? 'Explain in very simple, beginner-friendly Tamil (தமிழ்) with clear analogies.'
      : 'Explain in very simple, beginner-friendly English using everyday analogies and short paragraphs.';

  const explanation = await callGenerateAPI({
    systemInstruction: `You are DocuMind AI. Explain the topic simply and clearly based ONLY on the provided document excerpts. If the topic is not covered in the excerpts, reply exactly: "${NOT_FOUND_REPLY}". Format in clean Markdown. ${langRule}`,
    prompt: `DOCUMENT EXCERPTS:\n${context}\n\nTOPIC TO EXPLAIN SIMPLY:\n${query}`,
  });

  const cleaned = explanation.trim();
  return {
    explanation: cleaned || NOT_FOUND_REPLY,
    sources: cleaned === NOT_FOUND_REPLY ? [] : retrieved,
  };
}

export async function generateSuggestedQuestions(
  docIds: string[],
  language: ResponseLanguage
): Promise<string[]> {
  await vectorStore.hydrate();
  const chunks = vectorStore.getChunks(docIds.length > 0 ? docIds : undefined);
  if (chunks.length === 0) return [];

  const sampled = sampleRepresentativeChunks(chunks, 6000);
  const context = sampled
    .map((c) => `[${c.fileName}, p.${c.pageNumber}] ${c.text.slice(0, 600)}`)
    .join('\n\n');

  const langRule =
    language === 'ta'
      ? 'Write the questions in Tamil (தமிழ்).'
      : 'Write the questions in concise, natural English.';

  try {
    const rawJson = await callGenerateAPI({
      systemInstruction: `Generate 4 crisp, insightful questions that can be answered directly from the document excerpts. Each question should be under 14 words. ${langRule}`,
      prompt: `Document excerpts:\n${context}`,
      schemaType: 'suggested_questions',
    });
    const parsed = JSON.parse(rawJson || '{"questions":[]}') as { questions?: string[] };
    return (parsed.questions ?? []).slice(0, 4);
  } catch {
    return language === 'ta'
      ? [
          'இந்த ஆவணத்தின் முக்கிய கருத்துகள் என்ன?',
          'முக்கிய முடிவுகள் மற்றும் பரிந்துரைகளை சுருக்கமாகக் கூறுங்கள்.',
          'இதில் குறிப்பிடப்பட்டுள்ள முக்கிய வரையறைகள் என்ன?',
          'முக்கிய செயல்முறைகளை எளிமையாக விளக்குங்கள்.',
        ]
      : [
          'What are the main ideas covered in these documents?',
          'Summarize the key findings and conclusions.',
          'What key terms or definitions are introduced?',
          'Explain the core methodology or steps in simple terms.',
        ];
  }
}
