const fs = require("node:fs");
const path = require("node:path");

const HEADER_BYTES = 44;

/**
 * 录音落盘。
 *
 * 录音开始时就打开文件、先写一个长度占位的标准 WAV 头，之后逐帧追加 PCM，
 * 结束时用固定偏移回填两个长度字段——不整文件拷贝（1 小时 115MB，没必要）。
 *
 * 为什么不先在内存攒：1 小时 16k/16bit 是 115MB，攒在内存里既浪费又怕 OOM。
 */
class RecordingSink {
  constructor(filePath, { sampleRate = 16000, channels = 1, bits = 16 } = {}) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bits = bits;
    this.bytes = 0;
    this.closed = false;
    this.stream = null;
  }

  header() {
    const buf = Buffer.alloc(HEADER_BYTES);
    const byteRate = (this.sampleRate * this.channels * this.bits) / 8;
    const blockAlign = (this.channels * this.bits) / 8;

    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(0xffffffff, 4);            // 占位，结束时回填
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);                   // fmt chunk 长度
    buf.writeUInt16LE(1, 20);                    // PCM
    buf.writeUInt16LE(this.channels, 22);
    buf.writeUInt32LE(this.sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(this.bits, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(0xffffffff, 40);           // 占位，结束时回填
    return buf;
  }

  open() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, this.header());
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.stream.on("error", (e) => {
      // 落盘失败不该拖垮转写：音频只是附属产物
      console.error(`[recorder] 写入失败 ${this.filePath}: ${e.message}`);
    });
    return this;
  }

  write(buf) {
    if (this.closed || !this.stream) return;
    if (!buf || !buf.length) return;
    this.bytes += buf.length;
    this.stream.write(buf);
  }

  /** 结束写入并回填头部长度，返回最终时长（毫秒） */
  async finalize() {
    if (this.closed) return this.durationMs();
    this.closed = true;

    if (this.stream) {
      await new Promise((resolve) => {
        this.stream.end(() => resolve());
        this.stream.on("error", () => resolve());
      });
    }

    try {
      const fd = fs.openSync(this.filePath, "r+");
      try {
        const riff = Buffer.alloc(4);
        riff.writeUInt32LE(Math.max(0, HEADER_BYTES + this.bytes - 8), 0);
        fs.writeSync(fd, riff, 0, 4, 4);

        const data = Buffer.alloc(4);
        data.writeUInt32LE(this.bytes, 0);
        fs.writeSync(fd, data, 0, 4, 40);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      console.error(`[recorder] 回填 WAV 头失败: ${e.message}`);
    }

    return this.durationMs();
  }

  durationMs() {
    const byteRate = (this.sampleRate * this.channels * this.bits) / 8;
    return Math.round((this.bytes / byteRate) * 1000);
  }

  /** 中断：立刻停写并删除半截文件 */
  abort() {
    this.closed = true;
    try { this.stream && this.stream.destroy(); } catch {}
    try { fs.existsSync(this.filePath) && fs.unlinkSync(this.filePath); } catch {}
  }
}

/** 给定时长估算 WAV 体积，用于磁盘提示 */
function estimateWavBytes(durationMs, { sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  return Math.round((durationMs / 1000) * (sampleRate * channels * bits) / 8);
}

module.exports = { RecordingSink, estimateWavBytes, HEADER_BYTES };
