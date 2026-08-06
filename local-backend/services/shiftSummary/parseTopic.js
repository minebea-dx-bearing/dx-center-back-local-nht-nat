/**
 * Split an MQTT topic of the form `data/hat/${process}/${mc_no}`.
 *
 * Returns null rather than partial data on any unexpected shape: process and
 * mc_no together form part of the primary key, so a malformed topic must be
 * dropped, not written with empty key columns.
 *
 * @param {string} topic
 * @returns {{process: string, mc_no: string} | null}
 */
const parseTopic = (topic) => {
  const parts = String(topic || "").split("/");
  if (parts.length !== 4) return null;

  const [, , process, mc_no] = parts;
  if (!process || !mc_no) return null;

  return { process, mc_no };
};

module.exports = { parseTopic };
