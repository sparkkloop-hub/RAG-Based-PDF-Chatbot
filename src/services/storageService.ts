import type {
  AppStats,
  AudioOverviewCacheRecord,
  Conversation,
  DocumentRecord,
  ExtraInfoRecord,
  ResponseLanguage,
  VectorRecord,
} from '../types';

const DB_NAME = 'documind_ai_db';
const DB_VERSION = 4;

const STORE_DOCUMENTS = 'documents';
const STORE_VECTORS = 'vectors';
const STORE_CONVERSATIONS = 'conversations';
const STORE_PDF_FILES = 'pdfFiles';
const STORE_AUDIO_OVERVIEWS = 'audioOverviews';
const STORE_EXTRA_INFO = 'extraInfo';

const STATS_KEY = 'documind_stats_v1';
const LANGUAGE_KEY = 'documind_language_v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_VECTORS)) {
        const vecStore = db.createObjectStore(STORE_VECTORS, { keyPath: 'id' });
        vecStore.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PDF_FILES)) {
        db.createObjectStore(STORE_PDF_FILES, { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO_OVERVIEWS)) {
        db.createObjectStore(STORE_AUDIO_OVERVIEWS, { keyPath: 'cacheKey' });
      }
      if (!db.objectStoreNames.contains(STORE_EXTRA_INFO)) {
        db.createObjectStore(STORE_EXTRA_INFO, { keyPath: 'cacheKey' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });

  return dbPromise;
}

function txPromise<T>(
  storeName: string,
  mode: IDBTransactionMode,
  executor: (store: IDBObjectStore, resolve: (val: T) => void, reject: (err: unknown) => void) => void
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        tx.onerror = () => reject(tx.error);
        executor(store, resolve, reject);
      })
  );
}

// Documents
export async function getAllDocuments(): Promise<DocumentRecord[]> {
  const docs = await txPromise<DocumentRecord[]>(STORE_DOCUMENTS, 'readonly', (store, resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as DocumentRecord[]);
    req.onerror = () => reject(req.error);
  });
  return docs.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export async function saveDocument(doc: DocumentRecord): Promise<void> {
  await txPromise<void>(STORE_DOCUMENTS, 'readwrite', (store, resolve, reject) => {
    const req = store.put(doc);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDocumentRecord(docId: string): Promise<void> {
  await txPromise<void>(STORE_DOCUMENTS, 'readwrite', (store, resolve, reject) => {
    const req = store.delete(docId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Original PDF Blobs
export interface StoredPdfFile {
  docId: string;
  fileName: string;
  blob: Blob;
  savedAt: number;
}

export async function savePdfFile(
  docId: string,
  fileName: string,
  blob: Blob
): Promise<void> {
  const record: StoredPdfFile = {
    docId,
    fileName,
    blob,
    savedAt: Date.now(),
  };
  await txPromise<void>(STORE_PDF_FILES, 'readwrite', (store, resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getPdfFile(docId: string): Promise<StoredPdfFile | null> {
  return txPromise<StoredPdfFile | null>(
    STORE_PDF_FILES,
    'readonly',
    (store, resolve, reject) => {
      const req = store.get(docId);
      req.onsuccess = () => resolve((req.result as StoredPdfFile | undefined) ?? null);
      req.onerror = () => reject(req.error);
    }
  );
}

export async function deletePdfFile(docId: string): Promise<void> {
  await txPromise<void>(STORE_PDF_FILES, 'readwrite', (store, resolve, reject) => {
    const req = store.delete(docId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Audio Overview Cache
export async function getAudioOverviewCache(
  cacheKey: string
): Promise<AudioOverviewCacheRecord | null> {
  return txPromise<AudioOverviewCacheRecord | null>(
    STORE_AUDIO_OVERVIEWS,
    'readonly',
    (store, resolve, reject) => {
      const req = store.get(cacheKey);
      req.onsuccess = () =>
        resolve((req.result as AudioOverviewCacheRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    }
  );
}

export async function saveAudioOverviewCache(
  record: AudioOverviewCacheRecord
): Promise<void> {
  await txPromise<void>(STORE_AUDIO_OVERVIEWS, 'readwrite', (store, resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAudioOverviewsByDocId(docId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO_OVERVIEWS, 'readwrite');
    const store = tx.objectStore(STORE_AUDIO_OVERVIEWS);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as AudioOverviewCacheRecord;
        if (Array.isArray(val.docIds) && val.docIds.includes(docId)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Additional Information (Web Grounding) Cache
export async function getExtraInfoCache(
  cacheKey: string
): Promise<ExtraInfoRecord | null> {
  return txPromise<ExtraInfoRecord | null>(
    STORE_EXTRA_INFO,
    'readonly',
    (store, resolve, reject) => {
      const req = store.get(cacheKey);
      req.onsuccess = () =>
        resolve((req.result as ExtraInfoRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    }
  );
}

export async function saveExtraInfoCache(record: ExtraInfoRecord): Promise<void> {
  await txPromise<void>(STORE_EXTRA_INFO, 'readwrite', (store, resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteExtraInfoCacheByMessageId(messageId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_EXTRA_INFO, 'readwrite');
    const store = tx.objectStore(STORE_EXTRA_INFO);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as ExtraInfoRecord;
        if (val.messageId === messageId) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Vectors
export async function getAllVectors(): Promise<VectorRecord[]> {
  return txPromise<VectorRecord[]>(STORE_VECTORS, 'readonly', (store, resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as VectorRecord[]);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVectorsBatch(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_VECTORS, 'readwrite');
    const store = tx.objectStore(STORE_VECTORS);
    for (const rec of records) {
      store.put(rec);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteVectorsByDocId(docId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_VECTORS, 'readwrite');
    const store = tx.objectStore(STORE_VECTORS);
    const index = store.index('docId');
    const req = index.openCursor(IDBKeyRange.only(docId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Conversations
export async function getAllConversations(): Promise<Conversation[]> {
  const list = await txPromise<Conversation[]>(STORE_CONVERSATIONS, 'readonly', (store, resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as Conversation[]);
    req.onerror = () => reject(req.error);
  });
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await txPromise<void>(STORE_CONVERSATIONS, 'readwrite', (store, resolve, reject) => {
    const req = store.put(conversation);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteConversationRecord(conversationId: string): Promise<void> {
  await txPromise<void>(STORE_CONVERSATIONS, 'readwrite', (store, resolve, reject) => {
    const req = store.delete(conversationId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Stats & preferences (localStorage)
const DEFAULT_STATS: AppStats = {
  totalQuestionsAsked: 0,
  totalSummariesGenerated: 0,
  totalQuizzesGenerated: 0,
};

export function loadStats(): AppStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { ...DEFAULT_STATS };
    const parsed = JSON.parse(raw) as Partial<AppStats>;
    return {
      totalQuestionsAsked: Number(parsed.totalQuestionsAsked) || 0,
      totalSummariesGenerated: Number(parsed.totalSummariesGenerated) || 0,
      totalQuizzesGenerated: Number(parsed.totalQuizzesGenerated) || 0,
    };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export function saveStats(stats: AppStats): void {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadLanguagePreference(): ResponseLanguage {
  try {
    const val = localStorage.getItem(LANGUAGE_KEY);
    return val === 'ta' ? 'ta' : 'en';
  } catch {
    return 'en';
  }
}

export function saveLanguagePreference(lang: ResponseLanguage): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // Ignore storage errors
  }
}
