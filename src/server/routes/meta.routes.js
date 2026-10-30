/**
 * 元数据接口：把「参数 / 枚举 / 文案」一次性交给浏览器。
 *
 * 为什么要有它：前端不参与构建，无法 require 服务端的 JSON；
 * 有了这个接口，阈值与文案只有一份（shared/），改一处两端同时生效。
 */

const express = require("express");

const data = require("../data");
const { ok } = require("../shared/http");

const router = express.Router();

router.get("/api/meta", (req, res) => ok(res, { meta: data.clientMeta() }));

module.exports = { router };
