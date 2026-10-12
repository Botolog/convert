import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import normalizeMimeType from "src/normalizeMimeType.ts";
import * as mb from "mediabunny";
import { changeExt } from "src/common/index.ts";

const FORMATS = new Map<string, [name: string, input: mb.InputFormat, output: mb.OutputFormat]>([
  ["mp4", ["MPEG-4 Part 14", mb.MP4, new mb.Mp4OutputFormat()]],
  ["mov", ["QuickTime / MOV", mb.QTFF, new mb.MovOutputFormat()]],
  ["matroska", ["Matroska / WebM", mb.MATROSKA, new mb.MkvOutputFormat()]],
  ["webm", ["Matroska / WebM / webm", mb.WEBM, new mb.WebMOutputFormat()]],
  ["wav", ["Waveform Audio File Format", mb.WAVE, new mb.WavOutputFormat()]],
  ["ogg", ["Ogg Audio", mb.OGG, new mb.OggOutputFormat()]],
  ["flac", ["Free Lossless Audio Codec", mb.FLAC, new mb.FlacOutputFormat()]],
  ["mp3", ["MP3 Audio", mb.MP3, new mb.Mp3OutputFormat()]],
  ["aac", ["raw ADTS AAC (Advanced Audio Coding)", mb.ADTS, new mb.AdtsOutputFormat()]],
  ["mpegts", ["MPEG-TS (MPEG-2 Transport Stream)", mb.MPEG_TS, new mb.MpegTsOutputFormat()]],
  // needs segmenting bs
  // ["m3u8", ["HTTP Live Streaming", mb.HLS, new mb.HlsOutputFormat({ segmentFormat: new mb.MpegTsOutputFormat() })]],
]);

const can = async <T>(items: T[], fn: (item: T) => Promise<boolean>) =>
  !items.length || (await Promise.all(items.map((item) => fn(item)))).some(Boolean);

const LAZY_ENCODERS = ["flac", "mp3", "aac"];

class mediabunnyHandler implements FormatHandler {
  public readonly name = "mediabunny";
  public supportedFormats: FileFormat[] = [];
  public ready = false;

  async init() {
    this.supportedFormats = [];
    for (const [format, [name, input, output]] of FORMATS) {
      const videoCodecs = output.getSupportedVideoCodecs();
      const audioCodecs = output.getSupportedAudioCodecs();

      const canDecodeVideo = await can(videoCodecs, mb.canDecodeVideo);
      const canEncodeVideo = await can(videoCodecs, mb.canEncodeVideo);
      const canDecodeAudio = await can(audioCodecs, mb.canDecodeAudio);
      const canEncodeAudio = await can(
        audioCodecs,
        async (c) => LAZY_ENCODERS.includes(c) || (await mb.canEncodeAudio(c)),
      );
      let category;
      let from, to;
      const tracks = output.getSupportedTrackCounts();
      if (tracks.video.max > 0) {
        category = Category.VIDEO;
        from = canDecodeAudio && canDecodeVideo;
        to = canEncodeAudio && canEncodeVideo;
      } else {
        category = Category.AUDIO;
        from = canDecodeAudio;
        to = canEncodeAudio;
      }

      this.supportedFormats.push({
        name,
        format,
        extension: output.fileExtension.slice(1),
        mime: normalizeMimeType(input.mimeType),
        from,
        to,
        internal: format,
        category,
        lossless: false,
      });
    }
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    const mbInputFormat = FORMATS.get(inputFormat.internal)?.[1];
    if (!mbInputFormat) throw new Error(`could not get format: ${inputFormat.internal}`);
    const mbOutputFormat = FORMATS.get(outputFormat.internal)?.[2];
    if (!mbOutputFormat) throw new Error(`could not get format: ${outputFormat.internal}`);
    const outAudioCodecs = mbOutputFormat.getSupportedAudioCodecs();
    if (outAudioCodecs.every((c) => LAZY_ENCODERS.includes(c))) {
      if (outAudioCodecs.includes("mp3") && !(await mb.canEncodeAudio("mp3"))) {
        const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
        registerMp3Encoder();
      } else if (outAudioCodecs.includes("flac") && !(await mb.canEncodeAudio("flac"))) {
        const { registerFlacEncoder } = await import("@mediabunny/flac-encoder");
        registerFlacEncoder();
      } else if (outAudioCodecs.includes("aac") && !(await mb.canEncodeAudio("aac"))) {
        const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
        registerAacEncoder();
      }
    }

    for (const [i, inputFile] of inputFiles.entries()) {
      ctx?.log(`Processing ${inputFile.name}...`);
      const source = new mb.BufferSource(inputFile.bytes);
      const input = new mb.Input({
        formats: [mbInputFormat],
        source,
      });
      const output = new mb.Output({
        format: mbOutputFormat,
        target: new mb.BufferTarget(),
      });
      const conversion = await mb.Conversion.init({ input, output });

      conversion.onProgress = (progress, seconds) => {
        ctx?.progress(
          `Transcoding... (${seconds.toFixed(1)}s processed)`,
          (i + progress) / inputFiles.length,
        );
      };

      await conversion.execute({
        pauseSignal: ctx?.signal,
      });

      ctx?.throwIfAborted();

      if (conversion.state !== "done" || !output.target.buffer)
        throw new Error("conversion isnt done after completing");

      const name = changeExt(inputFile.name, outputFormat.extension);

      outputFiles.push({ name, bytes: new Uint8Array(output.target.buffer) });
    }

    return outputFiles;
  }
}

export default mediabunnyHandler;
