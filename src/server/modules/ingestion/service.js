/**
 * 建任务：探测 → 拦截 → 建 job → 搬进任务目录 → 入队。
 *
 * 源文件搬进 jobs/<id>/ 是为了按任务清理与回放；跨设备 rename 失败时退回原路径也能跑。
 */

const fs = require("node:fs");
const path = require("node:path");

const { probeAndValidate } = require("./validate-file");
const { decodeFilename } = require("./upload.middleware");
const repos = require("../../data/db/repositories");
const { enqueue, detectSourceType, JOBS_DIR } = require("../transcription");
const { engines, limits } = require("../../data");

const { createJob, updateJob } = repos.jobs;

/**
 * @param {{file: Express.Multer.File, body: object}} input
 * @returns {Promise<{jobId:string, duration:number, size:number, chunks:number}>}
 */
async function createJobFromUpload({ file, body = {} }) {
  const srcPath = file.path;
  const filename = decodeFilename(file.originalname);
  const language = body.language || engines.defaults.language;
  const diarize = body.diarize === "true" || body.diarize === true;
  const speakerCount = Number(body.speakerCount) || null;
  // 转写与纪要拆分后：audio 任务只负责转写，是否接着生成纪要由 autoMinutes 决定
  const autoMinutes = body.autoMinutes === "true" || body.autoMinutes === true;
  const templateId = body.templateId ? String(body.templateId) : null;
  const output = autoMinutes ? "summary" : "transcript";

  try {
    const meta = await probeAndValidate(srcPath, { diarize });

    const job = createJob({
      sourceType: detectSourceType(filename),
      filePath: srcPath,
      filename,
      size: file.size,
      durationMs: Math.round(meta.durationSec * 1000),
      output,
      language,
      engine: diarize ? "bailian_filetrans" : "mimo",
      templateId,
      autoMinutes,
      options: { diarize, speakerCount: diarize ? speakerCount : null },
    });

    // 源文件搬进任务目录，便于按任务清理与回放
    const jobDir = path.join(JOBS_DIR, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const moved = path.join(jobDir, path.basename(srcPath));
    try {
      fs.renameSync(srcPath, moved);
      updateJob(job.id, { file_path: moved });
    } catch {
      // 跨设备重命名会失败，退回原路径也能跑
    }

    enqueue(job.id);

    return {
      jobId: job.id,
      duration: Math.round(meta.durationSec),
      size: file.size,
      chunks: Math.ceil(meta.durationSec / limits.transcribe.chunkSec),
    };
  } catch (err) {
    try {
      if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
    } catch {}
    console.error("创建任务失败:", err);
    throw err;
  }
}

module.exports = { createJobFromUpload };
