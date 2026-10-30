/** 并发池：共享游标，按片推进。 */

/** 就地并发处理，不收集返回值（转写切片、map 阶段摘要） */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const size = Math.min(limit, items.length);
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/** 并发处理并按下标收集结果（CLI 批处理） */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  await runPool(items, limit, async (item, index) => {
    results[index] = await worker(item, index);
  });
  return results;
}

module.exports = { runPool, mapPool };
