import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFPageContent } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export class PDFValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PDFValidationError';
  }
}

export class PDFExtractionError extends Error {
  code: 'NO_TEXT_LAYER' | 'PASSWORD_PROTECTED' | 'CORRUPT_PDF' | 'UNKNOWN';

  constructor(
    message: string,
    code: 'NO_TEXT_LAYER' | 'PASSWORD_PROTECTED' | 'CORRUPT_PDF' | 'UNKNOWN' = 'UNKNOWN'
  ) {
    super(message);
    this.name = 'PDFExtractionError';
    this.code = code;
  }
}

export function validatePDFFile(file: File): void {
  const isPdfType =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdfType) {
    throw new PDFValidationError(
      `"${file.name}" is not a PDF file. Only PDF documents (.pdf) are supported.`
    );
  }
  if (file.size === 0) {
    throw new PDFValidationError(`"${file.name}" is empty (0 bytes).`);
  }
  if (file.size > MAX_PDF_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new PDFValidationError(
      `"${file.name}" is ${sizeMb} MB, which exceeds the 20 MB limit per file.`
    );
  }
}

export interface PDFExtractionResult {
  fileName: string;
  pageCount: number;
  pages: PDFPageContent[];
  totalCharacters: number;
}

export async function extractTextFromPDF(
  file: File,
  onProgress?: (progress: number, detail: string) => void
): Promise<PDFExtractionResult> {
  validatePDFFile(file);
  onProgress?.(5, 'Reading PDF file...');

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    useSystemFonts: true,
  });
  let pdfDoc: pdfjsLib.PDFDocumentProxy;

  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('password')) {
      throw new PDFExtractionError(
        `"${file.name}" is password-protected. Please remove the password and upload it again.`,
        'PASSWORD_PROTECTED'
      );
    }
    throw new PDFExtractionError(
      `Could not open "${file.name}". The file may be corrupted or an unsupported PDF format.`,
      'CORRUPT_PDF'
    );
  }

  const pageCount = pdfDoc.numPages;
  const pages: PDFPageContent[] = [];
  let totalCharacters = 0;

  try {
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      const lines: string[] = [];
      let currentLine = '';
      let lastY: number | null = null;

      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const textItem = item as { str: string; hasEOL?: boolean; transform?: number[] };
        const str = textItem.str;
        const y = textItem.transform ? Math.round(textItem.transform[5]) : null;

        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          if (currentLine.trim()) {
            lines.push(currentLine.trim());
          }
          // Larger vertical gap suggests paragraph boundary
          if (Math.abs(y - lastY) > 18) {
            lines.push('');
          }
          currentLine = str;
        } else {
          if (currentLine && str && !currentLine.endsWith(' ') && !str.startsWith(' ')) {
            currentLine += ' ' + str;
          } else {
            currentLine += str;
          }
        }

        if (textItem.hasEOL) {
          if (currentLine.trim()) {
            lines.push(currentLine.trim());
          }
          currentLine = '';
          lastY = null;
        } else {
          lastY = y;
        }
      }

      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }

      const cleanedText = lines
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (cleanedText.length > 0) {
        pages.push({
          pageNumber: pageNum,
          text: cleanedText,
          fileName: file.name,
        });
        totalCharacters += cleanedText.length;
      }

      const pct = Math.round((pageNum / pageCount) * 100);
      onProgress?.(pct, `Extracting page ${pageNum} of ${pageCount}`);
    }
  } finally {
    await loadingTask.destroy();
  }

  if (totalCharacters < 20) {
    throw new PDFExtractionError(
      `"${file.name}" has no extractable text layer (it appears to be a scanned image PDF or blank document). Please run OCR on this PDF or upload a text-based PDF.`,
      'NO_TEXT_LAYER'
    );
  }

  return {
    fileName: file.name,
    pageCount,
    pages,
    totalCharacters,
  };
}
