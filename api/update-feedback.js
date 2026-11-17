// Counts 👍 / 👎 reactions per Schedulable release.
//   POST /api/update-feedback  { version, vote: "up" | "down", previous?: "up" | "down" }
//   GET  /api/update-feedback               -> counts for every version
//   GET  /api/update-feedback?version=1.6.0 -> counts for one version
// Storage: Upstash Redis (Vercel Marketplace). Needs KV_REST_API_URL + KV_REST_API_TOKEN
// (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) in the project's env vars.

const REDIS_URL =
  process.env.SCHEDULABLE_KV_REST_API_URL ||
  process.env.SCHEDULABLE_UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.SCHEDULABLE_KV_REST_API_TOKEN ||
  process.env.SCHEDULABLE_UPSTASH_REDIS_REST_TOKEN;

const VERSION_RE = /^[\w.\-]{1,32}$/;
const VOTES = ["up", "down"];
const VERSIONS_SET = "schedulable:feedback:versions";
const keyFor = (version) => `schedulable:feedback:${version}`;

async function redis(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json();
}

function toCounts(flatHash) {
  const counts = { up: 0, down: 0 };
  const arr = Array.isArray(flatHash) ? flatHash : [];
  for (let i = 0; i < arr.length; i += 2) {
    if (VOTES.includes(arr[i]))
      counts[arr[i]] = Math.max(0, Number(arr[i + 1]) || 0);
  }
  return counts;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res
      .status(503)
      .json({ ok: false, error: "Feedback storage not configured" });
  }

  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      const { version, vote, previous } = body || {};

      if (!VERSION_RE.test(String(version || "")) || !VOTES.includes(vote)) {
        return res.status(400).json({ ok: false, error: "Invalid vote" });
      }
      if (previous === vote) return res.status(200).json({ ok: true });

      const commands = [
        ["SADD", VERSIONS_SET, version],
        ["HINCRBY", keyFor(version), vote, 1],
      ];
      if (VOTES.includes(previous)) {
        commands.push(["HINCRBY", keyFor(version), previous, -1]);
      }
      await redis(commands);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const one = req.query && req.query.version;
      if (one) {
        if (!VERSION_RE.test(String(one))) {
          return res.status(400).json({ ok: false, error: "Invalid version" });
        }
        const [{ result }] = await redis([["HGETALL", keyFor(one)]]);
        return res
          .status(200)
          .json({ ok: true, version: one, ...toCounts(result) });
      }

      const [{ result: versions }] = await redis([["SMEMBERS", VERSIONS_SET]]);
      const list = Array.isArray(versions) ? versions.sort() : [];
      const hashes = list.length
        ? await redis(list.map((v) => ["HGETALL", keyFor(v)]))
        : [];
      const results = list.map((v, i) => ({
        version: v,
        ...toCounts(hashes[i].result),
      }));
      return res.status(200).json({ ok: true, results });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Feedback storage error" });
  }
};
