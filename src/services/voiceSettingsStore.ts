import type {
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  VoiceEngine,
  VoiceSettings,
} from '../types';

export const GEMINI_VOICES: { name: GeminiVoiceName; description: string }[] = [
  { name: 'Kore', description: 'Balanced, clear' },
  { name: 'Puck', description: 'Warm, conversational' },
  { name: 'Charon', description: 'Calm, steady' },
  { name: 'Fenrir', description: 'Deep, articulated' },
  { name: 'Zephyr', description: 'Light, crisp' },
];

export const PLAYBACK_SPEEDS: PlaybackRate[] = [0.75, 1, 1.25, 1.5];

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  engine: 'browser',
  voices: {
    en: { browser: null, gemini: 'Kore' },
    ta: { browser: null, gemini: 'Kore' },
  },
  speed: 1,
  autoRead: false,
};

const VOICE_SETTINGS_KEY = 'documind_voice_settings_v2';
const LEGACY_VOICE_SETTINGS_KEY = 'documind_voice_settings_v1';

function isValidGeminiVoice(val: unknown): val is GeminiVoiceName {
  return typeof val === 'string' && GEMINI_VOICES.some((v) => v.name === val);
}

function parseSavedBrowserVoice(val: unknown): SavedBrowserVoice | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as { voiceURI?: unknown; name?: unknown };
  const voiceURI = typeof obj.voiceURI === 'string' ? obj.voiceURI.trim() : '';
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!voiceURI && !name) return null;
  return { voiceURI, name: name || voiceURI };
}

function cloneSettings(s: VoiceSettings): VoiceSettings {
  return {
    engine: s.engine,
    voices: {
      en: {
        browser: s.voices.en.browser ? { ...s.voices.en.browser } : null,
        gemini: s.voices.en.gemini,
      },
      ta: {
        browser: s.voices.ta.browser ? { ...s.voices.ta.browser } : null,
        gemini: s.voices.ta.gemini,
      },
    },
    speed: s.speed,
    autoRead: s.autoRead,
  };
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    if (typeof localStorage === 'undefined') {
      return cloneSettings(DEFAULT_VOICE_SETTINGS);
    }

    const rawV2 = localStorage.getItem(VOICE_SETTINGS_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<VoiceSettings>;
      const engine: VoiceEngine = parsed.engine === 'gemini' ? 'gemini' : 'browser';
      const validSpeed = PLAYBACK_SPEEDS.includes(parsed.speed as PlaybackRate)
        ? (parsed.speed as PlaybackRate)
        : 1;

      const enRaw = parsed.voices?.en;
      const taRaw = parsed.voices?.ta;

      return {
        engine,
        voices: {
          en: {
            browser: parseSavedBrowserVoice(enRaw?.browser),
            gemini: isValidGeminiVoice(enRaw?.gemini) ? enRaw.gemini : 'Kore',
          },
          ta: {
            browser: parseSavedBrowserVoice(taRaw?.browser),
            gemini: isValidGeminiVoice(taRaw?.gemini) ? taRaw.gemini : 'Kore',
          },
        },
        speed: validSpeed,
        autoRead: Boolean(parsed.autoRead),
      };
    }

    // One-time seamless migration from legacy v1 settings
    const rawLegacy = localStorage.getItem(LEGACY_VOICE_SETTINGS_KEY);
    if (rawLegacy) {
      const parsed = JSON.parse(rawLegacy) as {
        engine?: string;
        browserVoiceURI?: string;
        geminiVoice?: string;
        speed?: number;
        autoRead?: boolean;
      };
      const engine: VoiceEngine = parsed.engine === 'gemini' ? 'gemini' : 'browser';
      const validSpeed = PLAYBACK_SPEEDS.includes(parsed.speed as PlaybackRate)
        ? (parsed.speed as PlaybackRate)
        : 1;
      const validGemini: GeminiVoiceName = isValidGeminiVoice(parsed.geminiVoice)
        ? parsed.geminiVoice
        : 'Kore';
      const legacyURI =
        typeof parsed.browserVoiceURI === 'string' ? parsed.browserVoiceURI.trim() : '';
      const migrated: VoiceSettings = {
        engine,
        voices: {
          en: {
            browser: legacyURI ? { voiceURI: legacyURI, name: legacyURI } : null,
            gemini: validGemini,
          },
          ta: {
            browser: null,
            gemini: validGemini,
          },
        },
        speed: validSpeed,
        autoRead: Boolean(parsed.autoRead),
      };
      saveVoiceSettings(migrated);
      return migrated;
    }

    return cloneSettings(DEFAULT_VOICE_SETTINGS);
  } catch {
    return cloneSettings(DEFAULT_VOICE_SETTINGS);
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
    }
  } catch {
    // Ignore localStorage quota errors
  }
}

export type VoiceSettingsChangeKind = 'engine' | 'voice' | 'speed' | 'autoRead';

export interface VoiceSettingsChangeEvent {
  next: VoiceSettings;
  prev: VoiceSettings;
  changedLanguage?: ResponseLanguage;
  kinds: VoiceSettingsChangeKind[];
}

type VoiceSettingsListener = (event: VoiceSettingsChangeEvent) => void;

/**
 * Single source of truth for voice settings across SettingsDialog,
 * the Listen voice picker, React hooks, and ttsService.
 */
class VoiceSettingsStore {
  private state: VoiceSettings;
  private listeners = new Set<VoiceSettingsListener>();

  constructor() {
    this.state = loadVoiceSettings();

    // Keep synchronized across browser tabs if localStorage changes externally
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === VOICE_SETTINGS_KEY) {
          const prev = this.state;
          const next = loadVoiceSettings();
          this.state = next;
          this.notify({
            prev,
            next,
            kinds: this.diffKinds(prev, next),
          });
        }
      });
    }
  }

  private diffKinds(prev: VoiceSettings, next: VoiceSettings): VoiceSettingsChangeKind[] {
    const kinds: VoiceSettingsChangeKind[] = [];
    if (prev.engine !== next.engine) kinds.push('engine');
    if (
      prev.voices.en.browser?.voiceURI !== next.voices.en.browser?.voiceURI ||
      prev.voices.en.gemini !== next.voices.en.gemini ||
      prev.voices.ta.browser?.voiceURI !== next.voices.ta.browser?.voiceURI ||
      prev.voices.ta.gemini !== next.voices.ta.gemini
    ) {
      kinds.push('voice');
    }
    if (prev.speed !== next.speed) kinds.push('speed');
    if (prev.autoRead !== next.autoRead) kinds.push('autoRead');
    return kinds;
  }

  private notify(event: VoiceSettingsChangeEvent): void {
    if (event.kinds.length === 0) return;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getState(): VoiceSettings {
    return this.state;
  }

  subscribe(listener: VoiceSettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(patch: Partial<VoiceSettings>): VoiceSettings {
    const prev = this.state;
    const next: VoiceSettings = {
      ...prev,
      ...patch,
      voices: patch.voices
        ? {
            en: { ...prev.voices.en, ...patch.voices.en },
            ta: { ...prev.voices.ta, ...patch.voices.ta },
          }
        : prev.voices,
    };

    const kinds = this.diffKinds(prev, next);
    if (kinds.length === 0) return this.state;

    this.state = next;
    saveVoiceSettings(next);
    this.notify({ prev, next, kinds });
    return next;
  }

  setEngine(engine: VoiceEngine): VoiceSettings {
    return this.update({ engine });
  }

  setBrowserVoice(language: ResponseLanguage, voice: SavedBrowserVoice | null): VoiceSettings {
    const prev = this.state;
    const prevUri = prev.voices[language].browser?.voiceURI ?? null;
    const nextUri = voice?.voiceURI ?? null;
    if (prevUri === nextUri && (prev.voices[language].browser?.name ?? null) === (voice?.name ?? null)) {
      return this.state;
    }

    const next: VoiceSettings = {
      ...prev,
      voices: {
        ...prev.voices,
        [language]: {
          ...prev.voices[language],
          browser: voice ? { voiceURI: voice.voiceURI, name: voice.name } : null,
        },
      },
    };

    this.state = next;
    saveVoiceSettings(next);
    this.notify({
      prev,
      next,
      changedLanguage: language,
      kinds: ['voice'],
    });
    return next;
  }

  setGeminiVoice(language: ResponseLanguage, geminiVoice: GeminiVoiceName): VoiceSettings {
    const prev = this.state;
    if (prev.voices[language].gemini === geminiVoice) {
      return this.state;
    }

    const next: VoiceSettings = {
      ...prev,
      voices: {
        ...prev.voices,
        [language]: {
          ...prev.voices[language],
          gemini: geminiVoice,
        },
      },
    };

    this.state = next;
    saveVoiceSettings(next);
    this.notify({
      prev,
      next,
      changedLanguage: language,
      kinds: ['voice'],
    });
    return next;
  }

  setSpeed(speed: PlaybackRate): VoiceSettings {
    return this.update({ speed });
  }

  setAutoRead(autoRead: boolean): VoiceSettings {
    return this.update({ autoRead });
  }
}

export const voiceSettingsStore = new VoiceSettingsStore();
