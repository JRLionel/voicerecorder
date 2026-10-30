/**
 * 实时录音域门面：WS 网关 + 会话状态机 + 收尾落库。
 */

const { attachRealtime } = require("./gateway");
const { RecordSession } = require("./session");
const { finalizeRecording } = require("./finalize");

module.exports = { attachRealtime, RecordSession, finalizeRecording };
