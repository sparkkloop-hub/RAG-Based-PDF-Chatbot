import type { DocumentChunk, RetrievedChunk, SearchHit, VectorRecord } from '../types';
import { deleteVectorsByDocId, getAllVectors, saveVectorsBatch } from './storageService';

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

class InMemoryVectorStore {
  private records: VectorRecord[] = [];
  private hydrated = false;
  private hydratingPromise: Promise<void> | null = null;

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydratingPromise) return this.hydratingPromise;

    this.hydratingPromise = getAllVectors()
      .then((all) => {
        this.records = all;
        this.hydrated = true;
      })
      .finally(() => {
        this.hydratingPromise = null;
      });

    return this.hydratingPromise;
  }

  async addVectors(newRecords: VectorRecord[]): Promise<void> {
    await this.hydrate();
    await saveVectorsBatch(newRecords);
    const existingIds = new Set(newRecords.map((r) => r.id));
    this.records = this.records.filter((r) => !existingIds.has(r.id)).concat(newRecords);
  }

  async deleteDocumentVectors(docId: string): Promise<void> {
    await this.hydrate();
    await deleteVectorsByDocId(docId);
    this.records = this.records.filter((r) => r.docId !== docId);
  }

  getTotalVectorCount(): number {
    return this.records.length;
  }

  getChunks(docIds?: string[]): DocumentChunk[] {
    const filterSet = docIds && docIds.length > 0 ? new Set(docIds) : null;
    return this.records
      .filter((r) => (!filterSet ? true : filterSet.has(r.docId)))
      .map(({ embedding: _embedding, ...chunk }) => chunk)
      .sort((a, b) => {
        if (a.docId !== b.docId) return a.fileName.localeCompare(b.fileName);
        if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
        return a.chunkIndex - b.chunkIndex;
      });
  }

  async similaritySearch(
    queryEmbedding: number[],
    options: { topK?: number; docIds?: string[]; minScore?: number } = {}
  ): Promise<RetrievedChunk[]> {
    await this.hydrate();
    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.2;
    const filterSet = options.docIds && options.docIds.length > 0 ? new Set(options.docIds) : null;

    const scored: RetrievedChunk[] = [];
    for (const rec of this.records) {
      if (filterSet && !filterSet.has(rec.docId)) continue;
      const score = cosineSimilarity(queryEmbedding, rec.embedding);
      if (score >= minScore) {
        const { embedding: _embedding, ...chunk } = rec;
        scored.push({ ...chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  keywordSearch(
    query: string,
    options: { topK?: number; docIds?: string[] } = {}
  ): SearchHit[] {
    const topK = options.topK ?? 12;
    const filterSet = options.docIds && options.docIds.length > 0 ? new Set(options.docIds) : null;
    const cleaned = query.trim().toLowerCase();
    if (!cleaned) return [];

    const terms = cleaned
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter((t) => t.length >= 2);

    if (terms.length === 0) return [];

    const hits: SearchHit[] = [];

    for (const rec of this.records) {
      if (filterSet && !filterSet.has(rec.docId)) continue;
      const lower = rec.text.toLowerCase();
      let matchedTerms = 0;
      let totalOccurrences = 0;

      for (const term of terms) {
        let idx = lower.indexOf(term);
        if (idx !== -1) {
          matchedTerms++;
          while (idx !== -1) {
            totalOccurrences++;
            idx = lower.indexOf(term, idx + term.length);
          }
        }
      }

      if (matchedTerms === 0) continue;

      const exactPhraseBonus = lower.includes(cleaned) ? 0.35 : 0;
      const coverage = matchedTerms / terms.length;
      const freqBoost = Math.min(totalOccurrences / 8, 0.25);
      const score = Math.min(1, coverage * 0.65 + freqBoost + exactPhraseBonus);

      const { embedding: _embedding, ...chunk } = rec;
      hits.push({
        chunk,
        score,
        matchType: 'keyword',
        keywordScore: score,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  async hybridSearch(
    query: string,
    queryEmbedding: number[],
    options: { topK?: number; docIds?: string[] } = {}
  ): Promise<SearchHit[]> {
    await this.hydrate();
    const topK = options.topK ?? 12;

    const [semanticResults, keywordResults] = await Promise.all([
      this.similaritySearch(queryEmbedding, {
        topK: topK * 2,
        docIds: options.docIds,
        minScore: 0.25,
      }),
      Promise.resolve(
        this.keywordSearch(query, { topK: topK * 2, docIds: options.docIds })
      ),
    ]);

    const merged = new Map<string, SearchHit>();

    for (const sem of semanticResults) {
      const { score, ...chunk } = sem;
      merged.set(chunk.id, {
        chunk,
        score,
        matchType: 'semantic',
        semanticScore: score,
      });
    }

    for (const kw of keywordResults) {
      const existing = merged.get(kw.chunk.id);
      if (existing) {
        const semScore = existing.semanticScore ?? 0;
        const kwScore = kw.keywordScore ?? kw.score;
        merged.set(kw.chunk.id, {
          chunk: kw.chunk,
          score: Math.min(1, semScore * 0.65 + kwScore * 0.35 + 0.08),
          matchType: 'hybrid',
          semanticScore: semScore,
          keywordScore: kwScore,
        });
      } else {
        merged.set(kw.chunk.id, kw);
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export const vectorStore = new InMemoryVectorStore();
