import 'dotenv/config';
import type { ServiceStatus } from '../shared/contracts.js';

export const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';
export function envStatus(): ServiceStatus {
  const agent = Boolean(process.env.NEBIUS_API_KEY?.trim() && process.env.NEBIUS_MODEL?.trim());
  const speech = Boolean(process.env.ELEVENLABS_API_KEY?.trim());
  return { agent, speech, tts: speech && Boolean((process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE).trim()), model: agent ? process.env.NEBIUS_MODEL! : null };
}
