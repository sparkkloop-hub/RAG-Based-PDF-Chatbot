import type { DocumentChunk, PDFPageContent } from '../types';

export interface RecursiveSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
}

export class RecursiveCharacterTextSplitter {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly separators: string[];

  constructor(options: RecursiveSplitterOptions = {}) {
    this.chunkSize = options.chunkSize ?? 1000;
    this.chunkOverlap = Math.min(options.chunkOverlap ?? 150, Math.floor(this.chunkSize / 2));
    this.separators = options.separators ?? [
      '\n\n',
      '\n',
      '. ',
      '? ',
      '! ',
      '; ',
      ', ',
      ' ',
      '',
    ];
  }

  splitText(text: string): string[] {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    return this.splitRecursive(normalized, this.separators);
  }

  private splitRecursive(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    let chosenSeparator = '';
    let remainingSeparators: string[] = [];

    for (let i = 0; i < separators.length; i++) {
      const sep = separators[i];
      if (sep === '') {
        chosenSeparator = '';
        remainingSeparators = [];
        break;
      }
      if (text.includes(sep)) {
        chosenSeparator = sep;
        remainingSeparators = separators.slice(i + 1);
        break;
      }
    }

    const splits = chosenSeparator
      ? text.split(chosenSeparator).filter((part) => part.length > 0)
      : this.sliceFixed(text);

    const finalChunks: string[] = [];
    const goodSplits: string[] = [];

    for (const part of splits) {
      if (part.length <= this.chunkSize) {
        goodSplits.push(part);
      } else {
        if (goodSplits.length > 0) {
          finalChunks.push(...this.mergeSplits(goodSplits, chosenSeparator));
          goodSplits.length = 0;
        }
        if (remainingSeparators.length === 0) {
          finalChunks.push(...this.sliceFixed(part));
        } else {
          finalChunks.push(...this.splitRecursive(part, remainingSeparators));
        }
      }
    }

    if (goodSplits.length > 0) {
      finalChunks.push(...this.mergeSplits(goodSplits, chosenSeparator));
    }

    return finalChunks.map((c) => c.trim()).filter(Boolean);
  }

  private mergeSplits(splits: string[], separator: string): string[] {
    const chunks: string[] = [];
    const currentDocs: string[] = [];
    let currentLen = 0;
    const sepLen = separator.length;

    for (const split of splits) {
      const len = split.length;
      const addedLen = currentDocs.length > 0 ? len + sepLen : len;

      if (currentLen + addedLen > this.chunkSize && currentDocs.length > 0) {
        const doc = currentDocs.join(separator).trim();
        if (doc) chunks.push(doc);

        while (
          currentLen > this.chunkOverlap ||
          (currentLen + len + (currentDocs.length > 0 ? sepLen : 0) > this.chunkSize &&
            currentLen > 0)
        ) {
          const removed = currentDocs.shift();
          if (removed !== undefined) {
            currentLen -= removed.length + (currentDocs.length > 0 ? sepLen : 0);
          }
        }
      }

      currentDocs.push(split);
      currentLen += currentDocs.length > 1 ? len + sepLen : len;
    }

    if (currentDocs.length > 0) {
      const doc = currentDocs.join(separator).trim();
      if (doc) chunks.push(doc);
    }

    return chunks;
  }

  private sliceFixed(text: string): string[] {
    const result: string[] = [];
    const step = Math.max(1, this.chunkSize - this.chunkOverlap);
    for (let i = 0; i < text.length; i += step) {
      const slice = text.slice(i, i + this.chunkSize).trim();
      if (slice) result.push(slice);
      if (i + this.chunkSize >= text.length) break;
    }
    return result;
  }
}

export function chunkDocumentPages(
  docId: string,
  pages: PDFPageContent[],
  options?: RecursiveSplitterOptions,
  onProgress?: (progress: number, detail: string) => void
): DocumentChunk[] {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: options?.chunkSize ?? 1000,
    chunkOverlap: options?.chunkOverlap ?? 150,
    separators: options?.separators,
  });

  const chunks: DocumentChunk[] = [];
  let globalIndex = 0;

  pages.forEach((page, idx) => {
    const pageTexts = splitter.splitText(page.text);
    for (const text of pageTexts) {
      chunks.push({
        id: `${docId}_p${page.pageNumber}_c${globalIndex}`,
        docId,
        fileName: page.fileName,
        pageNumber: page.pageNumber,
        chunkIndex: globalIndex,
        text,
      });
      globalIndex++;
    }

    const pct = Math.round(((idx + 1) / Math.max(1, pages.length)) * 100);
    onProgress?.(pct, `Created ${chunks.length} text chunks`);
  });

  return chunks;
}
