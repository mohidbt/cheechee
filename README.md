# Cheechee

A local two-deck DJ console. The browser plays and mixes audio with Tone.js. A Nebius-backed LangChain agent can control it through one `apply_mix` tool. ElevenLabs provides optional push-to-talk transcription and spoken replies. Manual playback works without any provider credentials.

## Start

Requires Node.js 22 or newer and npm. Run `npm install`, copy `.env.example` to `.env`, then run `npm run dev`. Open <http://127.0.0.1:5173>. The server listens on loopback port 3001 and Vite proxies `/ws` and `/api` to it.

Click **Enable audio**, load a library track on deck A, then press **Play**. The three bundled Fupi clips are loops and can be mixed with the crossfader, EQ, filters, and preset transitions. You can also drag up to ten local audio files into the library, each at most 25 MB. Local files stay in this browser session.

## Provider configuration

Set these in `.env` for agent commands:

```dotenv
NEBIUS_API_KEY=your_key
NEBIUS_MODEL=an_available_tool_capable_model_id
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/
```

Choose a tool-capable model ID available to your Nebius account. No model is hard-coded or substituted when this value is missing. The API key stays on the Node server. `/api/status` reports whether the required values are set; it does not validate account access. To smoke-test a configured model, enable audio, then ask “play something energetic” and check for a visible `apply_mix` call, a browser acknowledgement, and audible playback. A valid key, model availability, and tool support must be verified against the live account.

Restart `npm run dev` after editing `.env` so the Node server reads the new values.

For optional voice controls, set `ELEVENLABS_API_KEY`. `ELEVENLABS_VOICE_ID` defaults to George (`JBFqnCBsd6RMkjVDRZzb`), and `ELEVENLABS_TTS_MODEL` defaults to `eleven_flash_v2_5`. Hold the microphone button to speak and release to send the committed transcript through the same agent path as text. The browser receives a short-lived Scribe token; it never receives the ElevenLabs API key. Replies are synthesized only after an acknowledged action. Use headphones to keep the music out of the microphone. Turn spoken replies off with the voice reply toggle if preferred.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Browser checks use `npm run test:e2e`. The backend tests use a simulated browser acknowledgement. The Playwright checks cover manual playback, waveform activity, all three transition presets, stop-all, mobile layout, local file import, and a deterministic WebSocket tool call through the real audio engine. These checks do not claim live model or speech verification. The bundled audio attribution and CC0 source are in [public/audio/ATTRIBUTION.md](public/audio/ATTRIBUTION.md).

The server processes one request per browser connection. Each batch waits for the browser's actual result for up to ten seconds. A failed command stops the batch and labels the remaining commands skipped. A transition acknowledgement means the fade was scheduled; its completion appears separately in the activity feed. Stop-all cancels pending work and silences both decks.

Live Nebius inference, ElevenLabs transcription and TTS, microphone permissions, and end-to-end latency remain unverified until credentials and a real microphone are available. No timing sample or model ID is claimed here.
