import { useCallback, useEffect, useRef, useState } from 'react';
import { chunkDocumentPages } from '../services/chunkService';
import { embedDocumentChunks } from '../services/embeddingService';
import { extractTextFromPDF, validatePDFFile } from '../services/pdfService';
import {
  askQuestionStream,
  explainConceptSimply,
  generateMCQs,
  generateShortAnswers,
  generateSuggestedQuestions,
  summarizeDocuments,
} from '../services/ragService';
import {
  deleteAudioOverviewsByDocId,
  deleteConversationRecord,
  deleteDocumentRecord,
  deletePdfFile,
  getAllConversations,
  getAllDocuments,
  loadLanguagePreference,
  loadStats,
  saveConversation,
  saveDocument,
  saveLanguagePreference,
  savePdfFile,
  saveStats,
} from '../services/storageService';
import { vectorStore } from '../services/vectorStore';
import type {
  AppStats,
  ChatMessage,
  Conversation,
  DocumentRecord,
  ResponseLanguage,
  UploadJob,
  VectorRecord,
} from '../types';
import { createId } from '../utils/format';

interface UseDocuMindOptions {
  onToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
}

function createEmptyConversation(
  language: ResponseLanguage,
  selectedDocIds: string[] = []
): Conversation {
  const now = Date.now();
  return {
    id: createId('conv'),
    title: 'New Conversation',
    messages: [],
    selectedDocIds,
    language,
    createdAt: now,
    updatedAt: now,
  };
}

export function useDocuMind({ onToast }: UseDocuMindOptions) {
  const [isBooting, setIsBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]); // empty = all docs
  const [language, setLanguageState] = useState<ResponseLanguage>(() => loadLanguagePreference());
  const [stats, setStats] = useState<AppStats>(() => loadStats());
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? null;

  // Hydrate IndexedDB on boot
  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        await vectorStore.hydrate();
        const [docs, convs] = await Promise.all([getAllDocuments(), getAllConversations()]);
        if (!mounted) return;
        setDocuments(docs);
        setConversations(convs);
        if (convs.length > 0) {
          setActiveConversationId(convs[0].id);
          setSelectedDocIds(
            convs[0].selectedDocIds.filter((id) => docs.some((d) => d.id === id))
          );
        }
      } catch (err) {
        if (!mounted) return;
        setBootError(
          err instanceof Error
            ? err.message
            : 'Failed to initialize browser storage (IndexedDB).'
        );
      } finally {
        if (mounted) setIsBooting(false);
      }
    }
    init();
    return () => {
      mounted = false;
    };
  }, []);

  // Load tailored suggested questions when documents or language change
  useEffect(() => {
    if (isBooting) return;
    if (documents.length === 0) {
      setSuggestedQuestions([]);
      return;
    }

    let cancelled = false;
    setIsLoadingSuggestions(true);
    generateSuggestedQuestions(selectedDocIds, language)
      .then((qs) => {
        if (!cancelled) setSuggestedQuestions(qs);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSuggestions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [documents.length, selectedDocIds.join(','), language, isBooting]);

  const setLanguage = useCallback((lang: ResponseLanguage) => {
    setLanguageState(lang);
    saveLanguagePreference(lang);
  }, []);

  const incrementStat = useCallback((key: keyof AppStats) => {
    setStats((prev) => {
      const next = { ...prev, [key]: prev[key] + 1 };
      saveStats(next);
      return next;
    });
  }, []);

  const updateJob = useCallback((jobId: string, patch: Partial<UploadJob>) => {
    setUploadJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, ...patch } : job))
    );
  }, []);

  const dismissUploadJob = useCallback((jobId: string) => {
    setUploadJobs((prev) => prev.filter((job) => job.id !== jobId));
  }, []);

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      for (const file of files) {
        const jobId = createId('upload');

        try {
          validatePDFFile(file);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid file.';
          onToast('error', 'Upload rejected', message);
          setUploadJobs((prev) => [
            {
              id: jobId,
              fileName: file.name,
              fileSize: file.size,
              stage: 'error',
              progress: 0,
              detail: 'Validation failed',
              error: message,
            },
            ...prev,
          ]);
          continue;
        }

        setUploadJobs((prev) => [
          {
            id: jobId,
            fileName: file.name,
            fileSize: file.size,
            stage: 'extracting',
            progress: 2,
            detail: 'Starting PDF extraction...',
          },
          ...prev,
        ]);

        try {
          // 1. Extract text page by page
          const extracted = await extractTextFromPDF(file, (pct, detail) => {
            updateJob(jobId, {
              stage: 'extracting',
              progress: Math.round(pct * 0.3), // 0-30%
              detail,
            });
          });

          // 2. Chunk with RecursiveCharacterTextSplitter
          const docId = createId('doc');
          updateJob(jobId, {
            stage: 'chunking',
            progress: 35,
            detail: 'Splitting text into overlapping chunks...',
          });

          let chunks = chunkDocumentPages(
            docId,
            extracted.pages,
            { chunkSize: 1000, chunkOverlap: 150 },
            (pct, detail) => {
              updateJob(jobId, {
                stage: 'chunking',
                progress: 30 + Math.round(pct * 0.15), // 30-45%
                detail,
              });
            }
          );

          // For large documents (> 1500 chunks), increase chunk size to ~1500 with 150 overlap
          if (chunks.length > 1500) {
            updateJob(jobId, {
              stage: 'chunking',
              progress: 42,
              detail: `Large document (${chunks.length} chunks). Optimizing chunk size...`,
            });
            chunks = chunkDocumentPages(docId, extracted.pages, {
              chunkSize: 1500,
              chunkOverlap: 150,
            });
          }

          if (chunks.length === 0) {
            throw new Error(`No usable text chunks were created from "${file.name}".`);
          }

          // 3. Embed chunks with Gemini embedding model (sequential batches of 20)
          updateJob(jobId, {
            stage: 'embedding',
            progress: 45,
            detail: `Embedding 0 / ${chunks.length} chunks`,
          });

          const embedResult = await embedDocumentChunks(chunks, (pct, detail) => {
            updateJob(jobId, {
              stage: 'embedding',
              progress: 45 + Math.round(pct * 0.5), // 45-95%
              detail,
            });
          });

          if (embedResult.records.length === 0) {
            throw new Error(
              `No text chunks from "${file.name}" could be embedded. Check the console for details or try re-uploading.`
            );
          }

          const vectorRecords: VectorRecord[] = embedResult.records;

          // 4. Persist vectors & metadata to IndexedDB
          await vectorStore.addVectors(vectorRecords);

          const docRecord: DocumentRecord = {
            id: docId,
            fileName: file.name,
            fileSize: file.size,
            pageCount: extracted.pageCount,
            chunkCount: vectorRecords.length,
            characterCount: extracted.totalCharacters,
            uploadedAt: Date.now(),
          };
          await saveDocument(docRecord);
          await savePdfFile(docId, file.name, file);

          setDocuments((prev) => [docRecord, ...prev]);

          const skippedWarning =
            embedResult.skippedCount > 0
              ? `${embedResult.skippedCount} ${
                  embedResult.skippedCount === 1 ? 'chunk' : 'chunks'
                } skipped`
              : undefined;

          updateJob(jobId, {
            stage: 'ready',
            progress: 100,
            detail: `${extracted.pageCount} pages · ${vectorRecords.length} chunks indexed`,
            warning: skippedWarning,
          });

          onToast(
            'success',
            'Document indexed',
            skippedWarning
              ? `"${file.name}" is ready (${vectorRecords.length} chunks indexed, ${skippedWarning}).`
              : `"${file.name}" (${extracted.pageCount} pages, ${vectorRecords.length} chunks) is ready.`
          );

          // Automatically clear finished job banner after 10s (longer if warning present)
          setTimeout(
            () => {
              setUploadJobs((prev) => prev.filter((j) => j.id !== jobId));
            },
            skippedWarning ? 14000 : 7000
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to process PDF.';
          updateJob(jobId, {
            stage: 'error',
            progress: 0,
            detail: 'Processing failed',
            error: message,
          });
          onToast('error', `Could not process ${file.name}`, message);
        }
      }
    },
    [onToast, updateJob]
  );

  const deleteDocument = useCallback(
    async (docId: string) => {
      const target = documents.find((d) => d.id === docId);
      try {
        await vectorStore.deleteDocumentVectors(docId);
        await deleteDocumentRecord(docId);
        await deletePdfFile(docId);
        await deleteAudioOverviewsByDocId(docId);
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
        setSelectedDocIds((prev) => prev.filter((id) => id !== docId));
        onToast(
          'info',
          'Document removed',
          target ? `"${target.fileName}" and all its vectors were deleted.` : undefined
        );
      } catch (err) {
        onToast(
          'error',
          'Delete failed',
          err instanceof Error ? err.message : 'Could not delete document.'
        );
      }
    },
    [documents, onToast]
  );

  const toggleDocSelection = useCallback((docId: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    );
  }, []);

  const selectAllDocs = useCallback(() => {
    setSelectedDocIds([]);
  }, []);

  const startNewChat = useCallback(
    (docIdsOverride?: string[]) => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        setIsGenerating(false);
      }
      const nextSelected = docIdsOverride ?? selectedDocIds;
      setSelectedDocIds(nextSelected);
      const conv = createEmptyConversation(language, nextSelected);
      setConversations((prev) => [conv, ...prev]);
      setActiveConversationId(conv.id);
      saveConversation(conv).catch(() => {});
      return conv;
    },
    [language, selectedDocIds]
  );

  const selectConversation = useCallback(
    (convId: string) => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        setIsGenerating(false);
      }
      setActiveConversationId(convId);
      const found = conversations.find((c) => c.id === convId);
      if (found) {
        setSelectedDocIds(
          found.selectedDocIds.filter((id) => documents.some((d) => d.id === id))
        );
      }
    },
    [conversations, documents]
  );

  const deleteConversation = useCallback(
    async (convId: string) => {
      await deleteConversationRecord(convId);
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== convId);
        if (activeConversationId === convId) {
          setActiveConversationId(remaining[0]?.id ?? null);
        }
        return remaining;
      });
      onToast('info', 'Conversation deleted');
    },
    [activeConversationId, onToast]
  );

  const clearActiveConversation = useCallback(async () => {
    if (!activeConversationId) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsGenerating(false);
    }

    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id !== activeConversationId) return conv;
        const cleared: Conversation = {
          ...conv,
          title: 'New Conversation',
          messages: [],
          updatedAt: Date.now(),
        };
        saveConversation(cleared).catch(() => {});
        return cleared;
      })
    );
    onToast('info', 'Conversation cleared');
  }, [activeConversationId, onToast]);

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  const persistConversationUpdate = useCallback((updated: Conversation) => {
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === updated.id);
      const list = exists
        ? prev.map((c) => (c.id === updated.id ? updated : c))
        : [updated, ...prev];
      return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    saveConversation(updated).catch(() => {});
  }, []);

  const runSlashCommandInChat = useCallback(
    async (
      rawInput: string,
      conv: Conversation,
      userMsg: ChatMessage,
      assistantMsgId: string
    ) => {
      const trimmed = rawInput.trim();
      const [cmd, ...restParts] = trimmed.split(/\s+/);
      const arg = restParts.join(' ').trim();
      const lowerCmd = cmd.toLowerCase();

      const updateAssistant = (patch: Partial<ChatMessage>) => {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== conv.id) return c;
            const nextMsgs = c.messages.map((m) =>
              m.id === assistantMsgId ? { ...m, ...patch } : m
            );
            const nextConv = { ...c, messages: nextMsgs, updatedAt: Date.now() };
            if (!patch.isStreaming) {
              saveConversation(nextConv).catch(() => {});
            }
            return nextConv;
          })
        );
      };

      if (lowerCmd === '/summarize' || lowerCmd === '/summary') {
        const result = await summarizeDocuments(selectedDocIds, language, (status) => {
          updateAssistant({ content: `*${status}*`, isStreaming: true });
        });
        incrementStat('totalSummariesGenerated');
        updateAssistant({
          content: result.summary,
          isStreaming: false,
          commandLabel:
            result.strategy === 'map-reduce'
              ? `Map-Reduce Summary (${result.chunksProcessed} chunks)`
              : `Document Summary (${result.chunksProcessed} chunks)`,
        });
        return;
      }

      if (lowerCmd === '/mcq' || lowerCmd === '/mcqs') {
        const parsedCount = parseInt(arg, 10);
        const count = Number.isFinite(parsedCount) && parsedCount > 0 ? Math.min(15, parsedCount) : 5;
        updateAssistant({
          content: `*Generating ${count} multiple-choice questions from your documents...*`,
          isStreaming: true,
        });
        const items = await generateMCQs(selectedDocIds, count, language);
        incrementStat('totalQuizzesGenerated');
        const letters = ['A', 'B', 'C', 'D'];
        const md = items
          .map(
            (q, i) =>
              `### ${i + 1}. ${q.question}\n` +
              q.options.map((opt, oi) => `- **${letters[oi] ?? oi + 1}.** ${opt}`).join('\n') +
              `\n\n> **Answer:** ${letters[q.correctIndex] ?? q.correctIndex + 1} — ${q.explanation} *(Source: ${q.sourceFile}, Page ${q.sourcePage})*`
          )
          .join('\n\n---\n\n');
        updateAssistant({
          content: md || 'Could not generate MCQs from the selected documents.',
          isStreaming: false,
          commandLabel: `${items.length} MCQs Generated`,
        });
        return;
      }

      if (lowerCmd === '/short-answer' || lowerCmd === '/short' || lowerCmd === '/questions') {
        const parsedCount = parseInt(arg, 10);
        const count = Number.isFinite(parsedCount) && parsedCount > 0 ? Math.min(12, parsedCount) : 5;
        updateAssistant({
          content: `*Generating ${count} short-answer study questions...*`,
          isStreaming: true,
        });
        const items = await generateShortAnswers(selectedDocIds, count, language);
        incrementStat('totalQuizzesGenerated');
        const md = items
          .map(
            (item, i) =>
              `### ${i + 1}. ${item.question}\n**Model Answer:** ${item.answer}\n\n**Key Points:**\n` +
              item.keyPoints.map((kp) => `- ${kp}`).join('\n') +
              `\n\n*Source: ${item.sourceFile}, Page ${item.sourcePage}*`
          )
          .join('\n\n---\n\n');
        updateAssistant({
          content: md || 'Could not generate short-answer questions.',
          isStreaming: false,
          commandLabel: `${items.length} Short-Answer Questions`,
        });
        return;
      }

      if (lowerCmd === '/explain') {
        updateAssistant({
          content: '*Retrieving relevant sections and preparing a simple explanation...*',
          isStreaming: true,
        });
        const topic = arg || userMsg.content.replace(/^\/explain\s*/i, '');
        const res = await explainConceptSimply(topic, selectedDocIds, language);
        updateAssistant({
          content: res.explanation,
          sources: res.sources,
          isStreaming: false,
          commandLabel: 'Simple Explanation',
        });
        return;
      }

      throw new Error(
        `Unknown slash command "${cmd}". Available commands: /summarize, /mcq [count], /short-answer [count], /explain [topic].`
      );
    },
    [incrementStat, language, selectedDocIds]
  );

  const sendMessage = useCallback(
    async (rawInput: string, options?: { baseHistory?: ChatMessage[]; existingConv?: Conversation }) => {
      const text = rawInput.trim();
      if (!text || isGenerating) return;

      if (documents.length === 0) {
        onToast(
          'info',
          'Upload a PDF first',
          'Upload at least one PDF document so DocuMind AI can answer from your knowledge base.'
        );
        return;
      }

      let conv = options?.existingConv ?? activeConversation;
      if (!conv) {
        conv = createEmptyConversation(language, selectedDocIds);
        setActiveConversationId(conv.id);
      }

      const historyBefore = options?.baseHistory ?? conv.messages;
      const isFirstMessage = historyBefore.length === 0;
      const title = isFirstMessage
        ? text.replace(/^\/\S+\s*/, '').slice(0, 52) || text.slice(0, 52)
        : conv.title;

      const userMsg: ChatMessage = {
        id: createId('msg'),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        language,
      };

      const assistantMsgId = createId('msg');
      const placeholderAssistant: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        language,
      };

      const updatedConv: Conversation = {
        ...conv,
        title,
        selectedDocIds,
        language,
        messages: [...historyBefore, userMsg, placeholderAssistant],
        updatedAt: Date.now(),
      };

      persistConversationUpdate(updatedConv);
      setActiveConversationId(updatedConv.id);
      incrementStat('totalQuestionsAsked');

      const controller = new AbortController();
      abortRef.current = controller;
      setIsGenerating(true);

      try {
        if (text.startsWith('/')) {
          await runSlashCommandInChat(text, updatedConv, userMsg, assistantMsgId);
        } else {
          const result = await askQuestionStream({
            question: text,
            history: historyBefore,
            selectedDocIds,
            language,
            topK: 5,
            signal: controller.signal,
            onSourcesRetrieved: (sources) => {
              setConversations((prev) =>
                prev.map((c) => {
                  if (c.id !== updatedConv.id) return c;
                  return {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantMsgId ? { ...m, sources } : m
                    ),
                  };
                })
              );
            },
            onToken: (_delta, fullText) => {
              setConversations((prev) =>
                prev.map((c) => {
                  if (c.id !== updatedConv.id) return c;
                  return {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: fullText } : m
                    ),
                  };
                })
              );
            },
          });

          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== updatedConv.id) return c;
              const finalConv: Conversation = {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: result.answer,
                        sources: result.sources,
                        generalKnowledgeUsed: result.generalKnowledgeUsed,
                        isStreaming: false,
                      }
                    : m
                ),
                updatedAt: Date.now(),
              };
              saveConversation(finalConv).catch(() => {});
              return finalConv;
            })
          );
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        const errorText = isAbort
          ? 'Generation stopped.'
          : err instanceof Error
          ? err.message
          : 'Something went wrong while generating an answer.';

        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== updatedConv.id) return c;
            const finalConv: Conversation = {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      content: m.content ? `${m.content}\n\n*${errorText}*` : errorText,
                      isStreaming: false,
                      isError: !isAbort,
                    }
                  : m
              ),
              updatedAt: Date.now(),
            };
            saveConversation(finalConv).catch(() => {});
            return finalConv;
          })
        );

        if (!isAbort) {
          onToast('error', 'Response failed', errorText);
        }
      } finally {
        abortRef.current = null;
        setIsGenerating(false);
      }
    },
    [
      activeConversation,
      documents.length,
      incrementStat,
      isGenerating,
      language,
      onToast,
      persistConversationUpdate,
      runSlashCommandInChat,
      selectedDocIds,
    ]
  );

  const regenerateMessage = useCallback(
    (assistantMessageId: string) => {
      if (!activeConversation || isGenerating) return;
      const idx = activeConversation.messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      const precedingUser = activeConversation.messages[idx - 1];
      if (!precedingUser || precedingUser.role !== 'user') return;

      const baseHistory = activeConversation.messages.slice(0, idx - 1);
      sendMessage(precedingUser.content, {
        baseHistory,
        existingConv: activeConversation,
      });
    },
    [activeConversation, isGenerating, sendMessage]
  );

  return {
    isBooting,
    bootError,
    documents,
    conversations,
    activeConversation,
    selectedDocIds,
    language,
    stats,
    uploadJobs,
    suggestedQuestions,
    isLoadingSuggestions,
    isGenerating,
    setLanguage,
    uploadFiles,
    dismissUploadJob,
    deleteDocument,
    toggleDocSelection,
    selectAllDocs,
    startNewChat,
    selectConversation,
    deleteConversation,
    clearActiveConversation,
    sendMessage,
    regenerateMessage,
    stopGeneration,
    incrementStat,
  };
}
