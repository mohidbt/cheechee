# Cheechee video performance view

Date: 2026-09-23. Baseline committed as a3338fc. Build this slice without another commit or push unless requested.

## Product decision

Make the filmed DJ the main view. Existing audio, agent, Autopilot, pace, voice, analysis, and cancellation behavior remain functional. Video illustrates actual execution; it never controls or delays audio. Keep the demo fast to build with native muted HTML video and the existing React stack. No rendering framework or streaming service.

## Layout and visual direction

The video fills the main stage. Keep the DJ's helmet, hands, and decks visible with aspect-aware sizing. Use a quiet translucent control layer drawn from the footage: ink #171a22, slate #303746, warm paper #ede9df, violet #ab91bc, and signal blue #91b9c6. Use the existing local font stack rather than adding a network font. Strong normal-weight labels, tabular numbers for BPM, clear keyboard focus. Avoid a dashboard of cards or a large introductory header.

```text
+-----------------------------------------------------------+
| Cheechee / live state / BPM             Actions widget     |
|                                        agent explanation  |
|                 DJ video               tool / result      |
|                                        expandable details |
|                                                           |
|       deck A controls / crossfader / deck B controls        |
+-----------------------------------------------------------+
| Autopilot / pace / objective / library / text / mic / stop  |
+-----------------------------------------------------------+
```

Main stage dominates a normal laptop viewport. Actions is a bounded, independently scrolling right-side widget, not another full page. Bottom mixer uses actual controls: per-deck low/mid/high EQ knobs, gain, crossfader and master level. Implement knobs with accessible range inputs, keyboard support and visible values, not pointer-only canvas controls. Keep enable audio and Stop all prominent. Library/import/analysis and existing advanced controls stay reachable in a compact drawer/details area. On mobile stack or collapse Actions and controls without horizontal overflow. Inputs remain at the bottom of the app.

BPM is read-only: active track's reviewed pulse BPM, otherwise estimated BPM explicitly marked approximate, otherwise unknown. During transitions display source/target BPM or a clearly identified active deck. Never use manifest baseBpm=120 as measured song tempo. There is no tempo adjustment or beatmatching tool in this slice.

## Assets inspected

Source: /Users/mohidbutt/Downloads/clips/manifest.json and the actual MP4 inventory. Contact sheets for idle_hype and crossfade_to_b were visually inspected. The source directory contains 22 MP4 files. Manifest top-level placeholder counts are stale; use per-file existence plus per-entry real flag. idle.mp4 is absent despite real:true. User explicitly selected idle_hype.mp4 as the idle loop.

Copy only mapped clips into public/video/ for a self-contained local app. Preserve originals in Downloads. Probe real codec, dimensions and duration rather than trusting manifest durations. All performance videos are muted and playsInline. No clip soundtrack may compete with Tone.js. Keep an explicit small mapping module and attribution/source note. Do not preload every large clip; preload idle and the next selected action at most. No remote dependencies or absolute filesystem URLs in the browser.

## Clip mapping

These mappings are inferred from filenames, manifest groups, and existing audio actions. Playback is triggered by successful commands or actual audio lifecycle/state changes, not a model request that may fail.

| Available clip | Trigger or disposition |
| --- | --- |
| idle_hype | Default looping idle, including between actions; explicit Stop all immediately returns here |
| load_a, load_b | Successful load into an empty deck |
| swap_a, swap_b | Successful replacement of a loaded, nonplaying deck |
| start_a, start_b | Actual deck playback start at file beginning |
| needle_drop_a, needle_drop_b | Actual playback start at a nonzero cue offset; transition clip takes priority if part of a transition |
| crossfade_to_a, crossfade_to_b | Actual transition_started toward that deck, including autonomous and fallback transitions; also meaningful manual crossfader movement |
| fader_up_a, fader_up_b | Manual deck gain increase; debounce continuous movement |
| fader_down_a, fader_down_b | Successful stop of a deck or manual gain decrease; Stop all overrides with idle |
| eq_low | Low-band EQ action; also generic knob-motion fallback for set_filter because filter_sweep is absent |
| eq_mid | Mid-band EQ action; generic knob-motion fallback for high-band EQ because eq_high is absent |
| cue_headphones | Accepted manual next-cue preparation if a real event hook is readily available; otherwise reserved, not inferred from LLM thinking |
| beatmatch_b, pitch_b | Present but reserved: corresponding audio tools do not exist; do not imply those DSP operations happened |
| drink_toss, middle_fingers | Present but reserved for future explicit performance gestures; no unrelated automatic trigger |

Unavailable placeholders: eq_high, filter_sweep, beatmatch_a, pitch_a, scratch, spinback, build, drop, point_crowd, clap_overhead, shake_no, shrug, heart_hands, air_horn, crate_browse, phone_check, visor_wipe, stretch, air_drums, lean_back, helmet_knock, record_wipe, fist_pump. Do not request these URLs. get_dj_state has no performance animation.

## Execution and playback rules

1. Subscribe to canonical browser audio state/lifecycle, or successful bridge/manual results. Cover model commands, local controls, Autopilot, and fallback through one shared mechanism. Do not parse human-readable Actions text.
2. Start the action clip when execution actually begins. A prepared or scheduled transition does not animate as already playing. A failed command triggers no success clip. Do not add a second audio action to drive visuals.
3. Transition-start visuals outrank simultaneous incoming-start/load visuals, so one transition does not produce a backlog of unrelated clips. Per-deck identity follows the actual engine, not an assumed A-to-B alternation.
4. Use a bounded latest-action policy, not a FIFO queue of five-to-ten-second clips. Deduplicate lifecycle IDs and coalesce knob drags. New meaningful actions may interrupt the previous action clip. Never delay tools until a video ends.
5. Action clips play once then return to idle_hype. Do not claim a five-second video frame-exactly matches a one-to-twelve-second fade. Keep real fade progress in the controls/trace. Stop all cancels pending visual work and selects idle immediately.
6. Keep the previous decoded frame/video visible while a selected clip loads, using two video layers if needed; switch only when ready. Reject late canplay/ended events from superseded clips. On media error recover to idle without breaking audio or exposing an unhandled play rejection.
7. Muted idle may autoplay. The normal Enable audio gesture remains necessary for sound. Provide a graceful poster/fallback if video cannot start. Respect reduced motion with an optional pause of ambient video while preserving control access.

## Ownership and implementation

- Sol video owner: src/video/* mapping, native video component, audio-event/state adapter, media copy/probe, focused mapping/playback tests. Do not edit audio engine behavior, App, or shared audio contracts without coordination.
- Sol UI integrator: src/ui/Console.tsx, console.css, minimal App wiring and README. Reuse the video owner's component and current Actions/status. Preserve command routing, manual busy guard, pace and Stop all. Read frontend-design skill.
- Root: plan, interface coordination, visual review. No new backend feature or new agent tool needed.

Proposed boundary: a VideoStage component taking engine: AudioEngine and rendering the native video layers. It can subscribe directly to engine state/lifecycle. Optional explicit reset signal for Stop all is passed from App only if engine state cannot disambiguate it. Export pure action-selection helpers for tests. UI owns layout, BPM label and mixer controls. Agree the exact component interface before concurrent edits.

## Acceptance for the quick demo

- Existing build/typecheck and relevant unit tests pass.
- Chrome shows idle_hype playing muted at load, actual start/transition/EQ selects the mapped available clip, then returns to idle; failure does not animate success.
- Both transition directions map correctly, including autonomous/fallback audio events. A later action wins over stale load/ended callbacks; Stop all prevents a queued clip from appearing later.
- Main controls still change real audio state; video never changes audio timing. BPM uses reviewed/estimated/unknown data correctly.
- Screenshot review at laptop and mobile widths confirms video prominence, legible right traces, bottom inputs, accessible controls and no horizontal overflow.
- Keep validation bounded: deterministic browser fixtures suffice, no new ten-minute provider soak. Report media/timing limits honestly. No commit of the video feature until asked.
