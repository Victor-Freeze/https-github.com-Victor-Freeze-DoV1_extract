import { ExtractorStats, RpuEntry, IVFHeader } from '../types';

class BitReader {
  private data: Uint8Array;
  private size: number;
  private bitOffset: number;

  constructor(data: Uint8Array, size: number) {
    this.data = data;
    this.size = size;
    this.bitOffset = 0;
  }

  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.bitOffset >= this.size * 8) return value;
      const byteIdx = Math.floor(this.bitOffset / 8);
      const bitShift = 7 - (this.bitOffset % 8);
      const bit = (this.data[byteIdx] >> bitShift) & 1;
      value = (value << 1) | bit;
      this.bitOffset++;
    }
    return value;
  }

  readBit(): boolean {
    return this.readBits(1) !== 0;
  }

  align(): void {
    if (this.bitOffset % 8 !== 0) {
      this.bitOffset += 8 - (this.bitOffset % 8);
    }
  }

  readVariableBits(n: number): number {
    let value = 0;
    const maxVal = 1 << n;
    while (true) {
      const tmp = this.readBits(n);
      value += tmp;
      if (!this.readBit()) break;
      value = value << n;
      value += maxVal;
    }
    return value;
  }

  readRemainingBytes(numBytes: number): Uint8Array {
    const result = new Uint8Array(numBytes);
    for (let i = 0; i < numBytes; i++) {
      result[i] = this.readBits(8);
    }
    return result;
  }
}

function readLeb128(data: Uint8Array, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (state.offset < data.length) {
    const byte = data[state.offset++];
    value |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return value;
}

function addEmulationPrevention(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const rSize = result.length;
    // BUGFIX: Check bytes in the output 'result' array instead of the input 'data' array.
    // Checking the input 'data' array caused false matches and corrupted emulation prevention bytes insertion.
    if (rSize >= 2 && result[rSize - 2] === 0 && result[rSize - 1] === 0 && data[i] <= 3) {
      result.push(0x03);
    }
    result.push(data[i]);
  }
  return new Uint8Array(result);
}

export function parseIVFHeader(fileBuffer: ArrayBuffer): IVFHeader {
  if (fileBuffer.byteLength < 32) {
    throw new Error('File is too small to be a valid IVF container');
  }
  const view = new DataView(fileBuffer);
  const signature = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (signature !== 'DKIF') {
    throw new Error('Not a valid IVF file (DKIF signature missing)');
  }
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const timebaseDen = view.getUint32(16, true);
  const timebaseNum = view.getUint32(20, true);
  const numFrames = view.getUint32(24, true);

  return {
    signature,
    width,
    height,
    timebaseNum,
    timebaseDen,
    numFrames,
  };
}

export interface ParseResult {
  stats: ExtractorStats;
  outBuffer: Uint8Array;
}

export async function extractRpusFromIvf(
  fileBuffer: ArrayBuffer,
  onProgress: (stats: ExtractorStats) => void,
  onLog: (message: string, type: 'info' | 'success' | 'warn' | 'error') => void,
  yieldIntervalMs = 20
): Promise<ParseResult> {
  const stats: ExtractorStats = {
    frameCount: 0,
    rpuCount: 0,
    inputSize: fileBuffer.byteLength,
    outputSize: 0,
    startTime: Date.now(),
    endTime: null,
  };

  onLog('Initializing IVF parsing...', 'info');
  const header = parseIVFHeader(fileBuffer);
  onLog(`IVF Container details: Dimensions: ${header.width}x${header.height}, Target frame count: ${header.numFrames}`, 'info');

  const u8Array = new Uint8Array(fileBuffer);
  const view = new DataView(fileBuffer);
  const fileLength = fileBuffer.byteLength;
  const rpuEntries: RpuEntry[] = [];
  let offset = 32; // Skip IVF header

  let lastYieldTime = Date.now();

  while (offset + 12 <= fileLength) {
    const frameSize = view.getUint32(offset, true);
    const timestamp = view.getBigUint64(offset + 4, true);
    offset += 12;

    if (offset + frameSize > fileLength) {
      onLog(`Warning: Truncated frame data near offset ${offset}`, 'warn');
      break;
    }

    const frameData = u8Array.subarray(offset, offset + frameSize);
    offset += frameSize;

    let frameOffset = 0;
    while (frameOffset < frameSize) {
      const obuHeader = frameData[frameOffset++];
      const obuType = (obuHeader >> 3) & 0x0f;
      const obuExtensionFlag = ((obuHeader >> 2) & 1) === 1;
      const obuHasSizeField = ((obuHeader >> 1) & 1) === 1;

      if (obuExtensionFlag) {
        frameOffset++;
      }

      let obuSize = 0;
      if (obuHasSizeField) {
        const state = { offset: frameOffset };
        obuSize = readLeb128(frameData, state);
        frameOffset = state.offset;
      } else {
        obuSize = frameSize - frameOffset;
      }

      if (obuType === 5) { // OBU_METADATA
        let payloadStart = frameOffset;
        const state = { offset: payloadStart };
        const metadataType = readLeb128(frameData, state);
        payloadStart = state.offset;

        if (metadataType === 4) { // ITU-T T.35
          const countryCode = frameData[payloadStart++];
          if (countryCode === 0xB5) {
            const providerCode = (frameData[payloadStart] << 8) | frameData[payloadStart + 1];
            payloadStart += 2;

            if (providerCode === 0x003b) {
              const providerOrientedCode =
                (frameData[payloadStart] << 24) |
                (frameData[payloadStart + 1] << 16) |
                (frameData[payloadStart + 2] << 8) |
                frameData[payloadStart + 3];
              payloadStart += 4;

              if (providerOrientedCode === 0x00000800) {
                const obuEnd = frameOffset + obuSize;
                const br = new BitReader(frameData.subarray(payloadStart, obuEnd), obuEnd - payloadStart);

                const version = br.readBits(2);
                const keyId = br.readBits(3);
                const payloadId = br.readBits(5);
                let payloadIdExt = 0;
                // BUGFIX: payloadIdExt only exists if payloadId is exactly 31.
                // Reading variable bits unconditionally caused incorrect parsing offsets on profile streams.
                if (payloadId === 31) {
                  payloadIdExt = br.readVariableBits(5) + 31;
                }

                br.readBit(); // smploffste
                br.readBit(); // duratione
                br.readBit(); // groupide
                br.readBit(); // codecdatae
                br.readBit(); // discard_unknown_payload

                const emdfPayloadSize = br.readVariableBits(8);

                // BUGFIX: The EMDF payload data starts on a byte boundary. Align the bit pointer 
                // to the next byte boundary before reading raw payload bytes to avoid shifted buffer content.
                br.align();
                const rpuRaw = br.readRemainingBytes(emdfPayloadSize);

                const rpuWithPrefix = new Uint8Array(emdfPayloadSize + 1);
                rpuWithPrefix[0] = 0x19;
                rpuWithPrefix.set(rpuRaw, 1);

                rpuEntries.push({
                  timestamp,
                  rpuData: rpuWithPrefix,
                });

                stats.rpuCount++;
                onLog(`Frame ${stats.frameCount}: Found DoVi RPU, size ${emdfPayloadSize} bytes`, 'success');
              }
            }
          }
        }
      }
      frameOffset += obuSize;
    }

    stats.frameCount++;

    // Yield control periodically to prevent browser freezing on large files
    const now = Date.now();
    if (now - lastYieldTime > yieldIntervalMs) {
      onProgress({ ...stats });
      // Minor microtask sleep
      await new Promise(resolve => setTimeout(resolve, 1));
      lastYieldTime = Date.now();
    }
  }

  onLog(`Completed parsing frames. Found ${stats.rpuCount} Dolby Vision RPU payloads.`, 'info');

  if (rpuEntries.length === 0) {
    onLog('No Dolby Vision RPU metadata found in the input container!', 'warn');
    stats.endTime = Date.now();
    onProgress({ ...stats });
    return {
      stats,
      outBuffer: new Uint8Array(0),
    };
  }

  onLog('Sorting and structuring RPU metadata for export...', 'info');

  // Sort entries by timestamp to ensure presentation order
  rpuEntries.sort((a, b) => {
    if (a.timestamp < b.timestamp) return -1;
    if (a.timestamp > b.timestamp) return 1;
    return 0;
  });

  // Calculate output buffer size and perform start code formatting + emulation prevention
  let totalWrittenSize = 0;
  const processedRpuData = rpuEntries.map(entry => {
    const rpuWithEp = addEmulationPrevention(entry.rpuData);
    totalWrittenSize += 4 + 2 + rpuWithEp.length; // 4 bytes start code + 2 bytes NAL header + RPU length
    return rpuWithEp;
  });

  const outBuffer = new Uint8Array(totalWrittenSize);
  let writeOffset = 0;
  const startCode = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
  const nalHeader = new Uint8Array([0x7C, 0x01]);

  for (const rpuWithEp of processedRpuData) {
    outBuffer.set(startCode, writeOffset);
    writeOffset += 4;
    outBuffer.set(nalHeader, writeOffset);
    writeOffset += 2;
    outBuffer.set(rpuWithEp, writeOffset);
    writeOffset += rpuWithEp.length;
  }

  stats.outputSize = totalWrittenSize;
  stats.endTime = Date.now();
  onProgress({ ...stats });

  onLog(`Successfully packaged Dolby Vision file! Output size: ${totalWrittenSize} bytes.`, 'success');

  return {
    stats,
    outBuffer,
  };
}
