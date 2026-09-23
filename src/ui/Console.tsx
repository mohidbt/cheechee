import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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

const examples = ['Play something energetic', 'Cut the bass', 'Echo into the next track'];
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

function EQControl({ deck, band, value, state, onCommand, labelPrefix = 'Deck' }: { deck: DeckId; band: 'low' | 'mid' | 'high'; value: number; state: DeckState; onCommand: ConsoleProps['onCommand']; labelPrefix?: string }) {
  const [draft, setDraft] = useState(value);
  const lastSent = useRef(value);
  useEffect(() => { setDraft(value); lastSent.current = value; }, [value]);
  const commit = () => {
    if (draft === lastSent.current) return;
    lastSent.current = draft;
    void onCommand({ type: 'set_eq', deck, low_db: band === 'low' ? draft : state.eq.low, mid_db: band === 'mid' ? draft : state.eq.mid, high_db: band === 'high' ? draft : state.eq.high });
  };
  return <label className="eq-control"><span>{band}</span><input aria-label={`${labelPrefix} ${deck} ${band} EQ`} type="range" min="-24" max="6" step="1" value={draft} onChange={e => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /><output>{draft > 0 ? '+' : ''}{draft}</output></label>;
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
    <div className="performance-eq">{(['low', 'mid', 'high'] as const).map(band => <EQControl key={band} deck={id} band={band} value={deck.eq[band]} state={deck} onCommand={onCommand} labelPrefix="Performance deck" />)}</div>
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
  const [unlockError, setUnlockError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const currentTrack = (id: DeckId) => tracks.find(t => t.id === state.decks[id].trackId);
  const nextTrack = transitionTrack && tracks.some(t => t.id === transitionTrack) ? transitionTrack : (tracks.find(t => t.id !== state.decks.A.trackId && t.id !== state.decks.B.trackId)?.id || tracks[0]?.id || '');
  const agentReady = connected && services?.agent === true;
  const nextAutopilotTrack = autopilot.nextTrackId ? tracks.find(track => track.id === autopilot.nextTrackId) : null;
  const bpmFor = (id: DeckId) => {
    const trackId = state.decks[id].trackId;
    const reviewed = trackId ? demoCueSets[trackId]?.reviewedPulseGrid?.bpm : null;
    if (reviewed) return `${reviewed} BPM · reviewed pulse`;
    const estimated = trackId ? (analyses[trackId] || engine.getTrackAnalysis(trackId))?.estimatedTempo?.bpm : null;
    return estimated ? `~${estimated} BPM · estimated` : 'BPM unknown';
  };
  const activeDeck: DeckId | null = state.transition?.from || (state.decks.A.status === 'playing' ? 'A' : state.decks.B.status === 'playing' ? 'B' : null);
  const bpmLine = state.transition ? `A ${bpmFor('A')} / B ${bpmFor('B')}` : activeDeck ? `Deck ${activeDeck} · ${bpmFor(activeDeck)}` : 'BPM unknown';
  const autopilotLine = autopilot.mode === 'running' && autopilot.phase === 'ready' && nextAutopilotTrack && autopilot.secondsUntilNext !== null
    ? `Playing ${currentTrack('A')?.title && state.decks.A.status === 'playing' ? currentTrack('A')?.title : currentTrack('B')?.title || 'now'}. Next: ${nextAutopilotTrack.title} in ${Math.round(autopilot.secondsUntilNext)}s.`
    : autopilot.line;
  const submit = (event: FormEvent) => { event.preventDefault(); const trimmed = text.trim(); if (!trimmed || busy || !agentReady) return; onSubmit(trimmed); setText(''); };
  const importFiles = (files: FileList | null) => { if (files?.length) onImport(Array.from(files)); };
  const unlock = async () => { try { await engine.unlock(); setUnlockError(''); } catch (error) { setUnlockError(error instanceof Error ? error.message : 'Audio could not start. Try again.'); } };
  return <main className="dj-app performance-app">
    <div className="performance-stage" aria-label="DJ performance">
      <VideoStage engine={engine} resetKey={videoResetKey} />
      <div className="stage-shade" aria-hidden="true" />
      <header className="stage-header">
        <div className="stage-identity"><strong>Cheechee</strong><span className="stage-live"><i aria-hidden="true" />{state.decks.A.status === 'playing' || state.decks.B.status === 'playing' ? 'Live mix' : 'Ready to mix'}</span><span className="stage-bpm">{bpmLine}</span></div>
        <div className="stage-actions-top"><span className={`connection-state ${agentReady ? 'online' : ''}`}><span className="status-dot" />{agentReady ? 'Agent online' : !connected ? 'Agent disconnected' : 'Agent unavailable'}</span><button type="button" className="stop-all" onClick={onStopAll}>■ <span>Stop all audio</span></button></div>
      </header>
      {!state.unlocked && <div className="audio-gate stage-audio-gate"><div><strong>Sound is off</strong><span>Enable audio to play and mix tracks in this browser.</span></div><button onClick={() => void unlock()}>Enable audio</button>{unlockError && <p role="alert">{unlockError}</p>}</div>}
      <aside className="actions-panel stage-actions" aria-label="Actions"><div className="activity-heading"><strong>Actions</strong><span>{busy ? 'Agent working…' : activities.length ? 'Live command log' : 'Actions appear here'}</span></div><div className="activity-feed" aria-live="polite">{activities.length === 0 ? <p className="empty-copy">Play a track or ask the DJ to begin. Agent actions and results appear here.</p> : activities.slice(-12).reverse().map(item => <div className={`activity-item activity-${item.kind}`} key={item.id}><span className="activity-symbol" aria-hidden="true">{item.kind === 'tool' ? '⌘' : item.kind === 'error' ? '!' : item.kind === 'user' ? '›' : '•'}</span><div><div className="activity-main"><span>{item.text}</span>{item.status && <small className={`activity-status status-${item.status}`}>{item.status}</small>}</div>{item.detail && <details><summary>{item.kind === 'tool' ? 'Tool details' : 'Details'}</summary><pre>{item.detail}</pre></details>}</div><time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time></div>)}</div></aside>
      <div className="stage-bottom">
        <section className="now-playing" aria-label="Now playing"><div className="now-heading"><strong>Now playing</strong><span>{state.transition ? `${state.transition.style} · ${Math.round(state.transition.progress * 100)}%` : 'Two live decks'}</span></div><div className="now-decks">{(['A', 'B'] as const).map(id => { const deck = state.decks[id]; const track = currentTrack(id); return <div className={`now-deck now-deck-${id.toLowerCase()}`} key={id}><span className="now-id">{id}</span><div className="now-track"><strong>{track?.title || 'No track loaded'}</strong><span>{track?.artist || 'Standby'}</span></div><span className="now-status">{deck.status === 'playing' ? 'On air' : deck.status}</span><span className="now-time">{fmt(deck.position)} / {fmt(deck.duration)}</span></div>; })}</div></section>
        <section className="performance-mixer" aria-label="Performance mixer" onPointerDownCapture={onManualIntent} onKeyDownCapture={onManualIntent}>
          <PerformanceDeck id="A" deck={state.decks.A} track={currentTrack('A')} engine={engine} onCommand={onCommand} />
          <div className="performance-master"><label><span>Crossfader</span><input aria-label="Performance crossfader" type="range" min="0" max="1" step="0.01" value={state.crossfader} onChange={event => engine.setCrossfader(Number(event.target.value))} /><output>A {Math.round(state.crossfader * 100)} B</output></label><label><span>Master</span><input aria-label="Performance master volume" type="range" min="0" max="1" step="0.01" value={state.masterVolume} onChange={event => engine.setMasterVolume(Number(event.target.value))} /><output>{Math.round(state.masterVolume * 100)}%</output></label></div>
          <PerformanceDeck id="B" deck={state.decks.B} track={currentTrack('B')} engine={engine} onCommand={onCommand} />
        </section>
      </div>
    </div>
    <section className="library" aria-label="Track library"><div className="section-title"><div><strong>Library</strong><span>{tracks.length} tracks · local to this session</span></div><div className="library-actions"><button type="button" disabled={analyzing || autopilot.mode === 'running' || !tracks.length} onClick={onAnalyze}>{analyzing ? 'Analyzing…' : 'Analyze tracks'}</button><button onClick={() => fileInput.current?.click()}>＋ Import audio</button></div><input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={e => { importFiles(e.target.files); e.target.value = ''; }} /></div><div className="library-peek">{tracks.map(track => <span key={track.id}>{track.title}</span>)}</div><details className="library-drawer"><summary>Browse library</summary><div className="library-list" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onImport(Array.from(e.dataTransfer.files)); }}>{tracks.length === 0 ? <p className="empty-copy">Drop audio files here to build your library.</p> : tracks.map((track, index) => <div className="library-row" key={track.id}><span className="track-index">{String(index + 1).padStart(2,'0')}</span><div><strong>{track.title}</strong><span>{track.artist}{analyses[track.id]?.estimatedTempo ? ` · ~${analyses[track.id]?.estimatedTempo?.bpm} BPM estimated` : ''}</span></div><span className="track-tags">{track.tags.slice(0,2).join(' / ')}</span><span className="track-energy">{track.energy}</span></div>)}</div><p className="drop-hint">Drop audio files here, up to 25 MB each.</p></details></section>
    <details className="advanced-controls"><summary>Advanced controls <span>Decks, EQ, filter, mixer and transitions</span></summary><div className="mixing-surface" onPointerDownCapture={onManualIntent} onKeyDownCapture={onManualIntent} onChangeCapture={onManualIntent}><Deck id="A" deck={state.decks.A} track={currentTrack('A')} tracks={tracks} engine={engine} onCommand={onCommand} />
      <section className="mixer" aria-label="Mixer"><div className="mixer-heading">MIXER<span>2 CHANNEL</span></div><div className="mixer-fader"><div className="mixer-pips" aria-hidden="true"><span>A</span><span>B</span></div><label htmlFor="crossfader">Crossfader</label><input id="crossfader" type="range" min="0" max="1" step="0.01" value={state.crossfader} onChange={e => engine.setCrossfader(Number(e.target.value))} /><div className="fader-values"><span>A</span><span>Center</span><span>B</span></div></div><label className="master-control"><span>Master output</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={state.masterVolume} onChange={e => engine.setMasterVolume(Number(e.target.value))} /><output>{Math.round(state.masterVolume * 100)}%</output></label><div className="mixer-divider" />
        <div className="transition-panel"><div className="panel-heading"><strong>Next move</strong><span>{state.transition ? `${state.transition.style} in progress` : 'Preset transition'}</span></div><select aria-label="Next track" value={nextTrack} onChange={e => setTransitionTrack(e.target.value)}>{tracks.length === 0 && <option value="">No tracks</option>}{tracks.map(t => <option key={t.id} value={t.id}>{t.title} · {t.artist}</option>)}</select><div className="style-grid">{(['crossfade','filter','echo'] as const).map(choice => <button key={choice} aria-pressed={style === choice} className={style === choice ? 'selected' : ''} onClick={() => setStyle(choice)}>{choice === 'crossfade' ? 'Crossfade' : choice === 'filter' ? 'Filter sweep' : 'Echo out'}</button>)}</div><label className="duration-line">Duration <select aria-label="Transition duration" value={duration} onChange={e => setDuration(Number(e.target.value))}><option value={2}>2 sec</option><option value={4}>4 sec</option><option value={8}>8 sec</option><option value={12}>12 sec</option></select></label><button className="transition-go" disabled={!nextTrack || !!state.transition} onClick={() => void onCommand({type:'transition',track_id:nextTrack,style,duration_seconds:duration})}>Start transition <span aria-hidden="true">↗</span></button>{state.transition && <div className="transition-progress"><div style={{width:`${state.transition.progress * 100}%`}} /></div>}</div></section>
      <Deck id="B" deck={state.decks.B} track={currentTrack('B')} tracks={tracks} engine={engine} onCommand={onCommand} /></div></details>
    <section className="input-strip" aria-label="DJ controls"><div className="input-strip-top"><div className="autopilot-control"><div className="autopilot-top"><strong>Autopilot</strong><button type="button" role="switch" aria-label="Autopilot" aria-checked={autopilot.mode === 'running'} disabled={analyzing || busy} onClick={onAutopilotToggle}>{autopilot.mode === 'running' ? 'On' : 'Off'}</button></div><label>Time between changes<select aria-label="Time between changes" value={autopilot.changeIntervalSeconds} onChange={e => onChangeInterval(Number(e.target.value))}><option value={20}>About 20 seconds</option><option value={60}>About 60 seconds</option><option value={120}>About 120 seconds</option></select></label><label>Set objective<input aria-label="Set objective" maxLength={500} value={objective} onChange={e => setObjective(e.target.value)} onBlur={() => onObjectiveChange(objective)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label><p role="status">{autopilotLine}</p></div><section className="assistant-input" aria-label="DJ assistant"><div className="section-title"><div><strong>Direct the mix</strong><span>{busy ? 'Working on your request…' : agentReady ? 'Tell the DJ what to do next' : connected ? 'Set NEBIUS_API_KEY and NEBIUS_MODEL in .env to enable the agent' : 'Agent server disconnected. Manual controls still work.'}</span></div>{speechToggle}</div><div className="example-chips">{examples.map(example => <button key={example} disabled={busy || !agentReady} onClick={() => { onSubmit(example); setText(''); }}>{example}</button>)}</div><form className="command-form" onSubmit={submit}><input aria-label="DJ command" value={text} onChange={e => { onManualIntent(); setText(e.target.value); }} placeholder={agentReady ? 'Ask for a track, change the sound, or cue a transition…' : 'Agent unavailable. Manual controls still work.'} disabled={busy || !agentReady} /><button type="submit" disabled={busy || !agentReady || !text.trim()}>{busy ? 'Working' : 'Send'} <span aria-hidden="true">↗</span></button></form>{voiceControls}</section></div></section>
  </main>;
}
