const { deviceIds } = require("./devices");

/** Contiguous, gap-free, overlap-free device slice for worker `id` of `workers`. */
const shardFor = (count, workers, id) => {
  const base = Math.floor(count / workers);
  const extra = count % workers;
  // First `extra` workers get one additional device so the split differs by
  // at most one, instead of dumping the remainder onto the last worker.
  const start = id * base + Math.min(id, extra);
  const size = base + (id < extra ? 1 : 0);
  return deviceIds(count).slice(start, start + size);
};

module.exports = { shardFor };
