# Cheechee

A local two-deck DJ console with a filmed performance view. The browser plays and mixes audio with Tone.js. Muted video clips follow actual audio actions and never control or delay the mix. A Nebius-backed LangChain agent handles manual requests through `apply_mix` and chooses tracks and transitions for Autopilot through `submit_dj_decision`. ElevenLabs provides optional push-to-talk transcription and spoken replies. Manual playback works without provider credentials.

## Start

Requires Node.js 22 or newer and npm. Run `npm install`, copy `.env.example` to `.env`, then run `npm run dev`. Open <http://127.0.0.1:5173>. The server listens on loopback port 3001 and Vite proxies `/ws` and `/api` to it.

Click **Enable audio**, then switch **Autopilot** on to start a set. Its optional objective field defaults to a varied electronic set. **Time between changes** sets an approximate 20, 60, or 120-second target; 20 seconds is the default for both loops and longer songs. Cheechee prepares the next track while audio plays. A nearby cue or the time needed for a safe decision and fade may shift the handoff later; a short song may end sooner and use its prepared local fallback. Changing the setting during playback cancels an uncommitted plan and schedules a new one from the track's elapsed play time. It uses a four-second crossfade when the model is unavailable. The Actions panel shows actual decisions, explanations supplied by the model, local fallback reasons, preparation and playback events, and expandable request details.

The performance stage keeps deck EQ and gain, crossfader, master volume, Stop all, Actions, and voice/text controls in reach. BPM appears only when local analysis supplies an approximate estimate; it does not imply tempo matching. Manual loading, filters, and preset transitions remain available under **Advanced controls**. Load a track on deck A and press **Play**, or mix the four bundled Play House songs. You can also import up to ten local audio files, each at most 25 MB. Local files stay in this browser session.

Typing a manual command, beginning voice input, or changing an advanced audio control pauses Autopilot. A manual request made during an already committed transition waits until that fade finishes. A manual transition can request `timing: next_cue` when a reviewed exit window fits its fade; the tool acknowledges a scheduled move, then Actions reports actual start and completion. Immediate timing remains the default and an urgent request takes that path. A later manual input or **Stop all audio** cancels an uncommitted cue. Resume Autopilot with its switch. Stop all also disables Autopilot, cancels pending requests and prepared moves, and stops both decks. Turning Autopilot off without Stop all lets the current track continue.

## Provider configuration

Set these in `.env` for agent commands:

```dotenv
NEBIUS_API_KEY=your_key
NEBIUS_MODEL=an_available_tool_capable_model_id
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/
```

Choose a tool-capable model ID available to your Nebius account. No model is hard-coded or substituted when this value is missing. The API key stays on the Node server. `/api/status` reports whether the required values are set; it does not validate account access. To smoke-test a configured model, enable audio, switch on Autopilot, and check for a `submit_dj_decision` result, an Actions entry, and audible playback. The model must support tool calls.

Restart `npm run dev` after editing `.env` so the Node server reads the new values.

For optional voice controls, set `ELEVENLABS_API_KEY`. `ELEVENLABS_VOICE_ID` defaults to Sarah (`EXAVITQu4vr4xnSDxMaL`), and `ELEVENLABS_TTS_MODEL` defaults to `eleven_flash_v2_5`. Hold the microphone button to speak and release to send the committed transcript through the same agent path as text. The browser receives a short-lived Scribe token; it never receives the ElevenLabs API key. Replies are synthesized only after an acknowledged action. Use headphones to keep the music out of the microphone. Turn spoken replies off with the voice reply toggle if preferred.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Browser checks use `npm run test:e2e`. Unit tests cover Autopilot decisions, stale responses, wait limits, fallback, and natural-end recovery. Browser tests cover manual mixing, stop-all, mobile import, a deterministic Autopilot decision through the real audio engine, and audio cancellation around scheduled transitions. The bundled audio attribution and CC0 source are in [public/audio/ATTRIBUTION.md](public/audio/ATTRIBUTION.md).

Autopilot asks for one decision per playback window, with a ten-second model timeout. It preloads a deterministic eligible fallback, so a timeout or disconnection does not automatically stop a running set. A decision acknowledgement means accepted for preparation; actual start and completion appear as separate Actions entries. If the catalogue is empty or no track can decode, Autopilot pauses and reports the reason. A single eligible track may repeat.

Autopilot runs while the page is open and the browser audio context is active. Hiding the page or suspending audio pauses new decisions and requires an explicit resume. Continuous playback is not guaranteed through laptop sleep, closing the page, or an interrupted audio device. **Analyze tracks** in Library runs local duration, RMS, and estimated BPM/first-beat analysis while Autopilot is off. Results are versioned and cached by audio content in IndexedDB; imported audio remains session-local. The four bundled songs have no reviewed BPM, pulse grids, or cue points. When a track has a usable estimate, Autopilot can move a safe timed handoff toward an estimated beat start, clearly labeled unreviewed; without analysis it retains timed handoff. The seconds-based fade contract remains 1 to 12 seconds, with no playback-rate matching, key matching, or section detection. Live model timing and a ten-minute run should be judged from recorded multi-request results, not a single call.

## Observed live run

On 23 September 2026, a Release 1 automated Chrome run, before local analysis and cue scheduling were added, used the former three-loop catalogue, the configured live Nebius model, and no microphone input for ten minutes. It recorded 10 playback starts and 9 completed transitions from 11 decision requests. Six decisions were accepted; five timed out and used the prepared local fallback. Four transitions followed agent decisions and five followed fallback. WebSocket disconnects: zero. The output meter was nonzero in 1,198 of 1,200 half-second samples. These are observations from that earlier catalogue, not a guarantee about the current songs or every browser. Accepted model calls took 1.32, 6.99, 2.65, 9.36, 3.34, and 5.25 seconds, with a 4.29-second median and 9.36-second slowest result; timeouts are excluded from those latency figures.

That run preceded follow-up Release 1 changes to duration validation, loop context, and Actions labels. The regression suite covers those changes. A separate Release 1 live UI run completed one Nebius-backed crossfade and showed the new track playing. Earlier Release 2 cue timing was verified locally in Chrome against the former loop catalogue; those reviewed landmarks are not applied to the current songs. Browser tests also exercised local analysis, IndexedDB reuse, and the compact Library control. The ten-minute live run has not been repeated with the current song catalogue.
