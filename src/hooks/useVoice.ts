import { useCallback, useEffect, useState } from 'react';
import {
  ttsService,
  voiceSettingsStore,
  type PreviewVoiceParams,
} from '../services/ttsService';
import type {
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceSettings,
} from '../types';

export function useVoice() {
  // Single source of truth: read directly from voiceSettingsStore
  const [settings, setSettingsState] = useState<VoiceSettings>(() =>
    voiceSettingsStore.getState()
  );
  const [ttsState, setTtsState] = useState<TTSState>(() => ttsService.getState());
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>(() =>
    ttsService.refreshBrowserVoices()
  );

  useEffect(() => {
    const unsubSettings = voiceSettingsStore.subscribe((event) => {
      setSettingsState(event.next);
    });
    const unsubState = ttsService.subscribe(setTtsState);
    const unsubVoices = ttsService.subscribeVoices(setBrowserVoices);

    const handleBeforeUnload = () => {
      ttsService.stop();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unsubSettings();
      unsubState();
      unsubVoices();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      ttsService.stop();
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    voiceSettingsStore.update(patch);
  }, []);

  const setBrowserVoiceForLanguage = useCallback(
    (language: ResponseLanguage, voice: SavedBrowserVoice | null) => {
      voiceSettingsStore.setBrowserVoice(language, voice);
    },
    []
  );

  const setGeminiVoiceForLanguage = useCallback(
    (language: ResponseLanguage, geminiVoice: GeminiVoiceName) => {
      voiceSettingsStore.setGeminiVoice(language, geminiVoice);
    },
    []
  );

  /**
   * Always starts a fresh session reading live values from voiceSettingsStore.
   */
  const speakMessage = useCallback(
    (messageId: string, content: string, language: ResponseLanguage) => {
      void ttsService.speak({
        messageId,
        rawMarkdown: content,
        language,
      });
    },
    []
  );

  const togglePlayPause = useCallback(
    (messageId: string, content: string, language: ResponseLanguage) => {
      const current = ttsService.getState();
      if (current.activeMessageId === messageId && !current.voiceChangedPrompt) {
        if (current.status === 'playing') {
          ttsService.pause();
          return;
        }
        if (current.status === 'paused' && !current.midPlaybackFallbackPrompt) {
          ttsService.resume();
          return;
        }
        if (current.status === 'loading') {
          ttsService.stop();
          return;
        }
      }
      speakMessage(messageId, content, language);
    },
    [speakMessage]
  );

  const stopPlayback = useCallback(() => {
    ttsService.stop();
  }, []);

  const setPlaybackSpeed = useCallback((speed: PlaybackRate) => {
    ttsService.setSpeed(speed);
  }, []);

  const continueWithBrowserVoice = useCallback(() => {
    void ttsService.continueWithBrowserVoice();
  }, []);

  const switchToGeminiAndReplay = useCallback(
    (messageId: string, content: string, language: ResponseLanguage) => {
      voiceSettingsStore.setEngine('gemini');
      speakMessage(messageId, content, language);
    },
    [speakMessage]
  );

  const replayWithNewVoice = useCallback(() => {
    void ttsService.replayAfterVoiceChange();
  }, []);

  const dismissVoiceChangedPrompt = useCallback(() => {
    ttsService.dismissVoiceChangedPrompt();
  }, []);

  const previewVoice = useCallback((params: PreviewVoiceParams) => {
    void ttsService.previewVoice(params);
  }, []);

  const stopPreview = useCallback(() => {
    ttsService.stopPreview();
  }, []);

  return {
    voiceSettings: settings,
    ttsState,
    browserVoices,
    updateVoiceSettings: updateSettings,
    setBrowserVoiceForLanguage,
    setGeminiVoiceForLanguage,
    speakMessage,
    togglePlayPause,
    stopPlayback,
    setPlaybackSpeed,
    continueWithBrowserVoice,
    switchToGeminiAndReplay,
    replayWithNewVoice,
    dismissVoiceChangedPrompt,
    previewVoice,
    stopPreview,
  };
}
