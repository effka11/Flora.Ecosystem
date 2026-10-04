export const KILOBYTES_PER_BYTE = 1024;
export const MILLISECONDS_PER_SECOND = 1000;
export const MINIMUM_SAMPLE_BYTES = 16 * KILOBYTES_PER_BYTE;
export const LEAD_SECONDS = 4;
export const MIN_ROWS_AHEAD = 2;
export const MAX_ROWS_AHEAD = 10;

export const DEFAULT_BANDWIDTH_KILOBYTES_PER_SECOND = 256;
export const DEFAULT_AVERAGE_IMAGE_KILOBYTES = 200;

const EWMA_ALPHA = 0.25;
const PERSIST_EVERY_VALID_SAMPLES = 5;
const STORAGE_KEY = "flora.media-bandwidth.v1";

export interface FriDownloadSample {
  bytes: number;
  durationMilliseconds: number;
  interrupted: boolean;
}

export interface MediaBandwidthStorage {
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string): Promise<void>;
}

export interface MediaBandwidthEstimate {
  kilobytesPerSecond: number;
  averageImageKilobytes: number;
  rowsAhead: number;
  hasValidSamples: boolean;
}

interface PersistedMediaBandwidthState {
  version: 1;
  kilobytesPerSecond: number;
  averageImageKilobytes: number;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function ewma(previous: number | undefined, next: number): number {
  return previous === undefined ? next : EWMA_ALPHA * next + (1 - EWMA_ALPHA) * previous;
}

export function calculateRowsAhead(
  kilobytesPerSecond: number,
  averageImageKilobytes: number,
): number {
  if (!isFinitePositive(kilobytesPerSecond) || !isFinitePositive(averageImageKilobytes)) {
    return MIN_ROWS_AHEAD;
  }

  const rawRowsAhead = (kilobytesPerSecond * LEAD_SECONDS) / averageImageKilobytes;
  return Math.round(Math.min(MAX_ROWS_AHEAD, Math.max(MIN_ROWS_AHEAD, rawRowsAhead)));
}

export class MediaBandwidthEstimator {
  private kilobytesPerSecond: number | undefined;
  private averageImageKilobytes: number | undefined;
  private validSamplesSincePersistence = 0;

  reportDownload(sample: FriDownloadSample): boolean {
    if (
      sample.interrupted ||
      !Number.isFinite(sample.bytes) ||
      sample.bytes < MINIMUM_SAMPLE_BYTES ||
      !Number.isFinite(sample.durationMilliseconds) ||
      sample.durationMilliseconds <= 0
    ) {
      return false;
    }

    const imageKilobytes = sample.bytes / KILOBYTES_PER_BYTE;
    const downloadSeconds = sample.durationMilliseconds / MILLISECONDS_PER_SECOND;
    const sampleKilobytesPerSecond = imageKilobytes / downloadSeconds;

    if (!isFinitePositive(sampleKilobytesPerSecond)) {
      return false;
    }

    this.kilobytesPerSecond = ewma(this.kilobytesPerSecond, sampleKilobytesPerSecond);
    this.averageImageKilobytes = ewma(this.averageImageKilobytes, imageKilobytes);
    this.validSamplesSincePersistence += 1;
    return true;
  }

  getEstimate(): MediaBandwidthEstimate {
    const kilobytesPerSecond =
      this.kilobytesPerSecond ?? DEFAULT_BANDWIDTH_KILOBYTES_PER_SECOND;
    const averageImageKilobytes =
      this.averageImageKilobytes ?? DEFAULT_AVERAGE_IMAGE_KILOBYTES;

    return {
      kilobytesPerSecond,
      averageImageKilobytes,
      rowsAhead: calculateRowsAhead(kilobytesPerSecond, averageImageKilobytes),
      hasValidSamples:
        this.kilobytesPerSecond !== undefined && this.averageImageKilobytes !== undefined,
    };
  }

  restore(serializedState: string | null): boolean {
    if (serializedState === null) {
      return false;
    }

    try {
      const state = JSON.parse(serializedState) as Partial<PersistedMediaBandwidthState>;
      if (
        state.version !== 1 ||
        !isFinitePositive(state.kilobytesPerSecond ?? Number.NaN) ||
        !isFinitePositive(state.averageImageKilobytes ?? Number.NaN)
      ) {
        return false;
      }

      this.kilobytesPerSecond = state.kilobytesPerSecond;
      this.averageImageKilobytes = state.averageImageKilobytes;
      this.validSamplesSincePersistence = 0;
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.kilobytesPerSecond = undefined;
    this.averageImageKilobytes = undefined;
    this.validSamplesSincePersistence = 0;
  }

  shouldPersist(): boolean {
    return this.validSamplesSincePersistence >= PERSIST_EVERY_VALID_SAMPLES;
  }

  markPersisted(): void {
    this.validSamplesSincePersistence = 0;
  }

  serialize(): string | null {
    if (
      this.kilobytesPerSecond === undefined ||
      this.averageImageKilobytes === undefined
    ) {
      return null;
    }

    const state: PersistedMediaBandwidthState = {
      version: 1,
      kilobytesPerSecond: this.kilobytesPerSecond,
      averageImageKilobytes: this.averageImageKilobytes,
    };
    return JSON.stringify(state);
  }
}

export const mediaBandwidth = new MediaBandwidthEstimator();

let storage: MediaBandwidthStorage | undefined;
let persistenceInFlight: Promise<void> | undefined;

export async function initializeMediaBandwidth(
  nextStorage: MediaBandwidthStorage,
): Promise<boolean> {
  storage = nextStorage;
  mediaBandwidth.reset();
  return mediaBandwidth.restore(await storage.getString(STORAGE_KEY));
}

export async function initializeMediaBandwidthFromMmkv(): Promise<boolean> {
  const { mmkvStore } = await import("./mmkv");
  return initializeMediaBandwidth(mmkvStore);
}

export function reportFriDownload(sample: FriDownloadSample): boolean {
  const accepted = mediaBandwidth.reportDownload(sample);

  if (accepted && mediaBandwidth.shouldPersist()) {
    // Download completion is a scroll hot path. Coalescing five valid samples
    // bounds MMKV writes while keeping a recent estimate for the next launch.
    void flushMediaBandwidth().catch(() => undefined);
  }

  return accepted;
}

export function getMediaBandwidthEstimate(): MediaBandwidthEstimate {
  return mediaBandwidth.getEstimate();
}

export function getRowsAhead(): number {
  return mediaBandwidth.getEstimate().rowsAhead;
}

export async function flushMediaBandwidth(): Promise<void> {
  if (persistenceInFlight !== undefined) {
    return persistenceInFlight;
  }

  const serializedState = mediaBandwidth.serialize();
  if (storage === undefined || serializedState === null) {
    return;
  }

  persistenceInFlight = storage
    .setString(STORAGE_KEY, serializedState)
    .then(() => {
      mediaBandwidth.markPersisted();
    })
    .finally(() => {
      persistenceInFlight = undefined;
    });

  return persistenceInFlight;
}

export function resetMediaBandwidth(): void {
  mediaBandwidth.reset();
}
