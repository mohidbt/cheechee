import type { TrackAnalysis } from '../../shared/contracts';
import { TrackAnalysisSchema } from '../../shared/contracts';

export const ANALYSIS_VERSION = 1;
const MAX_RMS_WINDOWS = 256;
const MIN_RMS_WINDOW_SECONDS = 0.5;
const DATABASE_NAME = 'cheechee-track-analysis';
const STORE_NAME = 'analyses';

const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function contentKeyForBytes(sourceBytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', sourceBytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function openAnalysisDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const storageKey = (contentKey: string) => `${ANALYSIS_VERSION}:${contentKey}`;

export async function readPersistedAnalysis(contentKey: string): Promise<TrackAnalysis | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openAnalysisDatabase();
  try {
    return await new Promise<TrackAnalysis | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(storageKey(contentKey));
      request.onsuccess = () => {
        const parsed = TrackAnalysisSchema.safeParse(request.result);
        resolve(parsed.success && parsed.data.analysisVersion === ANALYSIS_VERSION && parsed.data.contentKey === contentKey ? parsed.data : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}

export async function writePersistedAnalysis(analysis: TrackAnalysis): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openAnalysisDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(analysis, storageKey(analysis.contentKey));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

/** Analyze decoded PCM locally. Tempo and offset remain estimates, never reviewed cues. */
export async function analyzeAudioBuffer(buffer: AudioBuffer, contentKey: string): Promise<TrackAnalysis> {
  const framesPerWindow = Math.max(Math.ceil(buffer.sampleRate * MIN_RMS_WINDOW_SECONDS), Math.ceil(buffer.length / MAX_RMS_WINDOWS));
  const rmsValues: number[] = [];
  const channels = Array.from({length:buffer.numberOfChannels}, (_, index) => buffer.getChannelData(index));
  for (let start = 0; start < buffer.length; start += framesPerWindow) {
    const end = Math.min(buffer.length, start + framesPerWindow);
    let sum = 0;
    for (const channel of channels) for (let frame = start; frame < end; frame++) sum += channel[frame] * channel[frame];
    rmsValues.push(Math.sqrt(sum / ((end - start) * channels.length)));
    if (rmsValues.length % 16 === 0) await yieldToBrowser();
  }

  const sourceDurationSeconds = Math.min(60, buffer.duration);
  let estimatedTempo: TrackAnalysis['estimatedTempo'] = null;
  try {
    const { guess } = await import('web-audio-beat-detector');
    const estimate = await guess(buffer, 0, sourceDurationSeconds);
    if (Number.isFinite(estimate.bpm) && estimate.bpm > 0 && Number.isFinite(estimate.offset) && estimate.offset >= 0 && estimate.offset < buffer.duration) {
      estimatedTempo = {
        bpm: estimate.bpm,
        firstBeatOffsetSeconds: estimate.offset,
        sourceStartSeconds: 0,
        sourceDurationSeconds,
        provenance: 'estimated',
        reviewed: false,
      };
    }
  } catch {
    // Silence and irregular material still have measured duration and RMS.
  }
  return {
    contentKey,
    analysisVersion: ANALYSIS_VERSION,
    durationSeconds: {value:buffer.duration, provenance:'measured'},
    rms: {windowSeconds:framesPerWindow / buffer.sampleRate, values:rmsValues, provenance:'measured'},
    estimatedTempo,
  };
}
