import { useEffect, useRef, useState } from 'react';
import type { AudioEngine, DeckId, DJState } from '../../shared/contracts';
import { clipForLifecycle, clipForLoad, clipForMixerChange, hasPlayingDeck, IDLE_CLIP, idleClipForState, QUIET_IDLE_CLIP, videoUrl, type VideoClipId } from './clips';
import './video-stage.css';

type Slot = { clip: VideoClipId; token: number } | null;
export type VideoStageProps = { engine: AudioEngine; resetKey?: number };

/** The video follows audio execution; it never schedules or changes audio. */
export function VideoStage({ engine, resetKey }: VideoStageProps) {
  const [slots, setSlots] = useState<[Slot, Slot]>([null, null]);
  const [visible, setVisible] = useState<{slot: 0 | 1; token: number} | null>(null);
  const [failed, setFailed] = useState(false);
  const [idleClip, setIdleClip] = useState(() => idleClipForState(engine.getState()));
  const idleClipRef = useRef(idleClip);
  const [reducedMotion, setReducedMotion] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const idleRefs = useRef<Record<typeof QUIET_IDLE_CLIP | typeof IDLE_CLIP, HTMLVideoElement | null>>({idle: null, idle_hype: null});
  const actionRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const sequence = useRef(0);
  const pending = useRef<{slot: 0 | 1; token: number} | null>(null);
  const visibleRef = useRef<{slot: 0 | 1; token: number} | null>(null);
  const knobTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<string>());
  const activating = useRef(new Set<number>());

  function clearKnob() {
    if (knobTimer.current) clearTimeout(knobTimer.current);
    knobTimer.current = null;
  }

  function setIdleMode(state: DJState) {
    const next = idleClipForState(state);
    if (idleClipRef.current !== next) { idleClipRef.current = next; setIdleClip(next); }
  }

  function showIdle() {
    sequence.current++;
    clearKnob();
    pending.current = null;
    visibleRef.current = null;
    actionRefs.current.forEach(video => video?.pause());
    setSlots([null, null]);
    setVisible(null);
    if (!reducedMotionRef.current) void idleRefs.current[idleClipRef.current as typeof QUIET_IDLE_CLIP | typeof IDLE_CLIP]?.play().catch(() => setFailed(true));
  }

  function requestClip(clip: VideoClipId) {
    if (clip === IDLE_CLIP || clip === QUIET_IDLE_CLIP) { showIdle(); return; }
    const state = engine.getState();
    setIdleMode(state);
    if (!hasPlayingDeck(state)) return;
    clearKnob();
    const slot: 0 | 1 = visibleRef.current?.slot === 0 ? 1 : 0;
    const token = ++sequence.current;
    pending.current = {slot, token};
    setSlots(current => {
      const next: [Slot, Slot] = [...current];
      next[slot] = {clip, token};
      return next;
    });
    setFailed(false);
  }

  function queueMixerClip(clip: VideoClipId) {
    clearKnob();
    knobTimer.current = setTimeout(() => requestClip(clip), 140);
  }

  async function activate(slot: 0 | 1, token: number) {
    const expected = pending.current;
    const video = actionRefs.current[slot];
    if (!expected || expected.slot !== slot || expected.token !== token || !video || activating.current.has(token)) return;
    activating.current.add(token);
    try {
      video.currentTime = 0;
      await video.play();
      if (pending.current?.token !== token) { video.pause(); return; }
      const old = visibleRef.current;
      pending.current = null;
      visibleRef.current = {slot, token};
      setVisible({slot, token});
      idleRefs.current[idleClipRef.current as typeof QUIET_IDLE_CLIP | typeof IDLE_CLIP]?.pause();
      if (old && old.slot !== slot) {
        actionRefs.current[old.slot]?.pause();
        setSlots(current => {
          const next: [Slot, Slot] = [...current];
          next[old.slot] = null;
          return next;
        });
      }
    } catch {
      if (pending.current?.token === token) { pending.current = null; if (!visibleRef.current) showIdle(); setFailed(true); }
    } finally { activating.current.delete(token); }
  }

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    const active = idleRefs.current[idleClip as typeof QUIET_IDLE_CLIP | typeof IDLE_CLIP];
    const other = idleRefs.current[idleClip === QUIET_IDLE_CLIP ? IDLE_CLIP : QUIET_IDLE_CLIP];
    other?.pause();
    if (reducedMotion || visibleRef.current) active?.pause();
    else void active?.play().catch(() => setFailed(true));
  }, [idleClip, reducedMotion]);

  useEffect(() => {
    let previous = engine.getState();
    let mixerAnchor = previous;
    const loadingOrigins: Partial<Record<DeckId, string | null>> = {};
    const stateUnsubscribe = engine.subscribe(() => {
      const next = engine.getState();
      const wasPlaying = hasPlayingDeck(previous);
      const isPlaying = hasPlayingDeck(next);
      setIdleMode(next);
      if (wasPlaying && !isPlaying) showIdle();
      if (next.transition || previous.transition) {
        clearKnob();
        mixerAnchor = next;
      } else {
        for (const deck of ['A', 'B'] as const) {
          const before = previous.decks[deck], after = next.decks[deck];
          if (before.status !== 'loading' && after.status === 'loading') loadingOrigins[deck] = before.trackId;
          if (before.status === 'loading' && after.status === 'ready' && after.trackId && after.trackId !== loadingOrigins[deck]) {
            requestClip(clipForLoad(deck, loadingOrigins[deck] !== null && loadingOrigins[deck] !== undefined));
          }
          if (after.status !== 'loading') delete loadingOrigins[deck];
        }
        const mixerClip = clipForMixerChange(mixerAnchor, next);
        if (mixerClip) { mixerAnchor = next; queueMixerClip(mixerClip); }
      }
      previous = next;
    });
    const lifecycleUnsubscribe = engine.subscribeLifecycle(event => {
      if (event.type === 'ended' && event.reason === 'stop_all') { idleClipRef.current = QUIET_IDLE_CLIP; setIdleClip(QUIET_IDLE_CLIP); showIdle(); return; }
      if (event.type === 'started' || event.type === 'transition_started' || event.type === 'ended') {
        const key = 'transitionId' in event ? `${event.type}:${event.transitionId}` : `${event.type}:${event.playbackId}:${event.type === 'ended' ? event.reason : ''}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > 80) seen.current.delete(seen.current.values().next().value!);
      }
      const state = engine.getState();
      if (event.type === 'started') mixerAnchor = state;
      const clip = clipForLifecycle(event, state);
      if (clip) requestClip(clip);
    });
    return () => { stateUnsubscribe(); lifecycleUnsubscribe(); clearKnob(); };
  }, [engine]);

  useEffect(() => { if (resetKey !== undefined) showIdle(); }, [resetKey]);

  return <div className="video-stage" aria-label="DJ performance video" data-active-clip={visible ? slots[visible.slot]?.clip : idleClip} data-pending-clip={pending.current ? slots[pending.current.slot]?.clip : undefined}>
    <img className="video-stage-poster" src="/video/idle-poster.jpg" alt="Cheechee DJ at the decks" />
    <video ref={element => { idleRefs.current.idle = element; }} className={`video-stage-media video-stage-idle${idleClip === QUIET_IDLE_CLIP ? ' is-active' : ''}`} src={videoUrl(QUIET_IDLE_CLIP)} muted playsInline loop autoPlay={!reducedMotion && idleClip === QUIET_IDLE_CLIP} preload="auto" aria-hidden="true" onError={() => setFailed(true)} />
    <video ref={element => { idleRefs.current.idle_hype = element; }} className={`video-stage-media video-stage-idle${idleClip === IDLE_CLIP ? ' is-active' : ''}`} src={videoUrl(IDLE_CLIP)} muted playsInline loop autoPlay={!reducedMotion && idleClip === IDLE_CLIP} preload="auto" aria-hidden="true" onError={() => setFailed(true)} />
    {slots.map((item, index) => item && <video key={`${index}:${item.token}`} ref={element => { actionRefs.current[index as 0 | 1] = element; }} className={`video-stage-media video-stage-action${visible?.slot === index && visible.token === item.token ? ' is-visible' : ''}`} src={videoUrl(item.clip)} muted playsInline preload="auto" aria-hidden="true" onCanPlay={() => void activate(index as 0 | 1, item.token)} onEnded={() => { if (visibleRef.current?.token === item.token && !pending.current) showIdle(); }} onError={() => { if (pending.current?.token === item.token) { showIdle(); setFailed(true); } else if (visibleRef.current?.token === item.token) { if (!pending.current) showIdle(); setFailed(true); } }} />)}
    {failed && <span className="video-stage-fallback">Performance video unavailable</span>}
  </div>;
}
