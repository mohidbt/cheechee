import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { AudioEngine, AudioTrack, Command, DeckId, DeckState, DJState, ServiceStatus, TrackAnalysis } from '../../shared/contracts';
import { demoCueSets } from '../../shared/catalog';
import type { AutopilotStatus } from '../autopilot/controller';
import { VideoStage } from '../video/VideoStage';
import './console.css';

export type Activity = {
  id: string;
  kind: 'user' | 'tool' | 'assistant' | 'error' | 'system';
  text: string;
  detail?: string;
  status?: 'requested' | 'accepted' | 'preparing' | 'ready' | 'scheduled' | 'started' | 'completed' | 'failed' | 'cancelled' | 'fallback';
  time: number;
};

export type ConsoleProps = {
  state: DJState;
  tracks: AudioTrack[];
  engine: AudioEngine;
  connected: boolean;
  services: ServiceStatus | null;
  busy: boolean;
  activities: Activity[];
  analyses: Record<string, TrackAnalysis | null>;
  analyzing: boolean;
  onAnalyze: () => void;
  autopilot: AutopilotStatus;
  onAutopilotToggle: () => void;
  onObjectiveChange: (value: string) => void;
  onChangeInterval: (seconds: number) => void;
  onManualIntent: () => void;
  onCommand: (command: Command) => Promise<void>;
  onSubmit: (text: string) => void;
  onStopAll: () => void;
  videoResetKey: number;
  onImport: (files: File[]) => void;
  voiceControls?: ReactNode;
  speechToggle?: ReactNode;
};

const fmt = (seconds: number) => {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

function Scope({ deck, engine, playing }: { deck: DeckId; engine: AudioEngine; playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const el = canvas.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (el.width !== width || el.height !== height) { el.width = width; el.height = height; }
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const color = deck === 'A' ? '#ffb454' : '#6bcbff';
      const mid = height / 2;
      ctx.strokeStyle = playing ? color : 'rgba(163,179,200,.36)';
      ctx.lineWidth = Math.max(1.5, ratio * 1.6);
      ctx.shadowColor = playing ? color : 'transparent';
      ctx.shadowBlur = playing ? 12 * ratio : 0;
      ctx.beginPath();
      const samples = playing ? engine.getWaveform(deck) : null;
      if (samples && samples.length) {
        const stride = Math.max(1, Math.floor(samples.length / width));
        for (let x = 0; x < width; x++) {
          const value = samples[Math.min(samples.length - 1, x * stride)] || 0;
          const y = mid - value * height * 0.42;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, mid); ctx.lineTo(width, mid);
      }
      ctx.stroke();
      const level = playing ? Math.max(0, Math.min(1, engine.getLevel(deck))) : 0;
      if (meter.current) meter.current.style.setProperty('--level', String(level));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [deck, engine, playing]);
  return <div className="scope-shell"><canvas ref={canvas} className="scope-canvas" aria-label={`Live waveform for deck ${deck}`} role="img" /><div className="scope-meter" aria-hidden="true"><div ref={meter} className="scope-meter-fill" /></div></div>;
}

function EQControl({ deck, band, value, state, onCommand, labelPrefix = 'Deck', rotary = false }: { deck: DeckId; band: 'low' | 'mid' | 'high'; value: number; state: DeckState; onCommand: ConsoleProps['onCommand']; labelPrefix?: string; rotary?: boolean }) {
  const [draft, setDraft] = useState(value);
  const lastSent = useRef(value);
  useEffect(() => { setDraft(value); lastSent.current = value; }, [value]);
  const commit = () => {
    if (draft === lastSent.current) return;
    lastSent.current = draft;
    void onCommand({ type: 'set_eq', deck, low_db: band === 'low' ? draft : state.eq.low, mid_db: band === 'mid' ? draft : state.eq.mid, high_db: band === 'high' ? draft : state.eq.high });
  };
  return <label className={`eq-control ${rotary ? "rotary-control" : ""}`}><span>{band}</span><span className="rotary-face" style={{ "--angle": `${-135 + (draft + 24) / 30 * 270}deg`, "--fill": `${(draft + 24) / 30 * 100}%` } as CSSProperties}><input aria-label={`${labelPrefix} ${deck} ${band} EQ`} type="range" min="-24" max="6" step="1" value={draft} onChange={e => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /></span><output>{draft > 0 ? "+" : ""}{draft}</output></label>;
}

function Deck({ id, deck, track, tracks, engine, onCommand }: { id: DeckId; deck: DeckState; track?: AudioTrack; tracks: AudioTrack[]; engine: AudioEngine; onCommand: ConsoleProps['onCommand'] }) {
  const [selected, setSelected] = useState('');
  const [frequency, setFrequency] = useState(deck.filter.frequency);
  useEffect(() => setFrequency(deck.filter.frequency), [deck.filter.frequency]);
  const chosen = selected && tracks.some(t => t.id === selected) ? selected : (track?.id || tracks[0]?.id || '');
  const playing = deck.status === 'playing';
  const hasTrack = Boolean(deck.trackId);
  const progress = deck.duration > 0 ? Math.min(100, (deck.position / deck.duration) * 100) : 0;
  const filterMode = deck.filter.mode;
  return <section className={`deck deck-${id.toLowerCase()}`} aria-label={`Deck ${id}`}>
    <div className="deck-topline"><span className="deck-identity"><b>{id}</b><span>Deck {id}</span></span><span className={`play-indicator ${playing ? 'is-playing' : ''}`}>{deck.status === 'loading' ? 'Loading' : playing ? 'On air' : deck.status === 'ready' ? 'Ready' : deck.status === 'stopped' ? 'Stopped' : 'Standby'}</span></div>
    <div className="track-display"><div className="track-title">{track?.title || 'No track loaded'}</div><div className="track-artist">{track?.artist || 'Choose a track from the library'}</div></div>
    <Scope deck={id} engine={engine} playing={playing} />
    <div className="timeline"><span>{fmt(deck.position)}</span><div className="progress-track" role="progressbar" aria-label={`Deck ${id} track progress`} aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }} /></div><span>-{fmt(Math.max(0, deck.duration - deck.position))}</span></div>
    <div className="deck-transport"><button className="transport-main" disabled={!hasTrack || deck.status === 'loading'} onClick={() => void onCommand({ type: playing ? 'stop' : 'play', deck: id })}>{playing ? '■  Stop' : '▶  Play'}</button><label className="track-pick"><span>Load</span><select aria-label={`Track to load on deck ${id}`} value={chosen} onChange={e => setSelected(e.target.value)} disabled={playing || deck.status === 'loading'}>{tracks.length === 0 && <option value="">No tracks</option>}{tracks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label><button className="small-action" disabled={!chosen || playing || deck.status === 'loading'} onClick={() => void onCommand({ type: 'load_track', deck: id, track_id: chosen })}>Load track</button></div>
    <div className="deck-processing"><div className="control-heading"><span>Equalizer</span><span>dB</span></div><div className="eq-group">{(['low','mid','high'] as const).map(band => <EQControl key={band} deck={id} band={band} value={deck.eq[band]} state={deck} onCommand={onCommand} />)}</div>
      <div className="control-heading filter-heading"><span>Filter</span><span>{filterMode === 'off' ? 'Bypassed' : `${Math.round(frequency)} Hz`}</span></div><div className="filter-modes">{(['off','lowpass','highpass'] as const).map(mode => <button key={mode} className={filterMode === mode ? 'selected' : ''} aria-pressed={filterMode === mode} onClick={() => void onCommand({ type:'set_filter', deck:id, mode, frequency_hz:frequency, duration_seconds:0.2 })}>{mode === 'off' ? 'Off' : mode === 'lowpass' ? 'Low pass' : 'High pass'}</button>)}</div><input className="filter-range" aria-label={`Deck ${id} filter frequency`} type="range" min="40" max="16000" step="10" value={frequency} onChange={e => setFrequency(Number(e.target.value))} onPointerUp={() => { if(filterMode !== 'off') void onCommand({type:'set_filter',deck:id,mode:filterMode,frequency_hz:frequency,duration_seconds:0.2}); }} onKeyUp={() => { if(filterMode !== 'off') void onCommand({type:'set_filter',deck:id,mode:filterMode,frequency_hz:frequency,duration_seconds:0.2}); }} />
      <label className="volume-line"><span>Channel</span><input aria-label={`Deck ${id} volume`} type="range" min="0" max="1" step="0.01" value={deck.volume} onChange={e => engine.setDeckVolume(id, Number(e.target.value))} /><output>{Math.round(deck.volume * 100)}%</output></label>
    </div>
  </section>;
}

function PerformanceDeck({ id, deck, track, engine, onCommand }: { id: DeckId; deck: DeckState; track?: AudioTrack; engine: AudioEngine; onCommand: ConsoleProps['onCommand'] }) {
  return <section className="performance-deck" aria-label={`Performance deck ${id}`}>
    <div className="performance-deck-heading"><span className="performance-deck-id">{id}</span><div><strong>{track?.title || 'Empty deck'}</strong><small>{deck.status === 'playing' ? 'On air' : deck.status}</small></div><time>{fmt(deck.position)}</time></div>
    <div className="performance-eq">{(['low', 'mid', 'high'] as const).map(band => <EQControl key={band} deck={id} band={band} value={deck.eq[band]} state={deck} onCommand={onCommand} labelPrefix="Performance deck" rotary />)}</div>
    <label className="performance-gain"><span>Gain</span><input aria-label={`Performance deck ${id} gain`} type="range" min="0" max="1" step="0.01" value={deck.volume} onChange={event => engine.setDeckVolume(id, Number(event.target.value))} /><output>{Math.round(deck.volume * 100)}%</output></label>
  </section>;
}

export function Console({ state, tracks, engine, connected, services, busy, activities, analyses, analyzing, onAnalyze, autopilot, onAutopilotToggle, onObjectiveChange, onChangeInterval, onManualIntent, onCommand, onSubmit, onStopAll, videoResetKey, onImport, voiceControls, speechToggle }: ConsoleProps) {
  const [text, setText] = useState('');
  const [objective, setObjective] = useState(autopilot.objective);
  useEffect(() => setObjective(autopilot.objective), [autopilot.objective]);
  const [style, setStyle] = useState<'crossfade' | 'filter' | 'echo'>('crossfade');
  const [duration, setDuration] = useState(4);
  const [transitionTrack, setTransitionTrack] = useState('');
  const [trayOpen, setTrayOpen] = useState(true);
  const [showMixer, setShowMixer] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const musicPlaying = state.decks.A.status === 'playing' || state.decks.B.status === 'playing';
  const currentTrack = (id: DeckId) => tracks.find(track => track.id === state.decks[id].trackId);
  const nextTrack = transitionTrack && tracks.some(track => track.id === transitionTrack)
    ? transitionTrack
    : tracks.find(track => track.id !== state.decks.A.trackId && track.id !== state.decks.B.trackId)?.id || tracks[0]?.id || '';
  const agentReady = connected && services?.agent === true;
  const activeDeck: DeckId | null = state.transition?.from || (state.decks.A.status === 'playing' ? 'A' : state.decks.B.status === 'playing' ? 'B' : null);
  const bpmFor = (id: DeckId) => {
    const trackId = state.decks[id].trackId;
    const reviewed = trackId ? demoCueSets[trackId]?.reviewedPulseGrid?.bpm : null;
    if (reviewed) return `${reviewed} BPM`;
    const estimated = trackId ? (analyses[trackId] || engine.getTrackAnalysis(trackId))?.estimatedTempo?.bpm : null;
    return estimated ? `~${estimated} BPM` : null;
  };
  const bpmLine = activeDeck ? bpmFor(activeDeck) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy || !agentReady) return;
    onSubmit(trimmed);
    setText('');
  };
  const unlock = async () => {
    try { await engine.unlock(); setUnlockError(''); }
    catch { setUnlockError('Sound is blocked. Tap Enable sound to try again.'); }
  };
  return <main className="dj-app performance-app">
    <section className="performance-stage" aria-label="DJ performance">
      <VideoStage engine={engine} resetKey={videoResetKey} />
      <div className="stage-shade" aria-hidden="true" />
      <header className="stage-header">
        <div className="stage-identity"><img className="stage-mark" src="/cheechee-mark.png" alt="" /><strong>Cheechee</strong>{bpmLine && <span className="stage-bpm">{bpmLine}</span>}</div>
        <div className="stage-actions-top">
          <button type="button" className="actions-toggle" aria-expanded={actionsOpen} aria-controls="live-actions" onClick={() => setActionsOpen(value => !value)}>cheechee's thoughts{busy ? <span className="working-dot" aria-label="Agent working" /> : null}</button>
          <button type="button" className="stop-all" onClick={onStopAll}>Stop all</button>
        </div>
      </header>
      <aside id="live-actions" className={`actions-panel stage-actions ${actionsOpen ? 'is-open' : ''}`} aria-label="cheechee's thoughts" inert={!actionsOpen}>
        <div className="activity-heading"><strong>cheechee's thoughts</strong><button type="button" aria-label="Close cheechee's thoughts" onClick={() => setActionsOpen(false)}>Close</button></div>
        <div className="activity-feed" aria-live="polite">{activities.length === 0 ? <p className="empty-copy">Actions will appear here.</p> : activities.slice(-12).reverse().map(item => <div className={`activity-item activity-${item.kind}`} key={item.id}><span className="activity-symbol" aria-hidden="true">{item.kind === 'tool' ? '⌘' : item.kind === 'error' ? '!' : item.kind === 'user' ? '›' : '•'}</span><div><div className="activity-main"><span>{item.text}</span>{item.status && <small className={`activity-status status-${item.status}`}>{item.status === 'fallback' ? 'automatic' : item.status}</small>}</div>{item.detail && <details><summary>Details</summary><pre>{item.detail}</pre></details>}</div><time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time></div>)}</div>
      </aside>
      <div className={`stage-bottom ${trayOpen ? 'is-open' : ''} ${!musicPlaying ? 'is-idle' : ''} ${showMixer ? 'show-mixer' : ''}`}>
        <button type="button" className="tray-toggle" aria-expanded={trayOpen} aria-controls="performance-tray" onClick={() => setTrayOpen(value => !value)}><span>Controls</span><span aria-hidden="true">{trayOpen ? '⌄' : '⌃'}</span></button>
        <div id="performance-tray" className="performance-tray" hidden={!trayOpen} inert={!trayOpen}>
          <div className="stage-inputs">
            <section className="assistant-input" aria-label="DJ assistant"><div className="stage-input-heading"><div><strong>Start some music</strong><span>Ask for a song or mood</span></div>{speechToggle}</div>{voiceControls}<form className="command-form" onSubmit={submit}><input aria-label="DJ command" value={text} onChange={event => { onManualIntent(); setText(event.target.value); }} placeholder={agentReady ? 'Play something upbeat…' : 'Agent unavailable'} disabled={busy || !agentReady} /><button type="submit" disabled={busy || !agentReady || !text.trim()}>{busy ? 'Working' : 'Send'}</button></form></section>
            <section className="autopilot-control" aria-label="Autopilot"><div className="autopilot-top"><strong>Autopilot</strong><button type="button" role="switch" aria-label="Autopilot" aria-checked={autopilot.mode === 'running'} disabled={analyzing || busy} onClick={onAutopilotToggle}>{autopilot.mode === 'running' ? 'On' : 'Off'}</button></div><div className="autopilot-settings"><label>Direction<input aria-label="Autopilot direction" maxLength={500} value={objective} onChange={event => setObjective(event.target.value)} onBlur={() => onObjectiveChange(objective)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><label>Change every<select aria-label="Time between changes" value={autopilot.changeIntervalSeconds} onChange={event => onChangeInterval(Number(event.target.value))}><option value={20}>20 seconds</option><option value={60}>60 seconds</option><option value={120}>120 seconds</option></select></label></div><p role="status">{autopilot.line}</p></section>
          </div>
          {!musicPlaying && <button type="button" className="mixer-reveal" aria-expanded={showMixer} onClick={() => setShowMixer(value => !value)}>{showMixer ? 'Hide mixer' : 'Show mixer'}</button>}
          <section className="performance-mixer" aria-label="Performance mixer" onPointerDownCapture={onManualIntent} onKeyDownCapture={onManualIntent}>
            <PerformanceDeck id="A" deck={state.decks.A} track={currentTrack('A')} engine={engine} onCommand={onCommand} />
            <div className="performance-master"><label><span>Crossfader</span><input aria-label="Performance crossfader" type="range" min="0" max="1" step="0.01" value={state.crossfader} onChange={event => engine.setCrossfader(Number(event.target.value))} /><output>A {Math.round(state.crossfader * 100)} B</output></label><label><span>Master</span><input aria-label="Performance master volume" type="range" min="0" max="1" step="0.01" value={state.masterVolume} onChange={event => engine.setMasterVolume(Number(event.target.value))} /><output>{Math.round(state.masterVolume * 100)}%</output></label></div>
            <PerformanceDeck id="B" deck={state.decks.B} track={currentTrack('B')} engine={engine} onCommand={onCommand} />
          </section>
          {!state.unlocked && <div className="sound-fallback"><button type="button" onClick={() => void unlock()}>Enable sound</button>{unlockError && <span role="alert">{unlockError}</span>}</div>}
        </div>
      </div>
    </section>
    <section className="understage" aria-label="More DJ controls">
      <div className="understage-heading"><span>Mix workspace</span><span className={`connection-state ${agentReady ? 'online' : ''}`}><span className="status-dot" />{agentReady ? 'Agent online' : 'Agent unavailable'}</span></div>
      <details className="advanced-controls" open><summary>Advanced controls <span>Deck transport, effects and transitions</span></summary><div className="mixing-surface" onPointerDownCapture={onManualIntent} onKeyDownCapture={onManualIntent} onChangeCapture={onManualIntent}><Deck id="A" deck={state.decks.A} track={currentTrack('A')} tracks={tracks} engine={engine} onCommand={onCommand} />
        <section className="mixer" aria-label="Mixer"><div className="mixer-heading">Mixer</div><div className="mixer-fader"><div className="mixer-pips" aria-hidden="true"><span>A</span><span>B</span></div><label htmlFor="crossfader">Crossfader</label><input id="crossfader" type="range" min="0" max="1" step="0.01" value={state.crossfader} onChange={event => engine.setCrossfader(Number(event.target.value))} /><div className="fader-values"><span>A</span><span>Center</span><span>B</span></div></div><label className="master-control"><span>Master output</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={state.masterVolume} onChange={event => engine.setMasterVolume(Number(event.target.value))} /><output>{Math.round(state.masterVolume * 100)}%</output></label><div className="mixer-divider" />
          <div className="transition-panel"><div className="panel-heading"><strong>Next move</strong><span>{state.transition ? `${state.transition.style} in progress` : 'Transition'}</span></div><select aria-label="Next track" value={nextTrack} onChange={event => setTransitionTrack(event.target.value)}>{tracks.length === 0 && <option value="">No tracks</option>}{tracks.map(track => <option key={track.id} value={track.id}>{track.title} · {track.artist}</option>)}</select><div className="style-grid">{(['crossfade','filter','echo'] as const).map(choice => <button key={choice} aria-pressed={style === choice} className={style === choice ? 'selected' : ''} onClick={() => setStyle(choice)}>{choice === 'crossfade' ? 'Crossfade' : choice === 'filter' ? 'Filter sweep' : 'Echo out'}</button>)}</div><label className="duration-line">Duration <select aria-label="Transition duration" value={duration} onChange={event => setDuration(Number(event.target.value))}><option value={2}>2 sec</option><option value={4}>4 sec</option><option value={8}>8 sec</option><option value={12}>12 sec</option></select></label><button className="transition-go" disabled={!nextTrack || !!state.transition} onClick={() => void onCommand({type:'transition',track_id:nextTrack,style,duration_seconds:duration})}>Start transition</button>{state.transition && <div className="transition-progress"><div style={{width:`${state.transition.progress * 100}%`}} /></div>}</div></section>
        <Deck id="B" deck={state.decks.B} track={currentTrack('B')} tracks={tracks} engine={engine} onCommand={onCommand} /></div></details>
      <section className="library" aria-label="Track library"><div className="section-title"><div><strong>Library</strong><span>{tracks.length} tracks</span></div><div className="library-actions"><button type="button" disabled={analyzing || autopilot.mode === 'running' || !tracks.length} onClick={onAnalyze}>{analyzing ? 'Analyzing…' : 'Analyze tracks'}</button><button type="button" onClick={() => fileInput.current?.click()}>Import audio</button></div><input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={event => { if (event.target.files?.length) onImport(Array.from(event.target.files)); event.target.value = ''; }} /></div><div className="library-list" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onImport(Array.from(event.dataTransfer.files)); }}>{tracks.length === 0 ? <p className="empty-copy">Drop audio files here.</p> : tracks.map((track, index) => <div className="library-row" key={track.id}><span className="track-index">{String(index + 1).padStart(2,'0')}</span><div><strong>{track.title}</strong><span>{track.artist}{analyses[track.id]?.estimatedTempo ? ` · ~${analyses[track.id]?.estimatedTempo?.bpm} BPM` : ''}</span></div><span className="track-tags">{track.tags.slice(0,2).join(' / ')}</span><span className="track-energy">{track.energy}</span></div>)}</div></section>
      <footer className="app-repo-link"><a href="https://github.com/mohidbt/cheechee" target="_blank" rel="noopener noreferrer">View Cheechee on GitHub</a></footer>
    </section>
  </main>;
}
