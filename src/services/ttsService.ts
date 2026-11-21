import type {
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceEngine,
} from '../types';
import {
  DEFAULT_VOICE_SETTINGS,
  GEMINI_VOICES,
  loadVoiceSettings,
  PLAYBACK_SPEEDS,
  saveVoiceSettings,
  voiceSettingsStore,
  type VoiceSettingsChangeEvent,
} from './voiceSettingsStore';

export {
  DEFAULT_VOICE_SETTINGS,
  GEMINI_VOICES,
  loadVoiceSettings,
  PLAYBACK_SPEEDS,
  saveVoiceSettings,
  voiceSettingsStore,
};

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
export const BROWSER_TTS_MODEL = 'browser-speech-synthesis';

export const MISSING_TAMIL_VOICE_MESSAGE =
  'No Tamil voice is available in this browser. Switch to Gemini voice in Settings.';

export const MID_PLAYBACK_GEMINI_FAILED_MESSAGE =
  'Gemini voice failed. Continue with browser voice?';

export const VOICE_CHANGED_PROMPT_MESSAGE =
  'Voice changed. Replay with the new voice?';

const TTS_CACHE_KEY_VERSION = 'tts_v3';
const TTS_CACHE_VERSION_STORAGE_KEY = 'documind_tts_cache_version';

const PREVIEW_SAMPLE_TEXT: Record<ResponseLanguage, string> = {
  en: 'Hello, this is a preview of the selected voice in DocuMind.',
  ta: 'வணக்கம், இது தேர்ந்தெடுக்கப்பட்ட குரலின் மாதிரி ஒலி.',
};

/**
 * Clean Markdown answer text before speaking aloud.
 */
export function cleanTextForSpeech(markdown: string, language: ResponseLanguage): string {
  if (!markdown) return '';

  const codeReplacement =
    language === 'ta' ? ' குறியீட்டுப் பகுதி தவிர்க்கப்பட்டது. ' : ' code block omitted. ';

  let text = markdown;

  text = text.replace(/```[\s\S]*?```/g, codeReplacement);
  text = text.replace(/~~~[\s\S]*?~~~/g, codeReplacement);
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^\s*([-*_]){3,}\s*$/gm, ' ');
  text = text.replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ');
  text = text.replace(/\|/g, ', ');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\[\s*(?:Excerpt\s*)?\d+(?:\s*,\s*\d+)*\s*\]/gi, '');
  text = text.replace(/\(\s*Source:[^)]+\)/gi, '');
  text = text.replace(/\bpp\.\s*(\d+)\s*[-–]\s*(\d+)/gi, 'pages $1 to $2');
  text = text.replace(/\bpp\.\s*(\d+)/gi, 'pages $1');
  text = text.replace(/\bp\.\s*(\d+)/gi, 'page $1');

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/,\s*,/g, ',')
    .trim();

  return text;
}

/**
 * Split cleaned speech text at sentence boundaries.
 * - Browser speechSynthesis uses ~200 char chunks to avoid Chrome cutoffs.
 * - Gemini TTS uses ~400-560 char chunks so there are fewer seams.
 */
export function splitIntoSpeechChunks(text: string, maxChars = 200): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const rawSentences = cleaned
    .split(/(?<=[.?!।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  const pushOversized = (sentence: string) => {
    const words = sentence.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > maxChars) {
        chunks.push(current.trim());
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
  };

  for (const sentence of rawSentences) {
    if (sentence.length > maxChars) {
      if (buffer) {
        chunks.push(buffer.trim());
        buffer = '';
      }
      pushOversized(sentence);
      continue;
    }

    if (buffer && buffer.length + 1 + sentence.length > maxChars) {
      chunks.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }

  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }

  return chunks;
}

/**
 * Speed-independent 64-bit hash of the text content.
 */
function hashTextContent(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}_${(h1 >>> 0).toString(16)}`;
}

/**
 * Cache key includes engine + model + voiceName + language + speed-independent text hash.
 * Changing engine, model, voice, or language can never hit another voice's cached audio.
 */
export function buildAudioCacheKey(params: {
  engine: VoiceEngine;
  model: string;
  voiceName: string;
  language: ResponseLanguage;
  text: string;
}): string {
  const { engine, model, voiceName, language, text } = params;
  return `${TTS_CACHE_KEY_VERSION}::${engine}::${model}::${voiceName}::${language}::${hashTextContent(
    text
  )}`;
}

function formatVoiceLabel(params: {
  engine: VoiceEngine;
  voiceName: string;
  model: string;
  isFallback?: boolean;
}): string {
  const { engine, voiceName, model, isFallback } = params;
  if (engine === 'gemini') {
    return `${voiceName} - Gemini - ${model}`;
  }
  return isFallback ? `${voiceName} - Browser (fallback)` : `${voiceName} - Browser`;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isWavBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function ensureWavBlob(base64Audio: string): Blob {
  const raw = base64ToUint8Array(base64Audio);
  if (isWavBytes(raw)) {
    return new Blob([raw.buffer as ArrayBuffer], { type: 'audio/wav' });
  }

  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = raw.byteLength;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(raw);
  return new Blob([buffer], { type: 'audio/wav' });
}

interface ResolvedBrowserVoice {
  voice: SpeechSynthesisVoice | null;
  lang: string;
  voiceName: string;
  label: string;
  unavailableNotice: string | null;
}

interface CachedGeminiAudio {
  blob: Blob;
  model: string;
  voiceName: string;
}

interface GeminiChunkResult {
  blob: Blob;
  model: string;
  voiceName: string;
  cacheHit: boolean;
}

interface ReplayTarget {
  messageId: string;
  rawMarkdown: string;
  language: ResponseLanguage;
}

/**
 * Immutable voice & language configuration locked once at the moment Listen is pressed.
 * Never re-resolved between chunks.
 */
interface PlaybackSession {
  id: number;
  messageId: string;
  rawMarkdown: string;
  engine: VoiceEngine;
  model: string;
  language: ResponseLanguage;
  speed: PlaybackRate;
  cleanedText: string;
  chunks: string[];
  currentChunkIdx: number;
  hasPlayedAnyAudio: boolean;
  browserVoice: SpeechSynthesisVoice | null;
  browserLang: string;
  geminiVoice: GeminiVoiceName;
  voiceName: string;
  voiceLabel: string;
  isFallback: boolean;
  fallbackReason: string | null;
  savedBrowserPref: SavedBrowserVoice | null;
}

export interface PreviewVoiceParams {
  key: string;
  engine: VoiceEngine;
  language: ResponseLanguage;
  browserVoiceURI?: string | null;
  browserVoiceName?: string | null;
  geminiVoiceName?: GeminiVoiceName;
}

type StateListener = (state: TTSState) => void;
type VoicesListener = (voices: SpeechSynthesisVoice[]) => void;

class TTSService {
  private state: TTSState = {
    activeMessageId: null,
    status: 'idle',
    progress: 0,
    speed: voiceSettingsStore.getState().speed,
    engineUsed: null,
    modelUsed: null,
    activeVoiceLabel: null,
    isFallback: false,
    fallbackReason: null,
    error: null,
    missingTamilBrowserVoice: false,
    midPlaybackFallbackPrompt: false,
    voiceChangedPrompt: false,
    notice: null,
    previewingKey: null,
    previewError: null,
  };

  private listeners = new Set<StateListener>();
  private voicesListeners = new Set<VoicesListener>();
  private browserVoices: SpeechSynthesisVoice[] = [];
  private audioCache = new Map<string, CachedGeminiAudio>();

  // Keep fallback voice fixed per language if the user's saved voice becomes unavailable
  private fixedFallbackByLang: Partial<Record<ResponseLanguage, SavedBrowserVoice>> = {};

  // Active locked playback session
  private sessionSeq = 0;
  private activeSession: PlaybackSession | null = null;
  private pendingReplay: ReplayTarget | null = null;
  private abortController: AbortController | null = null;

  // Gemini audio element (used for message playback)
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl: string | null = null;

  // Preview playback state (independent of audio cache)
  private previewSeq = 0;
  private previewAbortController: AbortController | null = null;
  private previewAudio: HTMLAudioElement | null = null;
  private previewAudioUrl: string | null = null;

  constructor() {
    this.ensureCacheVersion();

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.refreshBrowserVoices();
      // voiceschanged ONLY updates the voice list; never switches voices or interrupts playback
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        this.refreshBrowserVoices();
      });
    }

    // Subscribe directly to the single-source-of-truth voiceSettingsStore
    voiceSettingsStore.subscribe((event) => {
      this.handleStoreChange(event);
    });
  }

  private ensureCacheVersion(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const storedVersion = localStorage.getItem(TTS_CACHE_VERSION_STORAGE_KEY);
      if (storedVersion !== TTS_CACHE_KEY_VERSION) {
        this.audioCache.clear();
        localStorage.setItem(TTS_CACHE_VERSION_STORAGE_KEY, TTS_CACHE_KEY_VERSION);
      }
    } catch {
      // Ignore storage errors
    }
  }

  private handleStoreChange(event: VoiceSettingsChangeEvent): void {
    const { next, kinds, changedLanguage } = event;

    if (kinds.includes('voice')) {
      if (changedLanguage) {
        this.clearFixedFallback(changedLanguage);
      } else {
        this.fixedFallbackByLang = {};
      }
    }

    const engineOrVoiceChanged = kinds.includes('engine') || kinds.includes('voice');

    // Live speed update without interrupting active playback
    if (kinds.includes('speed') && !engineOrVoiceChanged) {
      this.applySpeedLive(next.speed);
      return;
    }

    if (!engineOrVoiceChanged) {
      return;
    }

    // If audio is currently loading, playing, or paused, stop immediately and prompt to replay
    const session = this.activeSession;
    const isSessionActive =
      session !== null &&
      (this.state.status === 'loading' ||
        this.state.status === 'playing' ||
        this.state.status === 'paused');

    if (isSessionActive && session) {
      const affectsActiveSession =
        kinds.includes('engine') ||
        !changedLanguage ||
        changedLanguage === session.language;

      if (affectsActiveSession) {
        this.interruptForVoiceChange(session, next.speed);
      }
    }
  }

  private interruptForVoiceChange(session: PlaybackSession, nextSpeed: PlaybackRate): void {
    this.pendingReplay = {
      messageId: session.messageId,
      rawMarkdown: session.rawMarkdown,
      language: session.language,
    };

    this.sessionSeq++;
    this.activeSession = null;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.isBrowserTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel errors
      }
    }

    this.cleanupAudioElement();

    this.setState({
      activeMessageId: session.messageId,
      status: 'idle',
      progress: 0,
      speed: nextSpeed,
      engineUsed: null,
      modelUsed: null,
      activeVoiceLabel: null,
      isFallback: false,
      fallbackReason: null,
      error: null,
      missingTamilBrowserVoice: false,
      midPlaybackFallbackPrompt: false,
      voiceChangedPrompt: true,
      notice: null,
    });
  }

  private emit() {
    const snapshot = { ...this.state };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private setState(patch: Partial<TTSState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private logPlaybackStart(info: {
    engine: VoiceEngine;
    voice: string;
    language: ResponseLanguage;
    model: string;
    cacheHit: boolean;
    preview?: boolean;
  }): void {
    console.log('[TTS] Playback start', {
      engine: info.engine,
      voice: info.voice,
      language: info.language,
      model: info.model,
      cacheHit: info.cacheHit,
      ...(info.preview ? { preview: true } : {}),
    });
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeVoices(listener: VoicesListener): () => void {
    this.voicesListeners.add(listener);
    this.refreshBrowserVoices();
    listener([...this.browserVoices]);
    return () => {
      this.voicesListeners.delete(listener);
    };
  }

  getState(): TTSState {
    return { ...this.state };
  }

  isBrowserTTSSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /**
   * Updates only the available browser voice list.
   * Never mutates the active playback session or selected voice.
   */
  refreshBrowserVoices(): SpeechSynthesisVoice[] {
    if (!this.isBrowserTTSSupported()) return [];
    const list = window.speechSynthesis.getVoices();
    if (list.length > 0) {
      this.browserVoices = list;
      for (const listener of this.voicesListeners) {
        listener([...this.browserVoices]);
      }
    }
    return [...this.browserVoices];
  }

  /**
   * Re-reads live speechSynthesis.getVoices(). If empty, waits for voiceschanged
   * with a 2-second timeout before resolving.
   */
  async waitForBrowserVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
    if (!this.isBrowserTTSSupported()) return [];

    const immediate = window.speechSynthesis.getVoices();
    if (immediate.length > 0) {
      this.browserVoices = immediate;
      for (const listener of this.voicesListeners) {
        listener([...this.browserVoices]);
      }
      return [...immediate];
    }

    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
        const latest = window.speechSynthesis.getVoices();
        if (latest.length > 0) {
          this.browserVoices = latest;
          for (const listener of this.voicesListeners) {
            listener([...this.browserVoices]);
          }
          resolve([...latest]);
          return;
        }
        resolve([...this.browserVoices]);
      };

      const onVoicesChanged = () => {
        const list = window.speechSynthesis.getVoices();
        if (list.length > 0) {
          finish();
        }
      };

      const timer = setTimeout(finish, timeoutMs);
      window.speechSynthesis.addEventListener?.('voiceschanged', onVoicesChanged);
    });
  }

  private filterVoicesForLanguage(
    voices: SpeechSynthesisVoice[],
    language: ResponseLanguage
  ): SpeechSynthesisVoice[] {
    if (language === 'ta') {
      return voices.filter(
        (v) =>
          v.lang.toLowerCase().startsWith('ta') ||
          v.name.toLowerCase().includes('tamil')
      );
    }
    return voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  }

  getBrowserVoicesForLanguage(language: ResponseLanguage): SpeechSynthesisVoice[] {
    const live = this.isBrowserTTSSupported() ? window.speechSynthesis.getVoices() : [];
    const source = live.length > 0 ? live : this.browserVoices;
    return this.filterVoicesForLanguage(source, language);
  }

  findSavedBrowserVoice(
    language: ResponseLanguage,
    saved: SavedBrowserVoice | null,
    liveVoices?: SpeechSynthesisVoice[]
  ): SpeechSynthesisVoice | null {
    if (!saved) return null;
    const allLive =
      liveVoices ??
      (this.isBrowserTTSSupported() ? window.speechSynthesis.getVoices() : this.browserVoices);
    const matching = this.filterVoicesForLanguage(allLive, language);

    // Match strictly by voiceURI first (in matching language, then across all live voices)
    if (saved.voiceURI) {
      const byUri =
        matching.find((v) => v.voiceURI === saved.voiceURI) ??
        allLive.find((v) => v.voiceURI === saved.voiceURI);
      if (byUri) return byUri;
    }

    if (saved.name) {
      const byName =
        matching.find((v) => v.name === saved.name) ??
        allLive.find((v) => v.name === saved.name);
      if (byName) return byName;
    }

    return null;
  }

  clearFixedFallback(language: ResponseLanguage): void {
    delete this.fixedFallbackByLang[language];
  }

  private pickDefaultBrowserVoice(
    matching: SpeechSynthesisVoice[],
    language: ResponseLanguage
  ): SpeechSynthesisVoice | null {
    if (matching.length === 0) return null;
    if (language === 'ta') {
      return matching.find((v) => v.lang.toLowerCase() === 'ta-in') ?? matching[0];
    }
    return (
      matching.find((v) => v.lang.toLowerCase() === 'en-in') ??
      matching.find((v) => v.lang.toLowerCase() === 'en-us') ??
      matching.find((v) => v.default) ??
      matching[0]
    );
  }

  /**
   * Resolves a browser voice ONCE at playback time against live speechSynthesis.getVoices().
   * - Selects by voiceURI first, then name.
   * - If saved voice is unavailable, keeps a fixed fallback per language and reports a notice.
   * - Only picks a default if no saved voice exists.
   */
  resolveBrowserVoiceOnce(
    language: ResponseLanguage,
    saved: SavedBrowserVoice | null,
    liveVoices?: SpeechSynthesisVoice[],
    isEngineFallback = false
  ): ResolvedBrowserVoice {
    const allLive =
      liveVoices ??
      (this.isBrowserTTSSupported() ? window.speechSynthesis.getVoices() : this.browserVoices);
    const matching = this.filterVoicesForLanguage(allLive, language);
    const defaultLang = language === 'ta' ? 'ta-IN' : 'en-IN';

    if (matching.length === 0 && !saved) {
      return {
        voice: null,
        lang: defaultLang,
        voiceName: 'Browser default',
        label: formatVoiceLabel({
          engine: 'browser',
          voiceName: 'Browser default',
          model: BROWSER_TTS_MODEL,
          isFallback: isEngineFallback,
        }),
        unavailableNotice: null,
      };
    }

    if (saved) {
      const exact = this.findSavedBrowserVoice(language, saved, allLive);
      if (exact) {
        delete this.fixedFallbackByLang[language];
        return {
          voice: exact,
          lang: exact.lang || defaultLang,
          voiceName: exact.name,
          label: formatVoiceLabel({
            engine: 'browser',
            voiceName: exact.name,
            model: BROWSER_TTS_MODEL,
            isFallback: isEngineFallback,
          }),
          unavailableNotice: null,
        };
      }

      // Saved voice is unavailable: reuse previously locked fallback or pick one and lock it
      let fallbackVoice: SpeechSynthesisVoice | null = null;
      const existingFallback = this.fixedFallbackByLang[language];
      if (existingFallback) {
        fallbackVoice = this.findSavedBrowserVoice(language, existingFallback, allLive);
      }
      if (!fallbackVoice) {
        fallbackVoice = this.pickDefaultBrowserVoice(matching, language);
        if (fallbackVoice) {
          this.fixedFallbackByLang[language] = {
            voiceURI: fallbackVoice.voiceURI,
            name: fallbackVoice.name,
          };
        }
      }

      const fallbackName = fallbackVoice?.name ?? 'Browser default';
      return {
        voice: fallbackVoice,
        lang: fallbackVoice?.lang || defaultLang,
        voiceName: fallbackName,
        label: formatVoiceLabel({
          engine: 'browser',
          voiceName: fallbackName,
          model: BROWSER_TTS_MODEL,
          isFallback: isEngineFallback,
        }),
        unavailableNotice: fallbackVoice
          ? `Saved voice "${saved.name}" is unavailable. Using ${fallbackVoice.name} until you choose another voice.`
          : `Saved voice "${saved.name}" is unavailable.`,
      };
    }

    // No saved voice: use previously locked default for this language or pick once
    let chosen: SpeechSynthesisVoice | null = null;
    const existingDefault = this.fixedFallbackByLang[language];
    if (existingDefault) {
      chosen = this.findSavedBrowserVoice(language, existingDefault, allLive);
    }
    if (!chosen) {
      chosen = this.pickDefaultBrowserVoice(matching, language);
      if (chosen) {
        this.fixedFallbackByLang[language] = {
          voiceURI: chosen.voiceURI,
          name: chosen.name,
        };
      }
    }

    const chosenName = chosen?.name ?? 'Browser default';
    return {
      voice: chosen,
      lang: chosen?.lang || defaultLang,
      voiceName: chosenName,
      label: formatVoiceLabel({
        engine: 'browser',
        voiceName: chosenName,
        model: BROWSER_TTS_MODEL,
        isFallback: isEngineFallback,
      }),
      unavailableNotice: null,
    };
  }

  private stopActivePlaybackOnly(): void {
    this.sessionSeq++;
    this.activeSession = null;
    this.pendingReplay = null;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.isBrowserTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel errors
      }
    }

    this.cleanupAudioElement();
  }

  stop(): void {
    this.stopPreviewInternal(false);
    this.stopActivePlaybackOnly();

    this.setState({
      activeMessageId: null,
      status: 'idle',
      progress: 0,
      engineUsed: null,
      modelUsed: null,
      activeVoiceLabel: null,
      isFallback: false,
      fallbackReason: null,
      error: null,
      missingTamilBrowserVoice: false,
      midPlaybackFallbackPrompt: false,
      voiceChangedPrompt: false,
      notice: null,
      previewingKey: null,
      previewError: null,
    });
  }

  dismissVoiceChangedPrompt(): void {
    this.pendingReplay = null;
    if (this.state.voiceChangedPrompt) {
      this.setState({
        activeMessageId: null,
        voiceChangedPrompt: false,
      });
    }
  }

  async replayAfterVoiceChange(): Promise<void> {
    const target = this.pendingReplay;
    if (!target) {
      this.dismissVoiceChangedPrompt();
      return;
    }
    this.pendingReplay = null;
    await this.speak(target);
  }

  private cleanupAudioElement(): void {
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.ontimeupdate = null;
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    if (this.currentAudioUrl) {
      URL.revokeObjectURL(this.currentAudioUrl);
      this.currentAudioUrl = null;
    }
  }

  private cleanupPreviewAudioElement(): void {
    if (this.previewAudio) {
      this.previewAudio.onended = null;
      this.previewAudio.onerror = null;
      this.previewAudio.pause();
      this.previewAudio.src = '';
      this.previewAudio = null;
    }
    if (this.previewAudioUrl) {
      URL.revokeObjectURL(this.previewAudioUrl);
      this.previewAudioUrl = null;
    }
  }

  private stopPreviewInternal(cancelSpeechQueue: boolean): void {
    this.previewSeq++;
    if (this.previewAbortController) {
      this.previewAbortController.abort();
      this.previewAbortController = null;
    }
    this.cleanupPreviewAudioElement();
    if (cancelSpeechQueue && this.isBrowserTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel errors
      }
    }
  }

  stopPreview(): void {
    const hadPreview = this.state.previewingKey !== null || this.state.previewError !== null;
    this.stopPreviewInternal(true);
    if (hadPreview) {
      this.setState({
        previewingKey: null,
        previewError: null,
      });
    }
  }

  /**
   * Plays a short sample in the exact requested voice, bypassing the audio cache.
   */
  async previewVoice(params: PreviewVoiceParams): Promise<void> {
    const { key, engine, language, browserVoiceURI, browserVoiceName, geminiVoiceName } = params;

    // Clicking Preview again on the currently playing row stops it
    if (this.state.previewingKey === key) {
      this.stopPreview();
      return;
    }

    // Stop any existing message playback or previous preview cleanly
    this.stopPreviewInternal(false);
    if (this.activeSession) {
      this.stopActivePlaybackOnly();
      this.setState({
        activeMessageId: null,
        status: 'idle',
        progress: 0,
        engineUsed: null,
        modelUsed: null,
        activeVoiceLabel: null,
        isFallback: false,
        fallbackReason: null,
        error: null,
        missingTamilBrowserVoice: false,
        midPlaybackFallbackPrompt: false,
        voiceChangedPrompt: false,
        notice: null,
      });
    }

    const previewId = ++this.previewSeq;
    const sampleText = PREVIEW_SAMPLE_TEXT[language];
    const speed = voiceSettingsStore.getState().speed;

    this.setState({
      previewingKey: key,
      previewError: null,
    });

    if (engine === 'browser') {
      if (!this.isBrowserTTSSupported()) {
        this.setState({
          previewingKey: null,
          previewError: 'Browser speech synthesis is not supported here.',
        });
        return;
      }

      const liveVoices = await this.waitForBrowserVoices(2000);
      if (this.previewSeq !== previewId) return;

      const savedPref: SavedBrowserVoice | null = browserVoiceURI
        ? { voiceURI: browserVoiceURI, name: browserVoiceName || browserVoiceURI }
        : null;

      const resolved = this.resolveBrowserVoiceOnce(language, savedPref, liveVoices, false);

      if (language === 'ta' && !resolved.voice) {
        this.setState({
          previewingKey: null,
          previewError: MISSING_TAMIL_VOICE_MESSAGE,
        });
        return;
      }

      if (!resolved.voice && liveVoices.length === 0) {
        this.setState({
          previewingKey: null,
          previewError: 'No browser voices are available.',
        });
        return;
      }

      // Always cancel speech queue before starting preview
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel errors
      }

      const utterance = new SpeechSynthesisUtterance(sampleText);
      if (resolved.voice) {
        utterance.voice = resolved.voice;
      }
      utterance.lang = resolved.lang;
      utterance.rate = speed;

      this.logPlaybackStart({
        engine: 'browser',
        voice: resolved.voiceName,
        language,
        model: BROWSER_TTS_MODEL,
        cacheHit: false,
        preview: true,
      });

      utterance.onend = () => {
        if (this.previewSeq !== previewId) return;
        this.setState({ previewingKey: null });
      };

      utterance.onerror = (event) => {
        if (this.previewSeq !== previewId) return;
        if (event.error === 'canceled' || event.error === 'interrupted') {
          this.setState({ previewingKey: null });
          return;
        }
        this.setState({
          previewingKey: null,
          previewError: 'Could not preview this browser voice.',
        });
      };

      window.speechSynthesis.speak(utterance);
      return;
    }

    // Gemini voice preview — strictly bypasses audioCache and never silently falls back
    const targetVoice: GeminiVoiceName =
      geminiVoiceName ?? voiceSettingsStore.getState().voices[language].gemini;

    const controller = new AbortController();
    this.previewAbortController = controller;

    try {
      const result = await this.fetchGeminiChunkAudio(
        sampleText,
        targetVoice,
        language,
        controller.signal,
        { bypassCache: true, maxRetries: 1 }
      );

      if (this.previewSeq !== previewId || controller.signal.aborted) return;

      this.cleanupPreviewAudioElement();
      const url = URL.createObjectURL(result.blob);
      const audio = new Audio(url);
      audio.playbackRate = speed;
      this.previewAudio = audio;
      this.previewAudioUrl = url;

      this.logPlaybackStart({
        engine: 'gemini',
        voice: result.voiceName,
        language,
        model: result.model,
        cacheHit: false,
        preview: true,
      });

      audio.onended = () => {
        if (this.previewSeq !== previewId) return;
        this.cleanupPreviewAudioElement();
        this.setState({ previewingKey: null });
      };

      audio.onerror = () => {
        if (this.previewSeq !== previewId) return;
        this.cleanupPreviewAudioElement();
        this.setState({
          previewingKey: null,
          previewError: 'Preview audio failed to play.',
        });
      };

      await audio.play();
    } catch (err) {
      if (this.previewSeq !== previewId) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.cleanupPreviewAudioElement();
      const message =
        err instanceof Error ? err.message : 'Unable to preview Gemini voice.';
      this.setState({
        previewingKey: null,
        previewError: message,
      });
    }
  }

  pause(): void {
    const session = this.activeSession;
    if (!session || this.state.status !== 'playing') return;

    if (session.engine === 'browser' && this.isBrowserTTSSupported()) {
      window.speechSynthesis.pause();
      this.setState({ status: 'paused' });
      return;
    }

    if (session.engine === 'gemini' && this.currentAudio) {
      this.currentAudio.pause();
      this.setState({ status: 'paused' });
    }
  }

  resume(): void {
    const session = this.activeSession;
    if (
      !session ||
      this.state.status !== 'paused' ||
      this.state.midPlaybackFallbackPrompt ||
      this.state.voiceChangedPrompt
    ) {
      return;
    }

    if (session.engine === 'browser' && this.isBrowserTTSSupported()) {
      window.speechSynthesis.resume();
      this.setState({ status: 'playing' });
      return;
    }

    if (session.engine === 'gemini' && this.currentAudio) {
      this.currentAudio.playbackRate = session.speed;
      this.currentAudio
        .play()
        .then(() => {
          this.setState({ status: 'playing', error: null });
        })
        .catch(() => {
          this.setState({
            error: 'Audio playback was blocked by the browser. Click Play to resume.',
          });
        });
    }
  }

  private applySpeedLive(speed: PlaybackRate): void {
    this.setState({ speed });
    const session = this.activeSession;
    if (!session) return;

    session.speed = speed;

    if (session.engine === 'gemini' && this.currentAudio) {
      this.currentAudio.playbackRate = speed;
      return;
    }

    // For browser speechSynthesis, re-speak current chunk with the exact SAME locked session voice
    if (
      session.engine === 'browser' &&
      this.state.status === 'playing' &&
      session.chunks.length > 0 &&
      this.isBrowserTTSSupported()
    ) {
      window.speechSynthesis.cancel();
      this.speakNextBrowserChunk(session);
    }
  }

  /**
   * Persist speed to the shared store and apply live to any active session.
   */
  setSpeed(speed: PlaybackRate): void {
    voiceSettingsStore.setSpeed(speed);
    this.applySpeedLive(speed);
  }

  /**
   * Starts a brand-new playback session by reading the latest values directly
   * from voiceSettingsStore at the moment Listen is pressed.
   */
  async speak(params: {
    messageId: string;
    rawMarkdown: string;
    language: ResponseLanguage;
  }): Promise<void> {
    const { messageId, rawMarkdown, language } = params;

    // Stop any previous playback or preview first
    this.stop();

    const cleaned = cleanTextForSpeech(rawMarkdown, language);
    if (!cleaned) {
      this.setState({
        activeMessageId: messageId,
        status: 'idle',
        error: 'There is no readable text in this response.',
      });
      return;
    }

    // Read live settings directly from the single-source-of-truth store at Listen time
    const settings = voiceSettingsStore.getState();
    const langPrefs = settings.voices[language];
    const sessionId = ++this.sessionSeq;

    if (settings.engine === 'gemini') {
      const geminiChunks = splitIntoSpeechChunks(cleaned, 540);
      if (geminiChunks.length === 0) return;

      const lockedVoiceName = langPrefs.gemini;
      const label = formatVoiceLabel({
        engine: 'gemini',
        voiceName: lockedVoiceName,
        model: GEMINI_TTS_MODEL,
      });

      const session: PlaybackSession = {
        id: sessionId,
        messageId,
        rawMarkdown,
        engine: 'gemini',
        model: GEMINI_TTS_MODEL,
        language,
        speed: settings.speed,
        cleanedText: cleaned,
        chunks: geminiChunks,
        currentChunkIdx: 0,
        hasPlayedAnyAudio: false,
        browserVoice: null,
        browserLang: language === 'ta' ? 'ta-IN' : 'en-IN',
        geminiVoice: lockedVoiceName,
        voiceName: lockedVoiceName,
        voiceLabel: label,
        isFallback: false,
        fallbackReason: null,
        savedBrowserPref: langPrefs.browser,
      };

      this.activeSession = session;
      this.setState({
        activeMessageId: messageId,
        status: 'loading',
        progress: 0,
        speed: session.speed,
        engineUsed: 'gemini',
        modelUsed: GEMINI_TTS_MODEL,
        activeVoiceLabel: session.voiceLabel,
        isFallback: false,
        fallbackReason: null,
        error: null,
        missingTamilBrowserVoice: false,
        midPlaybackFallbackPrompt: false,
        voiceChangedPrompt: false,
        notice: null,
      });

      await this.playWithGemini(session);
      return;
    }

    // Browser engine: wait for voices (with 2s timeout if empty) and resolve ONCE
    if (!this.isBrowserTTSSupported()) {
      this.setState({
        activeMessageId: messageId,
        status: 'idle',
        engineUsed: 'browser',
        modelUsed: BROWSER_TTS_MODEL,
        activeVoiceLabel: null,
        error:
          'Browser speech synthesis is not supported here. Switch to Gemini voice in Settings.',
      });
      return;
    }

    this.setState({
      activeMessageId: messageId,
      status: 'loading',
      progress: 0,
      speed: settings.speed,
      engineUsed: 'browser',
      modelUsed: BROWSER_TTS_MODEL,
      activeVoiceLabel: null,
      isFallback: false,
      fallbackReason: null,
      error: null,
      missingTamilBrowserVoice: false,
      midPlaybackFallbackPrompt: false,
      voiceChangedPrompt: false,
      notice: null,
    });

    const liveVoices = await this.waitForBrowserVoices(2000);
    // Abort if stop() or another speak() happened while waiting for voices
    if (this.sessionSeq !== sessionId) return;

    const resolved = this.resolveBrowserVoiceOnce(language, langPrefs.browser, liveVoices, false);

    if (language === 'ta' && !resolved.voice) {
      this.setState({
        activeMessageId: messageId,
        status: 'idle',
        engineUsed: 'browser',
        modelUsed: BROWSER_TTS_MODEL,
        activeVoiceLabel: null,
        missingTamilBrowserVoice: true,
        error: MISSING_TAMIL_VOICE_MESSAGE,
      });
      return;
    }

    if (liveVoices.length === 0 && !resolved.voice) {
      this.setState({
        activeMessageId: messageId,
        status: 'idle',
        engineUsed: 'browser',
        modelUsed: BROWSER_TTS_MODEL,
        activeVoiceLabel: null,
        error: 'No browser voices are available. Switch to Gemini voice in Settings.',
      });
      return;
    }

    const browserChunks = splitIntoSpeechChunks(cleaned, 200);
    if (browserChunks.length === 0) return;

    const session: PlaybackSession = {
      id: sessionId,
      messageId,
      rawMarkdown,
      engine: 'browser',
      model: BROWSER_TTS_MODEL,
      language,
      speed: settings.speed,
      cleanedText: cleaned,
      chunks: browserChunks,
      currentChunkIdx: 0,
      hasPlayedAnyAudio: false,
      browserVoice: resolved.voice,
      browserLang: resolved.lang,
      geminiVoice: langPrefs.gemini,
      voiceName: resolved.voiceName,
      voiceLabel: resolved.label,
      isFallback: false,
      fallbackReason: null,
      savedBrowserPref: langPrefs.browser,
    };

    this.activeSession = session;
    this.startLockedBrowserSession(session, resolved.unavailableNotice);
  }

  /**
   * User explicitly accepted "Gemini voice failed. Continue with browser voice?"
   * Continues from the remaining unplayed text using a single locked browser voice.
   */
  async continueWithBrowserVoice(): Promise<void> {
    const session = this.activeSession;
    if (!session || !this.state.midPlaybackFallbackPrompt) return;

    if (!this.isBrowserTTSSupported()) {
      this.setState({
        status: 'idle',
        midPlaybackFallbackPrompt: false,
        error: 'Browser speech synthesis is not supported in this browser.',
      });
      return;
    }

    const continuationSeq = ++this.sessionSeq;
    const liveVoices = await this.waitForBrowserVoices(2000);
    if (this.sessionSeq !== continuationSeq) return;

    const latestSavedBrowser =
      voiceSettingsStore.getState().voices[session.language].browser;
    const resolved = this.resolveBrowserVoiceOnce(
      session.language,
      latestSavedBrowser,
      liveVoices,
      true
    );

    if (session.language === 'ta' && !resolved.voice) {
      this.setState({
        status: 'idle',
        midPlaybackFallbackPrompt: false,
        missingTamilBrowserVoice: true,
        error: MISSING_TAMIL_VOICE_MESSAGE,
      });
      return;
    }

    if (!resolved.voice && liveVoices.length === 0) {
      this.setState({
        status: 'idle',
        midPlaybackFallbackPrompt: false,
        error: 'No browser voices are available to continue playback.',
      });
      return;
    }

    const remainingText = session.chunks.slice(session.currentChunkIdx).join(' ').trim();
    if (!remainingText) {
      this.stop();
      return;
    }

    const remainingBrowserChunks = splitIntoSpeechChunks(remainingText, 200);
    const nextSession: PlaybackSession = {
      ...session,
      id: continuationSeq,
      engine: 'browser',
      model: BROWSER_TTS_MODEL,
      chunks: remainingBrowserChunks,
      currentChunkIdx: 0,
      browserVoice: resolved.voice,
      browserLang: resolved.lang,
      voiceName: resolved.voiceName,
      voiceLabel: resolved.label,
      isFallback: true,
      fallbackReason:
        session.fallbackReason ??
        `Continued with browser voice after Gemini (${session.geminiVoice}) failed mid-answer.`,
      savedBrowserPref: latestSavedBrowser,
    };

    this.cleanupAudioElement();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.activeSession = nextSession;
    const notice = resolved.unavailableNotice ?? null;
    this.startLockedBrowserSession(nextSession, notice);
  }

  private startLockedBrowserSession(session: PlaybackSession, notice: string | null): void {
    if (this.activeSession?.id !== session.id) return;

    // Always cancel speech queue before starting a new browser session
    if (this.isBrowserTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel errors
      }
    }

    this.logPlaybackStart({
      engine: 'browser',
      voice: session.voiceName,
      language: session.language,
      model: session.model,
      cacheHit: false,
    });

    this.setState({
      activeMessageId: session.messageId,
      engineUsed: 'browser',
      modelUsed: session.model,
      activeVoiceLabel: session.voiceLabel,
      isFallback: session.isFallback,
      fallbackReason: session.fallbackReason,
      status: 'playing',
      progress: Math.round((session.currentChunkIdx / Math.max(1, session.chunks.length)) * 100),
      speed: session.speed,
      error: null,
      missingTamilBrowserVoice: false,
      midPlaybackFallbackPrompt: false,
      voiceChangedPrompt: false,
      notice,
    });

    this.speakNextBrowserChunk(session);
  }

  private speakNextBrowserChunk(session: PlaybackSession): void {
    if (this.activeSession?.id !== session.id) return;

    if (session.currentChunkIdx >= session.chunks.length) {
      this.activeSession = null;
      this.setState({
        activeMessageId: null,
        status: 'idle',
        progress: 100,
        engineUsed: null,
        modelUsed: null,
        activeVoiceLabel: null,
        isFallback: false,
        fallbackReason: null,
        midPlaybackFallbackPrompt: false,
        voiceChangedPrompt: false,
        notice: null,
      });
      return;
    }

    const text = session.chunks[session.currentChunkIdx];
    const utterance = new SpeechSynthesisUtterance(text);

    // Explicitly set BOTH the exact locked SpeechSynthesisVoice object AND lang on every chunk
    if (session.browserVoice) {
      utterance.voice = session.browserVoice;
    }
    utterance.lang = session.browserLang;
    utterance.rate = session.speed;

    utterance.onstart = () => {
      if (this.activeSession?.id !== session.id) return;
      session.hasPlayedAnyAudio = true;
      const pct = Math.round((session.currentChunkIdx / session.chunks.length) * 100);
      this.setState({ status: 'playing', progress: pct });
    };

    utterance.onend = () => {
      if (this.activeSession?.id !== session.id) return;
      session.currentChunkIdx++;
      const pct = Math.round((session.currentChunkIdx / session.chunks.length) * 100);
      this.setState({ progress: Math.min(100, pct) });
      this.speakNextBrowserChunk(session);
    };

    utterance.onerror = (event) => {
      if (this.activeSession?.id !== session.id) return;
      if (event.error === 'canceled' || event.error === 'interrupted') return;

      const msg =
        event.error === 'not-allowed'
          ? 'Audio playback was blocked by the browser. Click Listen again to play.'
          : 'Browser speech playback failed. Try switching to Gemini voice in Settings.';
      this.setState({
        status: 'idle',
        error: msg,
      });
    };

    window.speechSynthesis.speak(utterance);
  }

  private async fetchGeminiChunkAudio(
    text: string,
    voiceName: GeminiVoiceName,
    language: ResponseLanguage,
    signal: AbortSignal,
    options?: { bypassCache?: boolean; maxRetries?: number }
  ): Promise<GeminiChunkResult> {
    const bypassCache = Boolean(options?.bypassCache);
    const cacheKey = buildAudioCacheKey({
      engine: 'gemini',
      model: GEMINI_TTS_MODEL,
      voiceName,
      language,
      text,
    });

    if (!bypassCache) {
      const cached = this.audioCache.get(cacheKey);
      if (cached) {
        return {
          blob: cached.blob,
          model: cached.model,
          voiceName: cached.voiceName,
          cacheHit: true,
        };
      }
    }

    // 1 initial attempt + up to maxRetries retries with exponential backoff (1s, 2s, 4s)
    const maxRetries = options?.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voiceName, language }),
          signal,
        });

        if (res.ok) {
          const data = (await res.json()) as {
            audioBase64?: string;
            model?: string;
            voiceName?: string;
          };
          if (!data.audioBase64) {
            throw new Error('No audio data returned from Gemini TTS.');
          }
          const resolvedModel =
            typeof data.model === 'string' && data.model.trim()
              ? data.model.trim()
              : GEMINI_TTS_MODEL;
          const resolvedVoice =
            typeof data.voiceName === 'string' && data.voiceName.trim()
              ? data.voiceName.trim()
              : voiceName;
          const blob = ensureWavBlob(data.audioBase64);

          if (!bypassCache) {
            // Re-key with server-confirmed model & voiceName so cache is strictly isolated
            const confirmedKey = buildAudioCacheKey({
              engine: 'gemini',
              model: resolvedModel,
              voiceName: resolvedVoice,
              language,
              text,
            });
            if (this.audioCache.size >= 80) {
              const firstKey = this.audioCache.keys().next().value;
              if (firstKey) this.audioCache.delete(firstKey);
            }
            this.audioCache.set(confirmedKey, {
              blob,
              model: resolvedModel,
              voiceName: resolvedVoice,
            });
          }

          return {
            blob,
            model: resolvedModel,
            voiceName: resolvedVoice,
            cacheHit: false,
          };
        }

        const errJson = await res.json().catch(() => ({ error: res.statusText }));
        const message =
          typeof errJson?.error === 'string'
            ? errJson.error
            : `Gemini voice request failed (${res.status}).`;

        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxRetries) {
          throw new Error(message);
        }
        lastError = new Error(message);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        const errObj = err instanceof Error ? err : new Error(String(err));
        lastError = errObj;
        if (attempt === maxRetries) {
          throw errObj;
        }
      }

      const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    }

    throw lastError ?? new Error('Unable to generate Gemini voice audio.');
  }

  private playAudioBlob(
    blob: Blob,
    session: PlaybackSession,
    chunkIdx: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.activeSession?.id !== session.id) {
        resolve();
        return;
      }

      this.cleanupAudioElement();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = session.speed;
      this.currentAudio = audio;
      this.currentAudioUrl = url;

      const totalChunks = session.chunks.length;

      audio.ontimeupdate = () => {
        if (this.activeSession?.id !== session.id) return;
        const chunkFraction =
          audio.duration && Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.currentTime / audio.duration
            : 0;
        const pct = Math.min(
          100,
          Math.round(((chunkIdx + chunkFraction) / totalChunks) * 100)
        );
        this.setState({ progress: pct });
      };

      audio.onended = () => {
        if (this.activeSession?.id !== session.id) {
          resolve();
          return;
        }
        const pct = Math.round(((chunkIdx + 1) / totalChunks) * 100);
        this.setState({ progress: Math.min(100, pct) });
        this.cleanupAudioElement();
        resolve();
      };

      audio.onerror = () => {
        this.cleanupAudioElement();
        reject(new Error('Audio decoding or playback failed.'));
      };

      session.hasPlayedAnyAudio = true;
      this.setState({ status: 'playing', error: null });
      audio.play().catch((err) => {
        this.cleanupAudioElement();
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          reject(
            new Error(
              'Audio playback was blocked by the browser. Click Listen to start playback.'
            )
          );
        } else {
          reject(err instanceof Error ? err : new Error('Unable to play audio.'));
        }
      });
    });
  }

  private async playWithGemini(session: PlaybackSession): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;

    const totalChunks = session.chunks.length;

    // Sequentially prefetch with the exact locked geminiVoice & language for every chunk
    const chunkPromises: Promise<GeminiChunkResult>[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    for (let i = 0; i < totalChunks; i++) {
      const chunkText = session.chunks[i];
      const nextPromise = chain.then(() =>
        this.fetchGeminiChunkAudio(
          chunkText,
          session.geminiVoice,
          session.language,
          controller.signal
        )
      );
      chunkPromises.push(nextPromise);
      nextPromise.catch(() => {});
      chain = nextPromise.catch(() => {});
    }

    let loggedStart = false;

    try {
      for (let i = 0; i < totalChunks; i++) {
        if (this.activeSession?.id !== session.id || controller.signal.aborted) return;

        session.currentChunkIdx = i;

        if (i > 0 && this.state.status !== 'paused') {
          this.setState({ status: 'loading' });
        }

        const chunkResult = await chunkPromises[i];
        if (this.activeSession?.id !== session.id || controller.signal.aborted) return;

        // Update session & state with exact server-confirmed model and voiceName
        session.model = chunkResult.model;
        session.voiceName = chunkResult.voiceName;
        session.voiceLabel = formatVoiceLabel({
          engine: 'gemini',
          voiceName: chunkResult.voiceName,
          model: chunkResult.model,
        });

        if (!loggedStart) {
          loggedStart = true;
          this.logPlaybackStart({
            engine: 'gemini',
            voice: chunkResult.voiceName,
            language: session.language,
            model: chunkResult.model,
            cacheHit: chunkResult.cacheHit,
          });
          this.setState({
            engineUsed: 'gemini',
            modelUsed: chunkResult.model,
            activeVoiceLabel: session.voiceLabel,
            isFallback: false,
            fallbackReason: null,
          });
        }

        await this.playAudioBlob(chunkResult.blob, session, i);
      }

      if (this.activeSession?.id === session.id) {
        this.activeSession = null;
        this.setState({
          activeMessageId: null,
          status: 'idle',
          progress: 100,
          engineUsed: null,
          modelUsed: null,
          activeVoiceLabel: null,
          isFallback: false,
          fallbackReason: null,
          midPlaybackFallbackPrompt: false,
          voiceChangedPrompt: false,
          notice: null,
        });
      }
    } catch (err) {
      if (this.activeSession?.id !== session.id) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;

      const reason =
        err instanceof Error ? err.message : 'Gemini voice encountered an error.';

      if (reason.toLowerCase().includes('blocked by the browser')) {
        this.setState({
          status: 'idle',
          error: reason,
        });
        return;
      }

      // Mid-answer failure: NEVER switch engines silently — pause and ask user
      if (session.hasPlayedAnyAudio) {
        this.cleanupAudioElement();
        session.fallbackReason = `Gemini (${session.geminiVoice} / ${session.model}) failed mid-answer: ${reason}`;
        this.setState({
          status: 'paused',
          midPlaybackFallbackPrompt: true,
          error: MID_PLAYBACK_GEMINI_FAILED_MESSAGE,
          notice: null,
        });
        return;
      }

      // Failure BEFORE any audio played: fall back to browser voice once with explicit fallback label & reason
      if (this.isBrowserTTSSupported()) {
        const fallbackSeq = ++this.sessionSeq;
        const liveVoices = await this.waitForBrowserVoices(2000);
        if (this.sessionSeq !== fallbackSeq) return;

        const latestSavedBrowser =
          voiceSettingsStore.getState().voices[session.language].browser;
        const resolved = this.resolveBrowserVoiceOnce(
          session.language,
          latestSavedBrowser,
          liveVoices,
          true
        );

        if (resolved.voice || (session.language !== 'ta' && liveVoices.length > 0)) {
          const fallbackBrowserChunks = splitIntoSpeechChunks(session.cleanedText, 200);
          const fallbackReason = `Gemini (${session.geminiVoice} / ${session.model}) unavailable: ${reason}`;
          const fallbackSession: PlaybackSession = {
            ...session,
            id: fallbackSeq,
            engine: 'browser',
            model: BROWSER_TTS_MODEL,
            chunks: fallbackBrowserChunks,
            currentChunkIdx: 0,
            browserVoice: resolved.voice,
            browserLang: resolved.lang,
            voiceName: resolved.voiceName,
            voiceLabel: resolved.label,
            isFallback: true,
            fallbackReason,
            savedBrowserPref: latestSavedBrowser,
          };
          this.activeSession = fallbackSession;
          this.startLockedBrowserSession(fallbackSession, resolved.unavailableNotice);
          return;
        }
      }

      this.setState({
        status: 'idle',
        error: `${reason} No matching browser fallback voice is available.`,
      });
    }
  }
}

export const ttsService = new TTSService();
