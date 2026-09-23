import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AudioEngine, AudioTrack, Command, DeckId, DeckState, DJState, ServiceStatus } from '../../shared/contracts';
import './console.css';

export type Activity = {
  id: string;
  kind: 'user' | 'tool' | 'assistant' | 'error' | 'system';
  text: string;
  detail?: string;
  status?: 'requested' | 'scheduled' | 'completed' | 'failed';
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
  onCommand: (command: Command) => Promise<void>;
  onSubmit: (text: string) => void;
  onStopAll: () => void;
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

function EQControl({ deck, band, value, state, onCommand }: { deck: DeckId; band: 'low' | 'mid' | 'high'; value: number; state: DeckState; onCommand: ConsoleProps['onCommand'] }) {
  const [draft, setDraft] = useState(value);
  const lastSent = useRef(value);
  useEffect(() => { setDraft(value); lastSent.current = value; }, [value]);
  const commit = () => {
    if (draft === lastSent.current) return;
    lastSent.current = draft;
    void onCommand({ type: 'set_eq', deck, low_db: band === 'low' ? draft : state.eq.low, mid_db: band === 'mid' ? draft : state.eq.mid, high_db: band === 'high' ? draft : state.eq.high });
  };
  return <label className="eq-control"><span>{band}</span><input aria-label={`Deck ${deck} ${band} EQ`} type="range" min="-24" max="6" step="1" value={draft} onChange={e => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /><output>{draft > 0 ? '+' : ''}{draft}</output></label>;
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

export function Console({ state, tracks, engine, connected, services, busy, activities, onCommand, onSubmit, onStopAll, onImport, voiceControls, speechToggle }: ConsoleProps) {
  const [text, setText] = useState('');
  const [style, setStyle] = useState<'crossfade' | 'filter' | 'echo'>('crossfade');
  const [duration, setDuration] = useState(4);
  const [transitionTrack, setTransitionTrack] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const currentTrack = (id: DeckId) => tracks.find(t => t.id === state.decks[id].trackId);
  const nextTrack = transitionTrack && tracks.some(t => t.id === transitionTrack) ? transitionTrack : (tracks.find(t => t.id !== state.decks.A.trackId && t.id !== state.decks.B.trackId)?.id || tracks[0]?.id || '');
  const agentReady = connected && services?.agent === true;
  const submit = (event: FormEvent) => { event.preventDefault(); const trimmed = text.trim(); if (!trimmed || busy || !agentReady) return; onSubmit(trimmed); setText(''); };
  const importFiles = (files: FileList | null) => { if (files?.length) onImport(Array.from(files)); };
  const unlock = async () => { try { await engine.unlock(); setUnlockError(''); } catch (error) { setUnlockError(error instanceof Error ? error.message : 'Audio could not start. Try again.'); } };
  return <main className="dj-app">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true"><i/><i/><i/><i/></span><div><strong>CHEECHEE</strong><span>AI DJ console</span></div></div><div className="header-actions"><span className={`connection-state ${agentReady ? 'online' : ''}`}><span className="status-dot" />{agentReady ? `Agent online${services?.model ? ` · ${services.model}` : ''}` : !connected ? 'Agent disconnected' : 'Agent unavailable'}</span><button className="stop-all" onClick={onStopAll}>■ <span>Stop all audio</span></button></div></header>
    {!state.unlocked && <div className="audio-gate"><div><strong>Sound is off</strong><span>Enable audio to play and mix tracks in this browser.</span></div><button onClick={() => void unlock()}>Enable audio</button>{unlockError && <p role="alert">{unlockError}</p>}</div>}
    <div className="console-shell compact-shell">
      <div className="primary-grid">
        <section className="agent-area" aria-label="DJ assistant"><div className="section-title"><div><strong>Direct the mix</strong><span>{busy ? 'Working on your request…' : agentReady ? 'Tell the DJ what to do next' : connected ? 'To enable the agent, set NEBIUS_API_KEY and NEBIUS_MODEL in .env' : 'Agent server disconnected. Manual controls still work.'}</span></div>{speechToggle}</div><div className="example-chips">{examples.map(example => <button key={example} disabled={busy || !agentReady} onClick={() => { onSubmit(example); setText(''); }}>{example}</button>)}</div><form className="command-form" onSubmit={submit}><input aria-label="DJ command" value={text} onChange={e => setText(e.target.value)} placeholder={agentReady ? 'Ask for a track, change the sound, or cue a transition…' : 'Agent unavailable. Manual controls still work.'} disabled={busy || !agentReady} /><button type="submit" disabled={busy || !agentReady || !text.trim()}>{busy ? 'Working' : 'Send'} <span aria-hidden="true">↗</span></button></form>{voiceControls}</section>
        <aside className="actions-panel" aria-label="Actions"><div className="activity-heading"><strong>Actions</strong><span>{busy ? 'Agent working…' : activities.length ? 'Live command log' : 'Actions appear here'}</span></div><div className="activity-feed" aria-live="polite">{activities.length === 0 ? <p className="empty-copy">Play a track manually or ask the DJ to begin. Agent actions and their results will appear here.</p> : activities.slice(-12).reverse().map(item => <div className={`activity-item activity-${item.kind}`} key={item.id}><span className="activity-symbol" aria-hidden="true">{item.kind === 'tool' ? '⌘' : item.kind === 'error' ? '!' : item.kind === 'user' ? '›' : '•'}</span><div><div className="activity-main"><span>{item.text}</span>{item.status && <small className={`activity-status status-${item.status}`}>{item.status}</small>}</div>{item.detail && <details><summary>Tool details</summary><pre>{item.detail}</pre></details>}</div><time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time></div>)}</div></aside>
      </div>
      <section className="now-playing" aria-label="Now playing"><div className="now-heading"><strong>Now playing</strong><span>Two decks · local audio</span></div><div className="now-decks">{(['A', 'B'] as const).map(id => { const deck = state.decks[id]; const track = currentTrack(id); return <div className={`now-deck now-deck-${id.toLowerCase()}`} key={id}><span className="now-id">{id}</span><div className="now-track"><strong>{track?.title || 'No track loaded'}</strong><span>{track?.artist || 'Standby'}</span></div><span className="now-status">{deck.status === 'playing' ? 'On air' : deck.status}</span><span className="now-time">{fmt(deck.position)} / {fmt(deck.duration)}</span></div>; })}</div></section>
      <section className="library" aria-label="Track library"><div className="section-title"><div><strong>Library</strong><span>{tracks.length} tracks · local to this session</span></div><button onClick={() => fileInput.current?.click()}>＋ Import audio</button><input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={e => { importFiles(e.target.files); e.target.value = ''; }} /></div><div className="library-list" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onImport(Array.from(e.dataTransfer.files)); }}>{tracks.length === 0 ? <p className="empty-copy">Drop audio files here to build your library.</p> : tracks.map((track, index) => <div className="library-row" key={track.id}><span className="track-index">{String(index + 1).padStart(2,'0')}</span><div><strong>{track.title}</strong><span>{track.artist}</span></div><span className="track-tags">{track.tags.slice(0,2).join(' / ')}</span><span className="track-energy">{track.energy}</span></div>)}</div><p className="drop-hint">Drop audio files here, up to 25 MB each.</p></section>
      <details className="advanced-controls"><summary>Advanced controls <span>Decks, EQ, filter, mixer and transitions</span></summary><div className="mixing-surface"><Deck id="A" deck={state.decks.A} track={currentTrack('A')} tracks={tracks} engine={engine} onCommand={onCommand} />
      <section className="mixer" aria-label="Mixer"><div className="mixer-heading">MIXER<span>2 CHANNEL</span></div><div className="mixer-fader"><div className="mixer-pips" aria-hidden="true"><span>A</span><span>B</span></div><label htmlFor="crossfader">Crossfader</label><input id="crossfader" type="range" min="0" max="1" step="0.01" value={state.crossfader} onChange={e => engine.setCrossfader(Number(e.target.value))} /><div className="fader-values"><span>A</span><span>Center</span><span>B</span></div></div><label className="master-control"><span>Master output</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={state.masterVolume} onChange={e => engine.setMasterVolume(Number(e.target.value))} /><output>{Math.round(state.masterVolume * 100)}%</output></label><div className="mixer-divider" />
        <div className="transition-panel"><div className="panel-heading"><strong>Next move</strong><span>{state.transition ? `${state.transition.style} in progress` : 'Preset transition'}</span></div><select aria-label="Next track" value={nextTrack} onChange={e => setTransitionTrack(e.target.value)}>{tracks.length === 0 && <option value="">No tracks</option>}{tracks.map(t => <option key={t.id} value={t.id}>{t.title} · {t.artist}</option>)}</select><div className="style-grid">{(['crossfade','filter','echo'] as const).map(choice => <button key={choice} aria-pressed={style === choice} className={style === choice ? 'selected' : ''} onClick={() => setStyle(choice)}>{choice === 'crossfade' ? 'Crossfade' : choice === 'filter' ? 'Filter sweep' : 'Echo out'}</button>)}</div><label className="duration-line">Duration <select aria-label="Transition duration" value={duration} onChange={e => setDuration(Number(e.target.value))}><option value={2}>2 sec</option><option value={4}>4 sec</option><option value={8}>8 sec</option><option value={12}>12 sec</option></select></label><button className="transition-go" disabled={!nextTrack || !!state.transition} onClick={() => void onCommand({type:'transition',track_id:nextTrack,style,duration_seconds:duration})}>Start transition <span aria-hidden="true">↗</span></button>{state.transition && <div className="transition-progress"><div style={{width:`${state.transition.progress * 100}%`}} /></div>}</div></section>
      <Deck id="B" deck={state.decks.B} track={currentTrack('B')} tracks={tracks} engine={engine} onCommand={onCommand} /></div></details>
    </div>
    <footer className="app-footer"><span>CHEECHEE / LOCAL SESSION</span><span>Use headphones for voice control</span></footer>
  </main>;
}
