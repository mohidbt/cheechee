import { useCallback, useEffect, useRef, useState } from 'react';
import { CommitStrategy, useScribe } from '@elevenlabs/react';
import { createAudioEngine } from './audio/engine';
import { DJBridge, type BridgeEvent } from './bridge';
import { AutopilotController, type AutopilotStatus } from './autopilot/controller';
import { DEFAULT_CHANGE_INTERVAL_SECONDS, DEFAULT_OBJECTIVE, buildMusicalContext } from './autopilot/context';
import { Console, type Activity } from './ui/Console';
import { demoTracks } from '../shared/catalog';
import type { AudioEngine, AudioTrack, Command, ServiceStatus, TrackAnalysis } from '../shared/contracts';
import './voice.css';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

type VoiceProps = {
  enabled: boolean;
  disabledReason: string;
  engine: AudioEngine;
  onSubmit: (text: string) => void;
  onError: (text: string) => void;
  stopRef: React.MutableRefObject<() => void>;
  cancelSpeech: () => void;
  onStart: () => void;
};

function VoiceInput({ enabled, disabledReason, engine, onSubmit, onError, stopRef, cancelSpeech, onStart }: VoiceProps) {
  const [held, setHeld] = useState(false);
  const [preview, setPreview] = useState('');
  const session = useRef<{ released: boolean; connected: boolean; segments: string[]; timer?: ReturnType<typeof setTimeout>; done: boolean } | null>(null);
  const connecting = useRef(false);
  const callback = useRef({ onSubmit, onError, onStart });
  callback.current = { onSubmit, onError, onStart };
  const scribe = useScribe({
    modelId: 'scribe_v2_realtime', commitStrategy: CommitStrategy.MANUAL,
    onPartialTranscript: data => { if (session.current) setPreview(data.text); },
    onCommittedTranscript: data => {
      const current = session.current;
      if (!current || current.done || !data.text.trim()) return;
      current.segments.push(data.text.trim());
      setPreview(current.segments.join(' '));
      if (current.released) { clearTimeout(current.timer); current.timer = setTimeout(() => finish(), 200); }
    },
    onError: error => { if (session.current) { callback.current.onError(`Microphone: ${message(error)}`); stop(); } },
  });
  const scribeRef = useRef(scribe);
  scribeRef.current = scribe;

  function finish() {
    const current = session.current;
    if (!current || current.done) return;
    current.done = true;
    clearTimeout(current.timer);
    const transcript = current.segments.join(' ').trim();
    scribeRef.current.disconnect();
    session.current = null;
    setHeld(false);
    setPreview('');
    engine.setDucking(false);
    if (transcript) callback.current.onSubmit(transcript);
    else callback.current.onError('No speech was captured. Hold the microphone button and try again.');
  }

  function stop() {
    const current = session.current;
    if (current) { current.done = true; clearTimeout(current.timer); }
    session.current = null;
    scribeRef.current.disconnect();
    setHeld(false);
    setPreview('');
    engine.setDucking(false);
  }
  stopRef.current = stop;
  useEffect(() => () => stop(), []);

  async function start() {
    if (!enabled || session.current || connecting.current) return;
    callback.current.onStart();
    connecting.current = true;
    cancelSpeech();
    const current = { released: false, connected: false, segments: [] as string[], timer: undefined as ReturnType<typeof setTimeout> | undefined, done: false };
    session.current = current;
    setHeld(true);
    setPreview('Connecting microphone…');
    engine.setDucking(true);
    try {
      const response = await fetch('/api/scribe-token', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Speech input is unavailable.');
      if (session.current !== current) return;
      if (current.released) { stop(); return; }
      await scribeRef.current.connect({ token: body.token, microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // stop() already closed this session. A newer press may now own Scribe.
      if (session.current !== current) return;
      if (current.released) { stop(); return; }
      current.connected = true;
      setPreview('Listening…');
    } catch (error) {
      if (session.current === current) { callback.current.onError(`Microphone: ${message(error)}`); stop(); }
    } finally {
      connecting.current = false;
    }
  }

  function release() {
    const current = session.current;
    if (!current || current.released) return;
    current.released = true;
    setHeld(false);
    if (!current.connected) { stop(); return; }
    setPreview(current.segments.join(' ') || 'Finishing transcript…');
    try {
      scribeRef.current.mute();
      scribeRef.current.commit();
      current.timer = setTimeout(() => {
        if (session.current === current && !current.done) {
          callback.current.onError('Transcription did not finish. Please try speaking again.');
          stop();
        }
      }, 3000);
    } catch (error) { callback.current.onError(`Microphone: ${message(error)}`); stop(); }
  }

  return <div className="voice-input"><button type="button" className={`mic-button ${held ? 'is-held' : ''}`} disabled={!enabled} aria-label="Hold to speak DJ command" onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); void start(); }} onPointerUp={release} onPointerCancel={stop} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void start(); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); release(); } }}>🎙 {held ? 'Listening' : 'Hold to speak'}</button><span className="voice-preview" aria-live="polite">{preview || (enabled ? 'Release to send your request' : disabledReason)}</span></div>;
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = createAudioEngine(demoTracks);
  const engine = engineRef.current;
  const [state, setState] = useState(() => engine.getState());
  const [tracks, setTracks] = useState<AudioTrack[]>(demoTracks);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const [connected, setConnected] = useState(false);
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoResetKey, setVideoResetKey] = useState(0);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, TrackAnalysis | null>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [speechOn, setSpeechOn] = useState(true);
  const [autopilot, setAutopilot] = useState<AutopilotStatus>({ mode: 'off', phase: 'idle', objective: DEFAULT_OBJECTIVE, changeIntervalSeconds: DEFAULT_CHANGE_INTERVAL_SECONDS, line: 'Autopilot is off.', nextTrackId: null, secondsUntilNext: null });
  const autopilotRef = useRef<AutopilotController | null>(null);
  const queuedCommands = useRef<Array<{ command: Command; resolve: (result: Awaited<ReturnType<AudioEngine['execute']>>) => void }>>([]);
  const queuedRequest = useRef<string | null>(null);
  const queueGeneration = useRef(0);
  const autopilotToggleGeneration = useRef(0);
  const bridgeRef = useRef<DJBridge | null>(null);
  const importedUrls = useRef<string[]>([]);
  const voiceStop = useRef<() => void>(() => {});
  const speech = useRef<{ controller?: AbortController; audio?: HTMLAudioElement; url?: string }>({});
  const add = useCallback((activity: Omit<Activity, 'id' | 'time'> & { id?: string }) => {
    const id = activity.id || crypto.randomUUID();
    setActivities(current => [...current.slice(-99).filter(item => item.id !== id), { ...activity, id, time: Date.now() }]);
  }, []);
  const cancelSpeech = useCallback(() => {
    speech.current.controller?.abort();
    speech.current.audio?.pause();
    if (speech.current.url) URL.revokeObjectURL(speech.current.url);
    speech.current = {};
    engine.setDucking(false);
  }, [engine]);
  const speak = useCallback(async (text: string) => {
    cancelSpeech();
    if (!speechOn || !services?.tts || !text.trim()) return;
    const controller = new AbortController();
    speech.current = { controller };
    try {
      const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 500) }), signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Speech output failed.');
      const url = URL.createObjectURL(await response.blob());
      if (controller.signal.aborted) { URL.revokeObjectURL(url); return; }
      const audio = new Audio(url);
      speech.current = { controller, audio, url };
      audio.onended = () => cancelSpeech();
      audio.onerror = () => cancelSpeech();
      engine.setDucking(true);
      await audio.play();
    } catch (error) {
      if (!controller.signal.aborted) { add({ kind: 'error', text: `Spoken reply: ${message(error)}` }); cancelSpeech(); }
    }
  }, [add, cancelSpeech, engine, services?.tts, speechOn]);
  const speakRef = useRef(speak);
  speakRef.current = speak;

  useEffect(() => {
    const unsubscribe = engine.subscribe(() => setState(engine.getState()));
    let lastTransition = engine.getState().transition;
    const observe = engine.subscribe(() => {
      const current = engine.getState().transition;
      if (lastTransition && !current && engine.getState().decks[lastTransition.to].status === 'playing') add({ kind: 'system', text: `${lastTransition.style} transition completed.`, status: 'completed' });
      lastTransition = current;
    });
    const onEvent = (event: BridgeEvent) => {
      if (event.type === 'connection') { setConnected(event.connected); if (!event.connected) cancelSpeech(); }
      if (event.type === 'busy') setBusy(event.busy);
      if (event.type === 'error') add({ kind: 'error', text: event.text, status: 'failed' });
      if (event.type === 'assistant') { add({ kind: 'assistant', text: event.text }); if (event.source === 'conversation') void speakRef.current(event.text); }
      if (event.type === 'tool') {
        const id = `${event.requestId}:${event.batchId}:${event.index}`;
        add({ id, kind: 'tool', text: `${event.index + 1}. ${event.result?.message || event.command.type.replaceAll('_', ' ')}`, detail: `apply_mix command ${event.index + 1}\n${JSON.stringify(event.command, null, 2)}${event.result ? `\nResult: ${JSON.stringify(event.result, null, 2)}` : ''}`, status: event.status });
      }
    };
    const bridge = new DJBridge(engine, () => tracksRef.current, onEvent, command => command.type === 'transition' && command.timing === 'next_cue' ? autopilotRef.current?.scheduleManualCue(command) || Promise.resolve({ ok: false, code: 'controller_unavailable', message: 'Cue scheduler is unavailable.' }) : engine.execute(command));
    bridgeRef.current = bridge;
    const controller = new AutopilotController(engine, bridge, () => tracksRef.current, setAutopilot, trace => add({ kind: trace.status === 'failed' ? 'error' : 'system', text: trace.text, detail: `Correlation: ${trace.key}${trace.detail ? `\n${trace.detail}` : ''}`, status: trace.status }));
    autopilotRef.current = controller;
    const visibility = () => { if (document.visibilityState === 'hidden') { controller.cancelManualCue(); controller.pause('Page hidden. Resume Autopilot explicitly.'); } };
    document.addEventListener('visibilitychange', visibility);
    const drain = engine.subscribeLifecycle(event => {
      if (event.type !== 'transition_completed') return;
      const text = queuedRequest.current;
      queuedRequest.current = null;
      if (text) {
        const context = autopilotRef.current?.getContext() || buildMusicalContext(engine.getState(), tracksRef.current, DEFAULT_OBJECTIVE, []);
        if (!bridge.submit(text, context)) add({ kind: 'error', text: 'Queued manual request could not be sent.' });
      }
      const next = queuedCommands.current.splice(0);
      const generation = queueGeneration.current;
      void (async () => { for (const item of next) { if (generation !== queueGeneration.current) { item.resolve({ ok: false, code: 'cancelled', message: 'Action cancelled.' }); continue; } try { item.resolve(await engine.execute(item.command)); } catch (error) { item.resolve({ ok: false, code: 'execution_error', message: message(error) }); } } })();
    });
    bridge.connect();
    let alive = true;
    const status = async () => {
      try { const response = await fetch('/api/status'); if (response.ok && alive) setServices(await response.json()); }
      catch { if (alive) setServices(null); }
    };
    void status();
    const refresh = setInterval(status, 10000);
    return () => {
      alive = false;
      clearInterval(refresh);
      bridge.close();
      controller.dispose();
      document.removeEventListener('visibilitychange', visibility);
      autopilotRef.current = null;
      drain();
      queuedCommands.current.splice(0).forEach(item => item.resolve({ ok: false, code: 'cancelled', message: 'Action cancelled.' }));
      queuedRequest.current = null;
      queueGeneration.current++;
      autopilotToggleGeneration.current++;
      bridgeRef.current = null;
      unsubscribe(); observe();
      voiceStop.current();
      cancelSpeech();
      importedUrls.current.forEach(url => URL.revokeObjectURL(url));
      engine.dispose();
    };
  }, [add, cancelSpeech, engine]);

  useEffect(() => {
    let active = true;
    const unlock = () => {
      if (!active || engine.getState().unlocked) return;
      // Call resume during the gesture itself. A blocked mount attempt may still be pending.
      void engine.unlock().then(() => { if (active) removeGestureListeners(); }).catch(() => {});
    };
    const pointer = () => unlock();
    const keyboard = (event: KeyboardEvent) => { if (!event.repeat && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) unlock(); };
    const removeGestureListeners = () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('touchstart', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('touchstart', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    unlock();
    return () => { active = false; removeGestureListeners(); };
  }, [engine]);

  const submit = useCallback((text: string) => {
    cancelSpeech();
    autopilotRef.current?.pause('Paused for manual request.');
    autopilotRef.current?.cancelManualCue();
    if (engine.getState().transition) { queuedRequest.current = text; add({ kind: 'user', text }); add({ kind: 'system', text: 'Manual request queued until the current transition finishes.', status: 'scheduled' }); return; }
    const context = autopilotRef.current?.getContext() || buildMusicalContext(engine.getState(), tracksRef.current, DEFAULT_OBJECTIVE, []);
    if (bridgeRef.current?.submit(text, context)) add({ kind: 'user', text });
    else add({ kind: 'error', text: 'The agent is busy or disconnected.' });
  }, [add, cancelSpeech, engine]);
  const manual = useCallback(async (command: Command) => {
    const generation = queueGeneration.current;
    autopilotRef.current?.pause('Paused for manual control.');
    autopilotRef.current?.cancelManualCue();
    try {
      if (!engine.getState().unlocked) await engine.unlock();
      if (generation !== queueGeneration.current) return;
      const result = engine.getState().transition && command.type !== 'get_dj_state'
        ? await new Promise<Awaited<ReturnType<AudioEngine['execute']>>>(resolve => { queuedCommands.current.push({ command, resolve }); add({ kind: 'system', text: 'Manual action queued until the current transition finishes.', status: 'scheduled' }); })
        : command.type === 'transition' && command.timing === 'next_cue' ? await autopilotRef.current?.scheduleManualCue(command) || { ok: false, code: 'controller_unavailable', message: 'Cue scheduler is unavailable.' } : await engine.execute(command);
      add({ kind: result.ok ? 'system' : 'error', text: result.message, detail: JSON.stringify(command, null, 2), status: result.ok ? result.scheduled ? 'scheduled' : 'completed' : 'failed' });
    } catch (error) { add({ kind: 'error', text: message(error), detail: JSON.stringify(command, null, 2), status: 'failed' }); }
  }, [add, engine]);
  const stopAll = useCallback(() => {
    autopilotToggleGeneration.current++;
    autopilotRef.current?.stopAll();
    queuedRequest.current = null;
    queueGeneration.current++;
    queuedCommands.current.splice(0).forEach(item => item.resolve({ ok: false, code: 'cancelled', message: 'Action cancelled by Stop all.' }));
    voiceStop.current();
    cancelSpeech();
    bridgeRef.current?.cancel();
    engine.stopAll();
    setVideoResetKey(value => value + 1);
    add({ kind: 'system', text: 'All audio stopped and pending DJ request cancelled.', status: 'completed' });
  }, [add, cancelSpeech, engine]);
  const importFiles = useCallback((files: File[]) => {
    const next = [...tracksRef.current];
    let imported = 0;
    for (const file of files) {
      if (next.filter(track => track.source === 'local').length >= 10 || next.length >= 20) { add({ kind: 'error', text: 'The local library is limited to 10 imported tracks.' }); break; }
      if (file.size > 25 * 1024 * 1024) { add({ kind: 'error', text: `${file.name} exceeds the 25 MB limit.` }); continue; }
      if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name)) { add({ kind: 'error', text: `${file.name} is not a supported audio file.` }); continue; }
      const url = URL.createObjectURL(file);
      importedUrls.current.push(url);
      next.push({ id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, '').slice(0, 150), artist: 'Local file', tags: [], energy: 'unknown', source: 'local', loop: false, url });
      imported++;
    }
    if (imported) { tracksRef.current = next; setTracks(next); engine.setTracks(next); autopilotRef.current?.catalogueChanged(); add({ kind: 'system', text: `Imported ${imported} local track${imported === 1 ? '' : 's'}.`, status: 'completed' }); }
  }, [add, engine]);

  const analyzeLibrary = useCallback(async () => {
    if (analyzing || autopilotRef.current?.getStatus().mode === 'running') { add({ kind: 'error', text: 'Pause Autopilot before analyzing tracks.' }); return; }
    setAnalyzing(true);
    const catalogue = [...tracksRef.current];
    let completed = 0;
    for (const track of catalogue) {
      if (autopilotRef.current?.getStatus().mode === 'running') break;
      try {
        const result = await engine.analyzeTrack(track.id);
        setAnalyses(current => ({ ...current, [track.id]: result }));
        completed++;
      } catch (error) { add({ kind: 'error', text: `Analysis of ${track.title} failed: ${message(error)}` }); }
    }
    add({ kind: 'system', text: `Analyzed ${completed} track${completed === 1 ? '' : 's'}. BPM and beat offsets are estimates, not verified beats.`, status: 'completed' });
    setAnalyzing(false);
  }, [add, analyzing, engine]);

  const agentReady = connected && services?.agent === true && !busy;
  const voiceDisabledReason = !services ? 'Connecting voice services…' : !services.speech ? 'Voice service unavailable.' : !services.agent ? 'DJ agent unavailable.' : !connected ? 'Connecting to DJ agent…' : 'DJ is working. Try again shortly.';
  return <Console state={state} tracks={tracks} engine={engine} connected={connected} services={services} busy={busy} activities={activities} analyses={analyses} analyzing={analyzing} onAnalyze={() => void analyzeLibrary()} autopilot={autopilot} onAutopilotToggle={() => { const generation = ++autopilotToggleGeneration.current; if (autopilot.mode === 'running') { autopilotRef.current?.disable(); return; } if (analyzing) return; if (bridgeRef.current?.isManualBusy()) { add({ kind: 'system', text: 'Wait for the current DJ request to finish before starting Autopilot.' }); return; } void (async () => { try { if (!engine.getState().unlocked) await engine.unlock(); if (generation === autopilotToggleGeneration.current) autopilotRef.current?.enable(); } catch (error) { if (generation === autopilotToggleGeneration.current) add({ kind: 'error', text: `Audio could not start: ${message(error)}` }); } })(); }} onObjectiveChange={value => autopilotRef.current?.setObjective(value)} onChangeInterval={value => autopilotRef.current?.setChangeInterval(value)} onManualIntent={() => { autopilotRef.current?.pause('Paused for manual control.'); autopilotRef.current?.cancelManualCue(); }} onCommand={manual} onSubmit={submit} onStopAll={stopAll} videoResetKey={videoResetKey} onImport={importFiles} speechToggle={<button type="button" className="speech-toggle" aria-pressed={speechOn} onClick={() => { setSpeechOn(value => !value); cancelSpeech(); }}>{speechOn ? 'Voice reply on' : 'Voice reply off'}</button>} voiceControls={<VoiceInput enabled={agentReady && services?.speech === true} disabledReason={voiceDisabledReason} engine={engine} onSubmit={submit} onStart={() => { autopilotRef.current?.pause('Paused for voice control.'); autopilotRef.current?.cancelManualCue(); }} onError={text => add({ kind: 'error', text })} stopRef={voiceStop} cancelSpeech={cancelSpeech} />} />;
}
