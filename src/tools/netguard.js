// Network guard for WebFetch: decides which addresses a fetch may touch and pins the connection to the
// address that was checked (no second DNS lookup between the check and the connect).
import net from "node:net";
import dns from "node:dns";

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const v4ToInt = ip => ip.split(".").reduce((n, part) => (n * 256) + Number(part), 0);
const inBlock = (ip, [base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4ToInt(base);
  const value = v4ToInt(ip);
  return value >= start && value < start + size;
};

function parseV6(address) {
  let text = address.split("%")[0].toLowerCase();
  let tail = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    text = text.slice(0, -dotted[1].length) + "0:0";
  }
  const [headText, rest] = text.split("::");
  const head = headText ? headText.split(":").map(h => parseInt(h || "0", 16)) : [];
  const back = rest !== undefined && rest ? rest.split(":").map(h => parseInt(h || "0", 16)) : [];
  const groups = rest === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - back.length)).fill(0), ...back];
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when a fetch must not reach this address (loopback, private, link-local, metadata, multicast, ...). */
export function isBlockedAddress(address, { allowLoopback = false } = {}) {
  if (net.isIPv4(address)) {
    if (allowLoopback && address.startsWith("127.")) return false;
    return V4_BLOCKS.some(block => inBlock(address, block)) || address === "255.255.255.255";
  }
  if (!net.isIPv6(address)) return true;
  const g = parseV6(address);
  if (!g) return true;
  if (g.every(x => x === 0)) return true;
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return !allowLoopback;
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedAddress(v4FromGroups(g[6], g[7]), { allowLoopback });
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedAddress(v4FromGroups(g[6], g[7]), { allowLoopback });
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  if (g[0] === 0x2002) return isBlockedAddress(v4FromGroups(g[1], g[2]), { allowLoopback });
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

/** Names that mean "this machine or this network" whatever DNS says. */
export function isBlockedHostname(host, { allowLoopback = false } = {}) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (net.isIP(name)) return false; // judged by address
  if (name === "localhost" || name.endsWith(".localhost")) return !allowLoopback;
  if (!name.includes(".")) return true; // single-label names resolve through the local network's search domains
  return /(^|\.)(local|localdomain|internal|intranet|lan|home|corp|private)$/.test(name) || name === "home.arpa" || name.endsWith(".home.arpa") || name === "metadata.google.internal";
}

/** A host as written in a URL: blocked by name, or an IP literal in a blocked range. */
export function isBlockedHost(host, { allowLoopback = false } = {}) {
  const name = String(host).replace(/^\[|\]$/g, "");
  if (net.isIP(name)) return isBlockedAddress(name, { allowLoopback });
  return isBlockedHostname(name, { allowLoopback });
}

/**
 * Resolves `hostname` and checks every address. Returns { ok:true, address, family } for the first
 * address, or { ok:false, reason } (reason: "blocked" | "dns").
 */
export async function resolvePublic(hostname, { allowLoopback = false, lookup = dns.promises.lookup } = {}) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host, { allowLoopback })) return { ok: false, reason: "blocked" };
  if (net.isIP(host)) return isBlockedAddress(host, { allowLoopback }) ? { ok: false, reason: "blocked" } : { ok: true, address: host, family: net.isIPv6(host) ? 6 : 4 };
  let answers;
  try { answers = await lookup(host, { all: true, verbatim: true }); }
  catch { return { ok: false, reason: "dns" }; }
  if (!Array.isArray(answers) || !answers.length) return { ok: false, reason: "dns" };
  if (answers.some(a => isBlockedAddress(a.address, { allowLoopback }))) return { ok: false, reason: "blocked" };
  return { ok: true, address: answers[0].address, family: answers[0].family };
}
