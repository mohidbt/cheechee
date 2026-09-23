# Cheechee autonomy implementation plan

Date: 2026-09-23. Status: Release 1 implemented and its ten-minute live soak passed. Release 2 cue timing and local analysis slice implemented in the worktree; the EQ embellishment and semantic section work remain out of scope.

This is the next-stage plan after the shipped MVP. It supersedes the original PLAN.md exclusions for autonomous playback only. The existing voice/manual path remains supported. Research: three Luna-high agents examined analysis tooling, audio scheduling, and the agent harness; the coordinator made the decisions below.

## 1. Decisions

1. Keep React, Tone.js, the Node WebSocket server, LangChain createAgent, and Nebius inference. No Deep Agents, custom LangGraph graph, hosted agent migration, queue service, or database for the first release.
2. A browser-owned Autopilot controller supervises playback. The server requests decisions; it does not own the audio clock or decide whether an old plan is still valid.
3. Ship reliable autonomous track selection and transitions first. Song analysis is not a prerequisite.
4. Model decisions happen on events and ahead of deadlines. Continuous audio control and fallback behavior are deterministic local code.
5. Reuse the Actions panel. Show real triggers, a short model-provided explanation, arguments, execution status, elapsed times, and fallback reasons. Do not fabricate explanations or expose hidden chain of thought.
6. Preserve the compact UI: one Autopilot toggle, one concise objective field, and a next-move/status line. Manual controls stay collapsed.
7. Release 1 supports an open, active browser with a running audio context. Laptop sleep, a closed page, and an interrupted audio device are outside continuous-playback guarantees.

## 2. What exists and what must change

| Existing component | Reuse | Required change |
| --- | --- | --- |
| shared/contracts.ts | Deck positions, duration, EQ/filter, transition, command schemas | Playback instance identity, monotonic played time, autoplay requests/decisions and acknowledgements |
| src/audio/engine.ts | Buffer cache, two decks, three transition presets, audio-clock ramps | Prepare separately from execute; explicit ended events; reconcile completion from audio time; safe cancellation |
| src/bridge.ts | Request IDs, ordered execution, acknowledgement, cancellation | Autoplay request path, stale-decision rejection, accurate status forwarding |
| server/index.ts | Nebius model setup and createAgent | Autoplay prompt and one direct-return decision tool; bounded deadline |
| src/App.tsx | Engine composition, voice/manual commands, session catalogue | Controller lifecycle and manual override routing |
| src/ui/Console.tsx | Chat/voice, Actions feed, advanced controls | Autopilot controls and truthful decision/execution traces |

Current gaps are concrete: looped playback position wraps; natural end currently resets position to zero without an explicit end reason; transition loads and starts immediately; completion uses a JS timeout; model context has no recent-play history or objective. Current transition duration is 1-12 seconds. Do not silently reinterpret that API as bars.

## 3. Release 1: autonomous continuous playback

### User behavior

- User enables audio, chooses an optional set objective, then enables Autopilot.
- Default objective: "Play a varied electronic set. Keep energy broadly steady, avoid immediate repeats, and prefer smooth transitions."
- If nothing is playing, request a starting track. If one deck is playing, adopt that playback instance. If both decks are manually playing without a managed transition, refuse to enable until the manual mix is resolved.
- Autopilot chooses subsequent tracks and crossfade/filter/echo presets. Default transition is a four-second crossfade.
- The normal demo must run for ten minutes with no microphone or chat input.
- Autopilot does not speak every action through TTS. Its explanations stay in Actions; user-requested spoken replies keep existing behavior.

### Ownership and state

Add src/autopilot/controller.ts as a small TypeScript controller, not a React render-effect loop. Inject the engine, bridge, clock, and catalogue accessors for testing.

The engine owns:

- playbackId per actual start/restart, deck and track identity;
- positionSeconds within the file and playedSeconds since this playback began, including loops;
- duration, loop, audible/playing state, and transition phase;
- explicit started, ended, transition_started, transition_completed, and audio_suspended events;
- audio-context time. Wall-clock Date.now is only for human timestamps.

The controller owns:

- mode: off, running, or paused;
- phase: idle, deciding, preparing, ready, or transitioning;
- sessionId, controlRevision, objective, and last ten actually played tracks;
- one active decision request and one pending next move;
- desired transition time, deadline, a ready fallback candidate, and recent errors.

controlRevision changes for user interventions, catalogue removal, objective changes, or controller reset. It does not change on every position tick. Pending work is bound to sessionId, controlRevision, and source playbackId, not just a track ID that may repeat later.

### Timing defaults

These are initial product constants, not measured latency promises:

| Setting | Default |
| --- | --- |
| User-selected residence target | 20, 60, or 120 seconds of playedSeconds; 20 seconds by default for loops and full songs |
| Full-song transition start | Requested residence, capped before natural end to leave fade and a two-second margin |
| Transition duration | 4 seconds; keep existing supported 1-12-second range |
| Start planning | 25 seconds before desired transition start |
| Model request timeout | 10 seconds, no automatic retry for autonomous requests |
| Latest acceptance/preparation deadline | 5 seconds before desired transition start |
| Audio commit lead | 150 milliseconds, verified against installed Tone version |
| Wait decision | One deferral per playback, at most 15 seconds and never past the natural-end safety deadline |

For short songs, begin planning immediately and shorten the fade to fit. If there is insufficient lead time, use a prepared fallback. If no candidate is ready, preserve the current loop when possible; otherwise report degraded playback rather than claim silence was avoided. A one-track catalogue may intentionally repeat its sole decodable track. An empty/undecodable catalogue pauses Autopilot with a visible reason.

Current pace control treats the selected interval as an approximate target. A new playback window has at least 15 seconds from adoption for the ten-second model timeout and five-second preparation margin when media length permits; an incoming track's elapsed time during the previous fade counts toward the interval. A reviewed or estimated cue may move the start within a nearby safe window. Short full songs use a prepared local fallback when that lead cannot fit, and a clip too short for even a one-second fade waits for natural-end recovery. Changing pace invalidates uncommitted requests and adopts a fresh window with a new control revision. A committed transition finishes before the next playback window uses the new pace. Accepted model wait decisions still defer the current window by the explicit requested seconds, up to their existing bound.

At cold start there is no source-end deadline: show Preparing, request a starting choice with the same 10-second timeout, and prepare the deterministic first candidate in parallel. On timeout start that fallback if ready; on decode failure try each remaining eligible candidate at most once. Never claim the console is playing before the engine emits started. Accepting wait shifts the decision window and its deadlines together, once only, without exceeding the full song's end margin. Record history when playback actually starts, not when a proposal is accepted.

Precisely, wait defers the intended transition, not just the model response: a 60-second loop handoff may move to 75 seconds, with its planning event moving from 35 to 50 seconds. Request one fresh decision at the revised planning time, or immediately if that time already passed. Only accept the deferral if the next request still has its 10-second budget before the revised preparation deadline. A second wait, a wait while idle, or a wait that would overrun the hard end is rejected and uses fallback. This keeps the one-deferral rule bounded without calling the model repeatedly near song end.

After each completed transition, compute the next window. Do not query the LLM on every engine tick, every bar, or every transition-completion event unless a new decision is due. If a transition failed, make at most one recovery attempt for that window, then use local fallback. Deduplicate all event handling by playback/window ID.

### Agent contract

Keep manual apply_mix unchanged. For autonomous requests, configure the same LangChain/Nebius stack with one tool named submit_dj_decision, returnDirect: true. Do not give the autonomous invocation manual tools too.

The tool accepts a discriminated decision union:

- start: track_id, explanation;
- transition: track_id, style, duration_seconds, explanation;
- wait: defer_seconds, explanation.

explanation is a short public decision summary, capped at 200 characters. It is not an internal reasoning transcript. The controller chooses the exact safe execution time in Release 1; the model chooses the music and transition style. This avoids asking an LLM to invent audio-clock timestamps.

Request context includes trigger, request/session/revision/playback IDs, current state, objective, recent history, eligible catalogue metadata, desired transition time, and hard deadline. Send compact metadata, never audio samples or full beat arrays. The browser converts any local timing into remaining durations for model context; the model does not compare server wall time against AudioContext time.

### Shared musical look-ahead for voice and autonomy

Add one browser-side context builder used by both manual text/voice requests and autonomous requests. A voice command must not receive less musical context than Autopilot. Build a fresh snapshot when submitting the finalized user request, rather than reusing the state from when microphone capture began.

The snapshot contains:

- now: source playback identity, file position, monotonic played time, deck/mixer state, and current section when known;
- upcoming: at most eight relevant annotated events/cue windows in the next 60 seconds, with file timestamps, seconds until arrival, provenance, and review status;
- remainder: natural time remaining for full songs, planned residence remaining for loops, plus at most three later reviewed exit windows;
- pending: prepared next track and any already committed transition, with cancellability and scheduled timing;
- requestedChangeIntervalSeconds: the user's approximate 20, 60, or 120-second pace target;
- objective/history and eligible next-track metadata as in the autonomous context.

Release 1 populates measured timing and pending actions; unknown sections/events remain absent. Release 2 enriches the same shape from analysis sidecars and reviewed annotations. This is deterministic lookup through prerecorded media metadata, not a new forecasting model or continuous LLM state stream. A repeating clip must map events to the next loop occurrence without describing a clip boundary as the end of the set.

Explicit urgency wins: "change the song now" uses the earliest safe execution path, while "switch it up soon" may use an upcoming reviewed exit cue. A request such as "make it more energetic" may be satisfied by an approaching reviewed drop, but the agent must not invent that event from a BPM or RMS estimate. Include a brief public explanation when choosing to wait.

Manual input still pauses Autopilot as specified below. Capture the prior pending move for context, mark it cancelled if it was uncommitted, and never represent it as still executable. Already committed transitions remain visible and finish before queued non-emergency commands. In Release 2, extend the manual decision path to accept a bounded cue-based pending action or explicit wait using the same validation/scheduler as autonomy; do not let natural-language promises masquerade as scheduled actions. Stop all cancels these user-requested pending actions too.

Revalidate playback identity, revision, cue validity, and remaining time before execution. If the user request arrives too late for a cue, reject that timing and use the documented safe path rather than executing a stale plan. No extra model call is required solely to construct this context.

Reuse the WebSocket envelope and correlated acknowledgement pattern with an explicit manual/autonomous request discriminator. A valid decision is forwarded to the browser, validated, and accepted or rejected. Return the browser's acceptance result directly with no post-tool model call. A decision acknowledgement means accepted for preparation, not audio played. Decode failures and actual start/completion events appear separately in Actions.

Validation is code, not prompt text: known/eligible track, source playback still current, matching revision, unexpired decision, one decision only, supported parameters, enough media remaining, and no incompatible transition. Free-text output without a valid decision is a failed decision and follows the fallback path. Ignore late and duplicate messages.

### Prepare, commit, complete

1. At playback start, choose a deterministic fallback candidate from the eligible catalogue and predecode its buffer without replacing either audible deck. Reuse cache; do not eagerly decode an entire imported library. Keep only a small bounded set of decoded non-playing candidates.
2. At the planning event, ask the model. Continue current playback throughout inference.
3. Validate the response and prepare its chosen track. Keep the fallback until preparation succeeds. Do not set transition-active merely while a file decodes.
4. Hold one pending plan in the controller. No far-future Player.start or Player.stop is scheduled yet.
5. Shortly before the target time, revalidate identity and readiness and commit the existing audio-clock transition. If the plan missed its deadline or failed, commit the ready fallback with a crossfade.
6. Compute progress and completion from the audio clock. A delayed UI timer must not leave the state permanently busy. Emit exactly one completion event.

Refactor current transition into prepare and commit internals, while keeping the existing immediate manual transition command as a wrapper around them. Buffer preloading should not change the audible source. Tone's parameter automation and source start/stop operations have separate cancellation semantics; canceling ramps alone does not cancel scheduled sources.

### Fallback policy and user priority

- Fallback selection: decodable eligible track, not the current track when alternatives exist, least recently played, stable catalogue order to break ties. Prefer manually tagged target energy only when tags exist. Do not invent metadata for imported tracks.
- Provider timeout, malformed decision, expired decision, disconnected backend: no new model retry in that window; use the prepared fallback and log the reason. Playback supervision remains local.
- Disconnect invalidates the in-flight decision ID, clears its busy slot, and increments a connection epoch checked on every response. Reconnect does not replay it or overwrite a prepared local fallback; the next eligible window sends a fresh snapshot and request ID. The server aborts the old request on socket close.
- Decode failure: preserve the current source, mark that candidate unavailable for this session, and use the prepared fallback. Do not thrash retrying a corrupt file.
- Typing/submitting a manual command, beginning voice input, or manipulating advanced audio controls pauses Autopilot, increments revision, cancels inference, and invalidates uncommitted plans. Resume requires an explicit toggle. This makes the user's control predictable.
- A normal manual command arriving during an already committed fade is queued until that short fade completes, with visible status. Do not attempt to reverse a partially committed mix. Stop all is immediate and bypasses this queue.
- Stop all disables Autopilot, drops queued commands, invalidates loads/plans, cancels automation and source operations, and silences echo returns. Verify against the installed Tone version that a scheduled incoming source cannot start later; dispose/recreate inactive source nodes if cancellation requires it.
- Use the public Player.stop at the current audio time for emergency source cancellation, not the current now-plus-40ms stop that may allow a queued start to become briefly audible. Hold/cancel gain ramps and zero output/tails as well. Do not assume bridge cancellation alone stops an engine operation.
- Turning Autopilot off preserves current playback, cancels uncommitted work, and lets a committed transition finish. Restart does not resurrect old plans.
- On audio-context suspension or hidden-page state, pause new autonomous decisions and clear uncommitted plans. Already committed audio follows the engine. Reconcile on return and require explicit resume. Do not claim browser background or laptop-sleep reliability.

## 4. Actions panel and telemetry

Reuse Activity rendering, adding requestId/planId correlation and monotonic timing measurements. Display the following lifecycle without rewriting the whole frontend:

trigger -> deciding -> decision accepted -> preparing -> ready -> scheduled -> started -> completed

Failures branch to rejected, cancelled, or fallback. Display the brief explanation as "Agent explanation" only when supplied by the model. Deterministic decisions are labeled "Local fallback" and explain their actual rule. Record model latency, decode latency, scheduled-versus-observed start delay, and completion. Never label an acceptance acknowledgement completed playback.

Show one status line beside Autopilot, for example: "Playing Melodic. Next: Loopy in 18s." Keep raw arguments/results expandable in Actions. No additional tracing service or key is required for the release.

## 5. Release 2: useful preprocessing and bounded musical actions

Do this only after Release 1 acceptance passes.

### Chosen analysis approach

Keep analysis browser-local and reuse the decoded AudioBuffer. Add web-audio-beat-detector for estimated BPM and first-beat offset, plus a compact measured RMS envelope. Run analysis as an explicit preparation/import task while Autopilot is off initially; do not assume an asynchronous API guarantees zero main-thread work. Measure responsiveness before moving analysis into live playback. No Python process, audio upload, or hosted audio model.

Persist metadata only in IndexedDB keyed by content hash plus analysis version. Imported audio remains session-local; after reload the user reimports the file and cached metadata can be reused. Persisting audio files is a separate feature.

Store:

- measured duration and frame-level RMS summaries;
- estimated BPM and beat offset, with algorithm/version and source segment;
- manually supplied cue-in, exit window, downbeat anchor, tags, and optional labeled sections;
- provenance per field: measured, estimated, derived, or manual; review status; unknown values explicitly null.

The chosen detector does not provide a verified beat-event list or a confidence score. Do not invent confidence. A uniform grid derived from BPM/offset is an estimate, not detected downbeats or phrase boundaries. RMS is signal amplitude, not a reliable mood, vocal, drop, or chorus label. Human-reviewed cues override estimates.

### Musical behavior

First use metadata to improve candidate selection and choose among reviewed exit windows. Add incoming cue offset support and schedule validated cue-based transitions. Keep seconds as the underlying contract. Only offer beat/bar labels where a reviewed grid and downbeat anchor exist; missing data falls back to Release 1.

Implemented slice: the bundled clips have waveform-reviewed pulse grids at 140 BPM with a 0.11-second anchor, exit-start windows, and cue-in offsets; those are pulses, not downbeats or phrases. The detector's unreviewed 117/116/140 BPM guesses remain separate metadata. A loop estimate must close within 0.12 beats of an integer before it can steer timing or candidate preference, so the first two demo guesses are displayed but not used. Reviewed pulse timing takes precedence. Analyzed imported tracks can snap near an otherwise safe timed handoff to an estimated beat departure and use an estimated incoming first-beat offset. Without a usable estimate they keep the Release 1 timed handoff. Manual `next_cue` is reviewed-window-only, bounded to 30 seconds, revalidated after preparation, and cancelled by new manual input or Stop all; urgent requests remain immediate. No tempo stretching or semantic event inference is implied.

Add one bounded autonomous EQ preset after cue transitions work: a bass handover inside a transition with explicit initial values, scheduled ramps, and restoration on finish/cancel. Permit at most one musical embellishment per transition. Do not give the agent repeated arbitrary knob updates or introduce persistent bass cuts with no reset.

No automatic key matching, vocal-overlap avoidance, tempo stretching, semantic section detection, or claim of beatmatching in this release. Matching nominal BPM does not align beats. Long bar-based transitions also require revisiting the current 12-second limit rather than squeezing a 16-bar plan into it.

### Later, only when required

If tempo/offset estimates are inadequate and detected beat timestamps are a real requirement, add an offline librosa batch-analysis command and explicit local-file handoff. If downbeats, vocals, and semantic song sections are required, evaluate specialist models on a small labeled fixture set before integrating them. Do not equate every 8/16/32 bars with a verified phrase. Essentia is not selected for this plan; its broader feature set and separate licensing/runtime considerations do not solve the immediate need more simply.

## 6. Implementation sequence and ownership

1. Freeze contracts and fixtures: playback IDs, monotonic playedSeconds, events, decision union, shared manual/autonomous look-ahead context, acknowledgement states. Preserve manual compatibility.
2. Audio work: explicit lifecycle events, prepare/commit split, bounded preload cache, audio-clock completion and cancellation regression coverage. Can proceed alongside server work after contracts freeze.
3. Harness work: autonomous prompt/tool path, one decision per invocation, bounded timeout, no retry, correlation and compact history. Do not rebuild the existing manual harness.
4. Controller work: planning windows, state machine, stale rejection, deterministic fallback, manual priority, suspension handling. Integrate against fake clock/engine/bridge first, then real boundaries.
5. UI work: Autopilot toggle/objective/status plus existing Actions panel lifecycle. Keep advanced console collapsed.
6. Integration: deterministic browser scenarios, ten-minute live set, provider interruption and manual override, update README and record observed timings.
7. Release 2 only after Release 1 passes: local analysis sidecars, reviewed cues, then one EQ transition preset.

For implementation delegation, use Sol-medium as previously requested: one audio owner, one server/contracts owner, and one controller/UI integrator once shared contracts are frozen. Avoid concurrent edits to shared/contracts.ts or src/App.tsx. Luna research is complete planning input, not an implementation requirement.

## 7. Acceptance gates

### Deterministic tests

- Looped clips use monotonic residence time and do not trigger a decision on every loop wrap.
- One request per decision window; wait is capped; repeated ticks/events cannot duplicate actions.
- A late model result after a manual override, catalogue change, source restart, or stop is rejected.
- Timeout, malformed response, disconnected backend, and failed decode produce the documented fallback without false success.
- Preparing a track leaves the source audible. No conflicting writes to the audible deck.
- A transition starts/completes once; delayed completion callbacks reconcile correctly from audio time.
- Stop-all during inference, decode, prepared wait, near-start scheduling, fade, and echo tail causes no subsequent restart. Exercise real Tone behavior in Chrome, not just a fake engine.
- Current manual voice/text tool commands still work and pause Autopilot as specified.
- Missing analysis fields are accepted; no guessed BPM/phrase data appears as fact.
- Manual and autonomous requests at the same playback instant receive the same look-ahead facts. Voice snapshots reflect final-transcript submission time. Expired cues, loop wrap, unknown annotations, and invalidated pending moves are represented correctly.
- In Release 2, explicit immediate requests take priority over optional musical waiting; cue-based manual actions use the actual scheduler and report acceptance/start/completion separately.

### Browser and live-provider checks

- Existing typecheck, build, backend and Chrome tests stay green.
- Deterministic WS fixtures exercise the whole decision -> prepare -> audio -> lifecycle path and assert actual engine/meter state.
- Ten-minute run on the bundled loops performs at least eight autonomous transitions with no user input, repeated requests, or growing pending-plan count.
- Repeat with at least two full-length local files, including a natural-end case. Prepared healthy fixtures have no transition-caused silent gap, measured at master output with intentional source silence excluded.
- Inject provider unavailability during the run: prepared local fallback works and is labeled accurately.
- One manual voice or text override cancels pending autonomy; Stop all never restarts audio.
- Record model, number of requests, latency median/slowest, fallback count, and start timing error. No latency claim from a single sample.
- Real Nebius decisions and actual browser execution must be tested together. Previous live-provider smoke checks used simulated browser acknowledgement and do not cover this release.

Release 1 is done when these gates pass, the UI remains compact, and the README explains Autopilot, override, fallback, and active-browser limits. Release 2 is a separate milestone, not a blocker for shipping autonomous playback.

## 8. Primary references

- LangChain agent/tool architecture: https://docs.langchain.com/oss/javascript/langchain/agents
- Tone audio scheduling: https://github.com/tonejs/tone.js/wiki/Transport
- Tone accurate timing: https://github.com/Tonejs/Tone.js/wiki/Accurate-Timing
- Tone source lifecycle: https://github.com/Tonejs/Tone.js/blob/dev/Tone/source/Source.ts (verify installed version behavior before implementation)
- Audio context state: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state
- Page visibility/background timers: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Browser BPM/offset estimator and MIT license: https://github.com/chrisguttandin/web-audio-beat-detector
- Later offline beat tracking: https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html
- RMS reference: https://librosa.org/doc/0.11.0/generated/librosa.feature.rms.html
- Essentia extractor, evaluated but not selected: https://essentia.upf.edu/streaming_extractor_music.html

All numeric defaults above are design decisions for the first implementation and must be validated by the acceptance run. This plan was written before the Release 1 implementation.
