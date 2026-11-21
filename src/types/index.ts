export type ResponseLanguage = 'en' | 'ta';

export type AppView = 'chat' | 'documents' | 'study' | 'search';

export interface PDFPageContent {
  pageNumber: number;
  text: string;
  fileName: string;
}

export interface DocumentChunk {
  id: string;
  docId: string;
  fileName: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
}

export interface VectorRecord extends DocumentChunk {
  embedding: number[];
}

export interface RetrievedChunk extends DocumentChunk {
  score: number;
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  chunkCount: number;
  characterCount: number;
  uploadedAt: number;
}

export type UploadStage = 'extracting' | 'chunking' | 'embedding' | 'ready' | 'error';

export interface UploadJob {
  id: string;
  fileName: string;
  fileSize: number;
  stage: UploadStage;
  progress: number; // 0 to 100
  detail: string;
  warning?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  sources?: RetrievedChunk[];
  isStreaming?: boolean;
  isError?: boolean;
  language?: ResponseLanguage;
  generalKnowledgeUsed?: boolean;
  commandLabel?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  selectedDocIds: string[]; // empty means all documents
  language: ResponseLanguage;
  createdAt: number;
  updatedAt: number;
}

export interface AppStats {
  totalQuestionsAsked: number;
  totalSummariesGenerated: number;
  totalQuizzesGenerated: number;
}

export interface MCQItem {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  sourceFile: string;
  sourcePage: number;
}

export interface ShortAnswerItem {
  question: string;
  answer: string;
  keyPoints: string[];
  sourceFile: string;
  sourcePage: number;
}

export interface SearchHit {
  chunk: DocumentChunk;
  score: number;
  matchType: 'semantic' | 'keyword' | 'hybrid';
  semanticScore?: number;
  keywordScore?: number;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
}

export type VoiceEngine = 'browser' | 'gemini';

export type GeminiVoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export type PlaybackRate = 0.75 | 1 | 1.25 | 1.5;

export type TTSStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface SavedBrowserVoice {
  voiceURI: string;
  name: string;
}

export interface LanguageVoicePreferences {
  browser: SavedBrowserVoice | null;
  gemini: GeminiVoiceName;
}

export interface VoiceSettings {
  engine: VoiceEngine;
  voices: Record<ResponseLanguage, LanguageVoicePreferences>;
  speed: PlaybackRate;
  autoRead: boolean;
}

export interface TTSState {
  activeMessageId: string | null;
  status: TTSStatus;
  progress: number; // 0..100
  speed: PlaybackRate;
  engineUsed: VoiceEngine | null;
  modelUsed: string | null;
  activeVoiceLabel: string | null;
  isFallback: boolean;
  fallbackReason: string | null;
  error: string | null;
  missingTamilBrowserVoice: boolean;
  midPlaybackFallbackPrompt: boolean;
  voiceChangedPrompt: boolean;
  notice: string | null;
  previewingKey: string | null;
  previewError: string | null;
}

export type AudioOverviewSpeaker = 'Host A' | 'Host B';

export interface AudioOverviewTurn {
  speaker: AudioOverviewSpeaker;
  text: string;
}

export interface AudioOverviewSegmentRange {
  startTurn: number;
  endTurn: number; // exclusive
}

export interface AudioOverviewCacheRecord {
  cacheKey: string;
  docIds: string[];
  docNames: string[];
  language: ResponseLanguage;
  voiceA: GeminiVoiceName;
  voiceB: GeminiVoiceName;
  script: AudioOverviewTurn[];
  audioChunks: Blob[];
  chunkDurations: number[];
  segmentRanges: AudioOverviewSegmentRange[];
  createdAt: number;
}

export interface WebSource {
  title: string;
  uri: string;
  domain: string;
}

export interface GroundedSearchError {
  model: string;
  status: number | null;
  message: string;
}

export interface ExtraInfoRecord {
  cacheKey: string;
  messageId: string;
  language: ResponseLanguage;
  content: string;
  sources: WebSource[];
  hasConflict: boolean;
  noReliableSources: boolean;
  noRelevantInfo?: boolean;
  isGeneralKnowledgeFallback?: boolean;
  fallbackNotice?: string;
  groundedErrors?: GroundedSearchError[];
  fetchedAt: number;
}


