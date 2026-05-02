import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "@/utils/logger";

ffmpeg.setFfmpegPath(ffmpegPath as string);

type WhisperPipeline = (input: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string }>;

function mimeToExt(mime: string): string {
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return ".mp4";
  if (mime.includes("mp3") || mime.includes("mpeg")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  return ".webm";
}

function mimeToFfmpegFormat(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "mp4";
  if (mime.includes("mp3") || mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

async function toWhisperWav(input: Buffer, mimeType = "audio/webm"): Promise<string> {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString("hex");
  const inPath = path.join(tmpDir, `whisper-in-${id}${mimeToExt(mimeType)}`);
  const outPath = path.join(tmpDir, `whisper-${id}.wav`);

  await fs.writeFile(inPath, input);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .inputOptions([`-f ${mimeToFfmpegFormat(mimeType)}`])
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec("pcm_s16le")
        .format("wav")
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  } finally {
    await fs.unlink(inPath).catch(() => undefined);
  }
  return outPath;
}

function wavToFloat32(wavBuffer: Buffer): Float32Array {
  let dataOffset = 44;
  for (let i = 12; i < wavBuffer.length - 8; i++) {
    if (wavBuffer.subarray(i, i + 4).toString("ascii") === "data") {
      dataOffset = i + 8;
      break;
    }
  }
  const pcm = wavBuffer.subarray(dataOffset);
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

class DesktopTranscriptionService {
  private _pipeline: WhisperPipeline | null = null;
  private _loading: Promise<WhisperPipeline> | null = null;
  private _modelsDir: string | undefined;

  setModelsDir(dir: string) {
    this._modelsDir = dir;
  }

  private async loadModel(): Promise<WhisperPipeline> {
    if (this._pipeline) return this._pipeline;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      if (process.env.ORT_LOG_SEVERITY_LEVEL === undefined) {
        process.env.ORT_LOG_SEVERITY_LEVEL = "3";
      }
      const { pipeline, env } = await import("@xenova/transformers");
      if (this._modelsDir) {
        env.localModelPath = this._modelsDir;
        env.allowRemoteModels = true;
      }
      env.backends.onnx.wasm.numThreads = 1;

      const modelId = "Xenova/whisper-tiny";
      logger.info(`[desktop] Loading Whisper model: ${modelId}`);
      const pipe = await pipeline("automatic-speech-recognition", modelId, {
        cache_dir: this._modelsDir,
        quantized: true,
      });
      this._pipeline = pipe as unknown as WhisperPipeline;
      logger.info("[desktop] Whisper model ready");
      return this._pipeline;
    })();

    try {
      return await this._loading;
    } catch (err) {
      this._loading = null;
      throw err;
    }
  }

  private _queue: Promise<unknown> = Promise.resolve();

  async transcribe(audioBuf: Buffer, lang: string, mimeType = "audio/webm"): Promise<string> {
    const doWork = async (): Promise<string> => {
      const wavPath = await toWhisperWav(audioBuf, mimeType);
      try {
        const wavBuf = await fs.readFile(wavPath);
        const samples = wavToFloat32(wavBuf);
        const pipe = await this.loadModel();
        const result = await pipe(samples, { language: lang, task: "transcribe" });
        return result.text.trim();
      } finally {
        await fs.unlink(wavPath).catch(() => undefined);
      }
    };

    const queued = this._queue.then(doWork, doWork);
    this._queue = queued.catch(() => undefined);
    return queued;
  }

  async warmup(): Promise<void> {
    try {
      await this.loadModel();
    } catch (err) {
      logger.warn(`[desktop] Whisper warmup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const desktopTranscriptionService = new DesktopTranscriptionService();
