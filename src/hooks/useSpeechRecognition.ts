import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResponseLanguage } from '../types';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface UseSpeechRecognitionOptions {
  language: ResponseLanguage;
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
}

export function useSpeechRecognition({
  language,
  onTranscript,
  onError,
}: UseSpeechRecognitionOptions) {
  const isSupported = getSpeechRecognitionCtor() !== null;
  const [isListening, setIsListening] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const prefixRef = useRef('');
  const finalRef = useRef('');

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore stop errors
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(
    (currentInputValue: string) => {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return;

      stopListening();

      const recognition = new Ctor();
      recognition.lang = language === 'ta' ? 'ta-IN' : 'en-IN';
      recognition.continuous = true;
      recognition.interimResults = true;

      prefixRef.current = currentInputValue.trim();
      finalRef.current = '';

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const text = res[0]?.transcript ?? '';
          if (res.isFinal) {
            finalRef.current += `${text} `;
          } else {
            interim += text;
          }
        }

        const spoken = `${finalRef.current}${interim}`.trim();
        const combined = prefixRef.current ? `${prefixRef.current} ${spoken}`.trim() : spoken;
        onTranscript(combined);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (event.error === 'aborted' || event.error === 'no-speech') {
          setIsListening(false);
          return;
        }
        const msg =
          event.error === 'not-allowed'
            ? 'Microphone access was denied. Allow microphone permissions in your browser settings.'
            : 'Voice input could not start. Check your microphone and try again.';
        onError?.(msg);
        setIsListening(false);
      };

      recognition.onend = () => {
        recognitionRef.current = null;
        setIsListening(false);
      };

      try {
        recognitionRef.current = recognition;
        recognition.start();
        setIsListening(true);
      } catch {
        recognitionRef.current = null;
        setIsListening(false);
        onError?.('Voice input could not start.');
      }
    },
    [language, onError, onTranscript, stopListening]
  );

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore cleanup errors
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  return {
    isSupported,
    isListening,
    startListening,
    stopListening,
  };
}
