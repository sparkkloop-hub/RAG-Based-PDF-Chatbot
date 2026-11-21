import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Headphones,
  RefreshCw,
} from 'lucide-react';
import {
  computeAudioOverviewCacheKey,
  computeTurnTimeRanges,
  concatenateWavBlobs,
  DEFAULT_HOST_A_VOICE,
  DEFAULT_HOST_B_VOICE,
  generateAudioOverviewScript,
  generateMultiSpeakerSegmentAudio,
  getAudioOverviewCache,
  groupTurnsIntoAudioSegments,
  saveAudioOverviewCache,
} from '../services/audioOverviewService';
import { GEMINI_VOICES, ttsService } from '../services/ttsService';
import type {
  AudioOverviewSegmentRange,
  AudioOverviewTurn,
  DocumentRecord,
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
} from '../types';
import { AudioPlayerBar } from './MessageAudioControls';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { SkeletonLines } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';

type GenerationPhase = 'idle' | 'script' | 'audio' | 'ready' | 'script-only';

interface AudioOverviewPanelProps {
  documents: DocumentRecord[];
  selectedDocIds: string[];
  targetDocLabel: string;
  language: ResponseLanguage;
  onToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
}

export function AudioOverviewPanel({
  documents,
  selectedDocIds,
  targetDocLabel,
  language,
  onToast,
}: AudioOverviewPanelProps) {
  const [voiceA, setVoiceA] = useState<GeminiVoiceName>(DEFAULT_HOST_A_VOICE);
  const [voiceB, setVoiceB] = useState<GeminiVoiceName>(DEFAULT_HOST_B_VOICE);

  const [phase, setPhase] = useState<GenerationPhase>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [scriptPercent, setScriptPercent] = useState(0);
  const [audioSegmentsDone, setAudioSegmentsDone] = useState(0);
  const [audioSegmentsTotal, setAudioSegmentsTotal] = useState(0);
  const [isLoadedFromCache, setIsLoadedFromCache] = useState(false);

  const [script, setScript] = useState<AudioOverviewTurn[]>([]);
  const [segmentRanges, setSegmentRanges] = useState<AudioOverviewSegmentRange[]>([]);
  const [chunkDurations, setChunkDurations] = useState<number[]>([]);
  const [readySegmentCount, setReadySegmentCount] = useState(0);

  const [scriptError, setScriptError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [playbackNotice, setPlaybackNotice] = useState<string | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [isDownloadingWav, setIsDownloadingWav] = useState(false);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBufferingNext, setIsBufferingNext] = useState(false);
  const [speed, setSpeed] = useState<PlaybackRate>(1);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);

  // Refs for stable playback across asynchronous background segment arrivals
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobsRef = useRef<Array<Blob | null>>([]);
  const urlsRef = useRef<Array<string | null>>([]);
  const durationsRef = useRef<number[]>([]);
  const segmentRangesRef = useRef<AudioOverviewSegmentRange[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const speedRef = useRef<PlaybackRate>(1);
  const activeSegIdxRef = useRef<number>(0);
  const waitingForSegIdxRef = useRef<number | null>(null);
  const isPlayingRef = useRef<boolean>(false);
  const generationIdRef = useRef<number>(0);
  const turnElRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const scopedDocs = useMemo(() => {
    if (selectedDocIds.length === 0) return documents;
    const set = new Set(selectedDocIds);
    const filtered = documents.filter((d) => set.has(d.id));
    return filtered.length > 0 ? filtered : documents;
  }, [documents, selectedDocIds]);

  const cacheKey = useMemo(
    () => computeAudioOverviewCacheKey(scopedDocs, language, voiceA, voiceB),
    [scopedDocs, language, voiceA, voiceB]
  );

  const totalDurationSec = useMemo(
    () => chunkDurations.reduce((sum, d) => sum + (d || 0), 0),
    [chunkDurations]
  );

  const turnTimeRanges = useMemo(
    () => computeTurnTimeRanges(script, segmentRanges, chunkDurations),
    [script, segmentRanges, chunkDurations]
  );

  const activeTurnIndex = useMemo(() => {
    if (script.length === 0 || turnTimeRanges.length === 0) return -1;
    if (!isPlaying && currentTimeSec === 0) return -1;
    for (let i = 0; i < turnTimeRanges.length; i++) {
      const r = turnTimeRanges[i];
      if (currentTimeSec >= r.startSec && currentTimeSec < r.endSec) {
        return i;
      }
    }
    if (currentTimeSec > 0 && currentTimeSec >= totalDurationSec - 0.15) {
      return turnTimeRanges.length - 1;
    }
    return -1;
  }, [script.length, turnTimeRanges, isPlaying, currentTimeSec, totalDurationSec]);

  // Smoothly keep the active transcript line visible while playing
  useEffect(() => {
    if (!isPlaying || activeTurnIndex < 0) return;
    const el = turnElRefs.current.get(activeTurnIndex);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeTurnIndex, isPlaying]);

  const revokeAllUrls = useCallback(() => {
    for (const url of urlsRef.current) {
      if (url) URL.revokeObjectURL(url);
    }
    urlsRef.current = [];
  }, []);

  const stopAudioElement = useCallback((resetPosition = false) => {
    waitingForSegIdxRef.current = null;
    isPlayingRef.current = false;
    setIsPlaying(false);
    setIsBufferingNext(false);

    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.ontimeupdate = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }

    if (resetPosition) {
      activeSegIdxRef.current = 0;
      setActiveSegmentIdx(0);
      setCurrentTimeSec(0);
    }
  }, []);

  const getOffsetBeforeSegment = useCallback((segIdx: number): number => {
    let sum = 0;
    for (let i = 0; i < segIdx; i++) {
      sum += durationsRef.current[i] ?? 0;
    }
    return sum;
  }, []);

  const playSegmentAt = useCallback(
    (segIdx: number, localStartSec = 0) => {
      const blob = blobsRef.current[segIdx];
      if (!blob) {
        // Segment not yet generated — wait for it if generation is still running
        waitingForSegIdxRef.current = segIdx;
        isPlayingRef.current = true;
        setIsPlaying(false);
        setIsBufferingNext(true);
        return;
      }

      ttsService.stop();
      waitingForSegIdxRef.current = null;
      setIsBufferingNext(false);
      setPlaybackNotice(null);

      if (audioRef.current) {
        audioRef.current.onended = null;
        audioRef.current.ontimeupdate = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
      }

      let url = urlsRef.current[segIdx];
      if (!url) {
        url = URL.createObjectURL(blob);
        urlsRef.current[segIdx] = url;
      }

      const audio = new Audio(url);
      audio.playbackRate = speedRef.current;
      audioRef.current = audio;
      activeSegIdxRef.current = segIdx;
      setActiveSegmentIdx(segIdx);

      const segOffset = getOffsetBeforeSegment(segIdx);

      if (localStartSec > 0) {
        const applySeek = () => {
          const maxSeek =
            audio.duration && Number.isFinite(audio.duration)
              ? Math.max(0, audio.duration - 0.05)
              : localStartSec;
          audio.currentTime = Math.min(localStartSec, maxSeek);
        };
        if (audio.readyState >= 1) {
          applySeek();
        } else {
          audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
      }

      audio.ontimeupdate = () => {
        if (audioRef.current !== audio) return;
        const base = getOffsetBeforeSegment(segIdx);
        setCurrentTimeSec(base + audio.currentTime);
      };

      audio.onended = () => {
        if (audioRef.current !== audio) return;
        const nextIdx = segIdx + 1;
        const totalSegs = segmentRangesRef.current.length;

        if (nextIdx >= totalSegs) {
          isPlayingRef.current = false;
          setIsPlaying(false);
          setIsBufferingNext(false);
          setCurrentTimeSec(getOffsetBeforeSegment(totalSegs));
          return;
        }

        if (blobsRef.current[nextIdx]) {
          playSegmentAt(nextIdx, 0);
        } else {
          // Wait for background generation of next segment
          waitingForSegIdxRef.current = nextIdx;
          setIsBufferingNext(true);
          setIsPlaying(false);
        }
      };

      audio.onerror = () => {
        if (audioRef.current !== audio) return;
        isPlayingRef.current = false;
        setIsPlaying(false);
        setIsBufferingNext(false);
        setPlaybackNotice('Could not decode this audio segment. Try playing again.');
      };

      isPlayingRef.current = true;
      setIsPlaying(true);

      audio.play().catch((err) => {
        if (audioRef.current !== audio) return;
        isPlayingRef.current = false;
        setIsPlaying(false);
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setPlaybackNotice('Audio is ready. Select Play to start listening.');
        } else {
          setPlaybackNotice('Playback could not start automatically. Select Play to listen.');
        }
      });
    },
    [getOffsetBeforeSegment]
  );

  // Stop audio and abort active requests on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopAudioElement(true);
      revokeAllUrls();
    };
  }, [stopAudioElement, revokeAllUrls]);

  // Check IndexedDB cache whenever document scope, language, or voice pair changes
  useEffect(() => {
    let cancelled = false;
    abortRef.current?.abort();
    stopAudioElement(true);
    revokeAllUrls();

    setScriptError(null);
    setAudioError(null);
    setPlaybackNotice(null);
    setIsLoadedFromCache(false);

    const checkCache = async () => {
      try {
        const cached = await getAudioOverviewCache(cacheKey);
        if (cancelled) return;

        if (cached && cached.script.length > 0 && cached.audioChunks.length > 0) {
          blobsRef.current = cached.audioChunks;
          urlsRef.current = new Array(cached.audioChunks.length).fill(null);
          durationsRef.current = [...cached.chunkDurations];
          segmentRangesRef.current = cached.segmentRanges;

          setScript(cached.script);
          setSegmentRanges(cached.segmentRanges);
          setChunkDurations(cached.chunkDurations);
          setReadySegmentCount(cached.audioChunks.length);
          setAudioSegmentsDone(cached.audioChunks.length);
          setAudioSegmentsTotal(cached.segmentRanges.length);
          setPhase('ready');
          setStatusDetail('Loaded from browser cache');
          setIsLoadedFromCache(true);
        } else {
          blobsRef.current = [];
          durationsRef.current = [];
          segmentRangesRef.current = [];
          setScript([]);
          setSegmentRanges([]);
          setChunkDurations([]);
          setReadySegmentCount(0);
          setAudioSegmentsDone(0);
          setAudioSegmentsTotal(0);
          setPhase('idle');
          setStatusDetail('');
        }
      } catch {
        if (!cancelled) {
          setPhase('idle');
        }
      }
    };

    checkCache();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, stopAudioElement, revokeAllUrls]);

  const runAudioSynthesis = useCallback(
    async (
      currentScript: AudioOverviewTurn[],
      ranges: AudioOverviewSegmentRange[],
      genId: number,
      controller: AbortController,
      startFromIndex = 0
    ) => {
      setPhase('audio');
      setAudioError(null);
      setAudioSegmentsTotal(ranges.length);

      let completedCount = blobsRef.current.filter(Boolean).length;
      setAudioSegmentsDone(completedCount);

      try {
        for (let i = startFromIndex; i < ranges.length; i++) {
          if (controller.signal.aborted || generationIdRef.current !== genId) return;
          if (blobsRef.current[i]) continue;

          setStatusDetail(`Generating audio segment ${i + 1} of ${ranges.length}...`);

          const slice = currentScript.slice(ranges[i].startTurn, ranges[i].endTurn);
          const { blob, durationSec } = await generateMultiSpeakerSegmentAudio({
            turns: slice,
            voiceA,
            voiceB,
            language,
            signal: controller.signal,
          });

          if (controller.signal.aborted || generationIdRef.current !== genId) return;

          blobsRef.current[i] = blob;
          durationsRef.current[i] = durationSec;
          completedCount++;

          setChunkDurations([...durationsRef.current]);
          setReadySegmentCount(completedCount);
          setAudioSegmentsDone(completedCount);

          // Start playing segment 1 immediately while remaining segments generate
          if (i === 0 && startFromIndex === 0) {
            playSegmentAt(0, 0);
          } else if (waitingForSegIdxRef.current === i) {
            playSegmentAt(i, 0);
          }
        }

        if (controller.signal.aborted || generationIdRef.current !== genId) return;

        // All segments succeeded — cache in IndexedDB
        const completeBlobs = blobsRef.current.filter((b): b is Blob => b !== null);
        if (completeBlobs.length === ranges.length) {
          await saveAudioOverviewCache({
            cacheKey,
            docIds: scopedDocs.map((d) => d.id),
            docNames: scopedDocs.map((d) => d.fileName),
            language,
            voiceA,
            voiceB,
            script: currentScript,
            audioChunks: completeBlobs,
            chunkDurations: [...durationsRef.current],
            segmentRanges: ranges,
            createdAt: Date.now(),
          }).catch(() => {
            // Non-fatal if IndexedDB quota is tight
          });
        }

        setPhase('ready');
        setStatusDetail('Audio overview ready');
        onToast('success', 'Audio Overview ready', `${currentScript.length} dialogue turns synthesized.`);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (generationIdRef.current !== genId) return;

        waitingForSegIdxRef.current = null;
        setIsBufferingNext(false);

        const msg =
          err instanceof Error
            ? err.message
            : 'Audio synthesis was interrupted. You can still read the transcript below.';
        setAudioError(msg);
        setPhase(blobsRef.current.some(Boolean) ? 'ready' : 'script-only');
        setStatusDetail(
          blobsRef.current.some(Boolean)
            ? 'Partial audio available'
            : 'Audio unavailable; transcript ready'
        );
        onToast('error', 'Audio generation interrupted', msg);
      }
    },
    [voiceA, voiceB, language, cacheKey, scopedDocs, playSegmentAt, onToast]
  );

  const handleGenerate = async (forceRegenerate = false) => {
    abortRef.current?.abort();
    stopAudioElement(true);
    revokeAllUrls();

    const genId = ++generationIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    setScriptError(null);
    setAudioError(null);
    setPlaybackNotice(null);
    setIsLoadedFromCache(false);

    // Check cache first unless user explicitly requested Regenerate
    if (!forceRegenerate) {
      try {
        const cached = await getAudioOverviewCache(cacheKey);
        if (cached && cached.script.length > 0 && cached.audioChunks.length > 0) {
          blobsRef.current = cached.audioChunks;
          urlsRef.current = new Array(cached.audioChunks.length).fill(null);
          durationsRef.current = [...cached.chunkDurations];
          segmentRangesRef.current = cached.segmentRanges;

          setScript(cached.script);
          setSegmentRanges(cached.segmentRanges);
          setChunkDurations(cached.chunkDurations);
          setReadySegmentCount(cached.audioChunks.length);
          setAudioSegmentsDone(cached.audioChunks.length);
          setAudioSegmentsTotal(cached.segmentRanges.length);
          setPhase('ready');
          setStatusDetail('Loaded from browser cache');
          setIsLoadedFromCache(true);
          playSegmentAt(0, 0);
          return;
        }
      } catch {
        // Proceed with fresh generation
      }
    }

    setPhase('script');
    setScriptPercent(5);
    setStatusDetail('Preparing document context...');
    setScript([]);
    setSegmentRanges([]);
    setChunkDurations([]);
    setReadySegmentCount(0);
    setAudioSegmentsDone(0);
    setAudioSegmentsTotal(0);
    blobsRef.current = [];
    durationsRef.current = [];
    segmentRangesRef.current = [];

    try {
      const generatedScript = await generateAudioOverviewScript(
        selectedDocIds,
        language,
        (detail, pct) => {
          if (generationIdRef.current !== genId) return;
          setStatusDetail(detail);
          setScriptPercent(pct);
        },
        controller.signal
      );

      if (controller.signal.aborted || generationIdRef.current !== genId) return;

      const ranges = groupTurnsIntoAudioSegments(generatedScript, 4, 800);
      blobsRef.current = new Array(ranges.length).fill(null);
      urlsRef.current = new Array(ranges.length).fill(null);
      durationsRef.current = new Array(ranges.length).fill(0);
      segmentRangesRef.current = ranges;

      setScript(generatedScript);
      setSegmentRanges(ranges);
      setChunkDurations(new Array(ranges.length).fill(0));
      setScriptPercent(100);

      await runAudioSynthesis(generatedScript, ranges, genId, controller, 0);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (generationIdRef.current !== genId) return;

      const msg =
        err instanceof Error
          ? err.message
          : 'Could not write the Audio Overview script. Please try again.';
      setScriptError(msg);
      setPhase('idle');
      setStatusDetail('');
      onToast('error', 'Audio Overview failed', msg);
    }
  };

  const handleRetryMissingAudio = async () => {
    if (script.length === 0 || segmentRanges.length === 0) return;
    abortRef.current?.abort();
    const genId = ++generationIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    const firstMissing = blobsRef.current.findIndex((b) => b === null);
    if (firstMissing === -1) return;

    await runAudioSynthesis(script, segmentRanges, genId, controller, firstMissing);
  };

  const handleCancelGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    waitingForSegIdxRef.current = null;
    setIsBufferingNext(false);
    if (script.length > 0) {
      setPhase(blobsRef.current.some(Boolean) ? 'ready' : 'script-only');
      setStatusDetail('Generation cancelled');
    } else {
      setPhase('idle');
      setStatusDetail('');
    }
  };

  const handleTogglePlayPause = () => {
    if (readySegmentCount === 0) return;

    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }

    if (audioRef.current && audioRef.current.src && !audioRef.current.ended) {
      ttsService.stop();
      audioRef.current.playbackRate = speedRef.current;
      audioRef.current
        .play()
        .then(() => {
          isPlayingRef.current = true;
          setIsPlaying(true);
          setPlaybackNotice(null);
        })
        .catch(() => {
          setPlaybackNotice('Browser blocked audio playback. Click Play again.');
        });
      return;
    }

    // Start from current position or restart from beginning if at end
    const targetTime =
      currentTimeSec >= totalDurationSec - 0.25 ? 0 : currentTimeSec;
    handleSeek(targetTime, true);
  };

  const handleSeek = (nextTimeSec: number, forcePlay?: boolean) => {
    if (readySegmentCount === 0 || totalDurationSec <= 0) return;
    const clamped = Math.max(0, Math.min(totalDurationSec, nextTimeSec));

    let acc = 0;
    let targetSeg = 0;
    let localOffset = 0;
    for (let i = 0; i < durationsRef.current.length; i++) {
      const dur = durationsRef.current[i] ?? 0;
      if (dur <= 0) continue;
      if (clamped <= acc + dur || i === durationsRef.current.length - 1) {
        targetSeg = i;
        localOffset = Math.max(0, clamped - acc);
        break;
      }
      acc += dur;
    }

    if (!blobsRef.current[targetSeg]) return;

    const shouldPlay = forcePlay ?? isPlayingRef.current;
    setCurrentTimeSec(clamped);

    if (shouldPlay) {
      playSegmentAt(targetSeg, localOffset);
    } else {
      // Update paused position cleanly
      if (audioRef.current && activeSegIdxRef.current === targetSeg) {
        audioRef.current.currentTime = localOffset;
      } else {
        stopAudioElement(false);
        activeSegIdxRef.current = targetSeg;
        setActiveSegmentIdx(targetSeg);
        const url =
          urlsRef.current[targetSeg] ??
          (() => {
            const created = URL.createObjectURL(blobsRef.current[targetSeg]!);
            urlsRef.current[targetSeg] = created;
            return created;
          })();
        const audio = new Audio(url);
        audio.playbackRate = speedRef.current;
        audio.addEventListener(
          'loadedmetadata',
          () => {
            audio.currentTime = Math.min(localOffset, Math.max(0, audio.duration - 0.05));
          },
          { once: true }
        );
        audioRef.current = audio;
      }
    }
  };

  const handleChangeSpeed = (nextSpeed: PlaybackRate) => {
    speedRef.current = nextSpeed;
    setSpeed(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  const handleDownloadWav = async () => {
    const availableBlobs = blobsRef.current.filter((b): b is Blob => b !== null);
    if (availableBlobs.length === 0) return;

    setIsDownloadingWav(true);
    try {
      const combinedWav = await concatenateWavBlobs(availableBlobs);
      const url = URL.createObjectURL(combinedWav);
      const slug = targetDocLabel.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 40);
      const a = document.createElement('a');
      a.href = url;
      a.download = `documind_audio_overview_${slug || 'documents'}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      onToast(
        'error',
        'Download failed',
        err instanceof Error ? err.message : 'Unable to export WAV audio.'
      );
    } finally {
      setIsDownloadingWav(false);
    }
  };

  const handleCopyTranscript = async () => {
    if (script.length === 0) return;
    const text = script.map((t) => `${t.speaker}: ${t.text}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 1600);
    } catch {
      // Clipboard blocked
    }
  };

  const isGeneratingScript = phase === 'script';
  const isGeneratingAudio = phase === 'audio';
  const isGenerating = isGeneratingScript || isGeneratingAudio;
  const hasMissingSegments =
    segmentRanges.length > 0 && readySegmentCount < segmentRanges.length;

  const playerStatusLabel = isBufferingNext
    ? `Waiting for segment ${activeSegmentIdx + 2} of ${audioSegmentsTotal}...`
    : isGeneratingAudio
    ? `Playing while generating (${audioSegmentsDone}/${audioSegmentsTotal})`
    : isPlaying
    ? `Playing · ${language === 'ta' ? 'Tamil' : 'English'}`
    : isLoadedFromCache
    ? 'Ready · Cached'
    : 'Ready to play';

  return (
    <div className="space-y-4">
      {/* Header & Controls Card */}
      <div className="rounded-[10px] bg-panel border border-line p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-0.5">
            <h2 className="text-[14px] font-semibold text-ink">Audio Overview</h2>
            <p className="text-[12px] text-ink-secondary">
              Two-host spoken discussion grounded strictly in {targetDocLabel} (
              {language === 'ta' ? 'Tamil' : 'English'}).
            </p>
          </div>

          <div className="flex items-center gap-2">
            {isGenerating ? (
              <Button variant="secondary" size="md" onClick={handleCancelGeneration}>
                Cancel
              </Button>
            ) : script.length > 0 ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => handleGenerate(true)}
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                Regenerate
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={() => handleGenerate(false)}
              >
                <Headphones className="w-4 h-4" strokeWidth={1.5} />
                Generate Audio Overview
              </Button>
            )}
          </div>
        </div>

        {/* Host Voice Pickers */}
        <div className="pt-3 border-t border-line flex flex-wrap items-center gap-x-5 gap-y-2.5 text-[12px]">
          <div className="flex items-center gap-2">
            <label htmlFor="ao-voice-a" className="text-ink-muted whitespace-nowrap">
              Host A
            </label>
            <Select
              id="ao-voice-a"
              size="sm"
              disabled={isGenerating}
              value={voiceA}
              onChange={(e) => setVoiceA(e.target.value as GeminiVoiceName)}
              options={GEMINI_VOICES.map((v) => ({
                value: v.name,
                label: `${v.name} · ${v.description}`,
              }))}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="ao-voice-b" className="text-ink-muted whitespace-nowrap">
              Host B
            </label>
            <Select
              id="ao-voice-b"
              size="sm"
              disabled={isGenerating}
              value={voiceB}
              onChange={(e) => setVoiceB(e.target.value as GeminiVoiceName)}
              options={GEMINI_VOICES.map((v) => ({
                value: v.name,
                label: `${v.name} · ${v.description}`,
              }))}
            />
          </div>
        </div>
      </div>

      {/* Step-by-step Generation Progress */}
      {isGenerating && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[10px] bg-panel border border-line p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center gap-1.5 font-medium ${
                  isGeneratingScript ? 'text-accent' : 'text-status-success'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isGeneratingScript ? 'bg-accent' : 'bg-status-success'
                  }`}
                />
                1. Writing script
              </span>
              <span className="text-ink-muted" aria-hidden="true">
                →
              </span>
              <span
                className={`inline-flex items-center gap-1.5 font-medium ${
                  isGeneratingAudio ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isGeneratingAudio ? 'bg-accent' : 'bg-line-strong'
                  }`}
                />
                2. Generating audio
              </span>
            </div>

            <span className="font-mono tabular-nums text-ink-muted">
              {isGeneratingScript
                ? `${scriptPercent}%`
                : `${audioSegmentsDone}/${audioSegmentsTotal || 1} segments`}
            </span>
          </div>

          <div className="h-[3px] rounded-full bg-raised overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-150 ease-out rounded-full"
              style={{
                width: `${
                  isGeneratingScript
                    ? Math.max(8, Math.round(scriptPercent * 0.45))
                    : Math.max(
                        48,
                        Math.round(
                          45 +
                            (audioSegmentsDone / Math.max(1, audioSegmentsTotal)) * 55
                        )
                      )
                }%`,
              }}
            />
          </div>

          <p className="text-[12px] text-ink-secondary">{statusDetail}</p>

          {isGeneratingScript && (
            <div className="pt-1">
              <SkeletonLines lines={4} />
            </div>
          )}
        </div>
      )}

      {/* Script Error */}
      {scriptError && (
        <div
          role="alert"
          className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
          <span>{scriptError}</span>
        </div>
      )}

      {/* Audio Error (still shows script below) */}
      {audioError && (
        <div
          role="alert"
          className="rounded-[8px] bg-status-warning-soft border border-status-warning/30 p-3.5 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink"
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <AlertCircle
              className="w-4 h-4 text-status-warning shrink-0 mt-0.5"
              strokeWidth={1.5}
            />
            <div className="space-y-0.5">
              <p className="font-medium text-[13px]">Audio synthesis paused</p>
              <p className="text-[12px] text-ink-secondary leading-relaxed">
                {audioError} The full conversation script is still available below.
              </p>
            </div>
          </div>
          {hasMissingSegments && !isGenerating && (
            <Button variant="secondary" size="sm" onClick={handleRetryMissingAudio}>
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
              Retry audio
            </Button>
          )}
        </div>
      )}

      {/* Reused Audio Player Bar (appears as soon as chunk 1 is ready) */}
      {readySegmentCount > 0 && (
        <div className="space-y-1.5">
          <AudioPlayerBar
            ariaLabel="Audio Overview player"
            isPlaying={isPlaying}
            isLoading={isBufferingNext}
            statusLabel={playerStatusLabel}
            speed={speed}
            currentTimeSec={currentTimeSec}
            durationSec={totalDurationSec}
            onTogglePlayPause={handleTogglePlayPause}
            onStop={() => stopAudioElement(true)}
            onChangeSpeed={handleChangeSpeed}
            onSeek={(t) => handleSeek(t)}
            extraActions={
              <Tooltip
                content={
                  isGeneratingAudio
                    ? 'Download available audio as WAV'
                    : 'Download full Audio Overview (.wav)'
                }
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isDownloadingWav || readySegmentCount === 0}
                  onClick={handleDownloadWav}
                  aria-label="Download audio as WAV"
                  className="h-7 px-2 text-[12px]"
                >
                  <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>{isDownloadingWav ? 'Saving...' : '.wav'}</span>
                </Button>
              </Tooltip>
            }
          />

          {playbackNotice && (
            <p className="text-[12px] text-ink-secondary px-1">{playbackNotice}</p>
          )}
        </div>
      )}

      {/* Interactive Transcript View */}
      {script.length > 0 && (
        <div className="rounded-[10px] bg-panel border border-line overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <span className="font-medium text-ink">Transcript</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-ink-muted">
                {script.length} turns
              </span>
              {isLoadedFromCache && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-ink-muted">Cached</span>
                </>
              )}
            </div>

            <Button variant="ghost" size="sm" onClick={handleCopyTranscript}>
              {copiedTranscript ? (
                <Check className="w-3.5 h-3.5 text-status-success" strokeWidth={1.5} />
              ) : (
                <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
              )}
              {copiedTranscript ? 'Copied' : 'Copy script'}
            </Button>
          </div>

          <div
            role="list"
            aria-label="Audio Overview transcript"
            className="divide-y divide-line max-h-[440px] overflow-y-auto"
          >
            {script.map((turn, idx) => {
              const range = turnTimeRanges[idx];
              const isCurrent = idx === activeTurnIndex;
              const isSegmentPlayable =
                range !== undefined && Boolean(blobsRef.current[range.segmentIndex]);
              const hostVoice = turn.speaker === 'Host A' ? voiceA : voiceB;

              return (
                <button
                  key={idx}
                  ref={(el) => {
                    if (el) turnElRefs.current.set(idx, el);
                    else turnElRefs.current.delete(idx);
                  }}
                  type="button"
                  role="listitem"
                  disabled={!isSegmentPlayable}
                  aria-current={isCurrent ? 'true' : undefined}
                  aria-label={`${turn.speaker}: ${turn.text}`}
                  onClick={() => {
                    if (range && isSegmentPlayable) {
                      handleSeek(range.startSec, true);
                    }
                  }}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors duration-150 ease-out border-l-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                    isCurrent
                      ? 'bg-accent-soft border-l-accent'
                      : 'border-l-transparent hover:bg-raised/60'
                  } ${isSegmentPlayable ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <div className="w-16 shrink-0 pt-0.5">
                    <span
                      className={`block text-[12px] font-medium ${
                        turn.speaker === 'Host A' ? 'text-accent' : 'text-ink'
                      }`}
                    >
                      {turn.speaker}
                    </span>
                    <span className="block text-[11px] font-mono text-ink-muted">
                      {hostVoice}
                    </span>
                  </div>
                  <p
                    className={`flex-1 text-[13.5px] leading-[1.6] ${
                      isCurrent ? 'text-ink font-medium' : 'text-ink-secondary'
                    }`}
                  >
                    {turn.text}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
