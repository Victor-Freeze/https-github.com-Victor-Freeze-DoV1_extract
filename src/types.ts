export interface ExtractorStats {
  frameCount: number;
  rpuCount: number;
  inputSize: number;
  outputSize: number;
  startTime: number;
  endTime: number | null;
}

export interface RpuEntry {
  timestamp: bigint;
  rpuData: Uint8Array;
}

export interface LogEntry {
  type: 'info' | 'success' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface IVFHeader {
  signature: string;
  width: number;
  height: number;
  timebaseNum: number;
  timebaseDen: number;
  numFrames: number;
}
