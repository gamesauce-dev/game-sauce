// Downloading a file from an address that came from outside: a metadata provider, something stored earlier, or a person's pick.
// The server sits inside the owner's network, so such an address must never reach the server itself or anything at home.
//  - Only http and https. Only public addresses, checked at the moment of connecting (so a name cannot pass a check and then point elsewhere).
//  - Redirects are followed by hand, and each one is checked like the first address.
//  - The download stops as soon as it goes over the size limit.
// Two kinds of host are allowed to be on a private network because the owner named them in the server's settings: SS_API_BASE, and any in
// GAMESAUCE_FETCH_ALLOW_HOSTS (comma separated, "host" or "host:port"; for a mirror on the home network, or a DNS tool that answers with private addresses).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_REDIRECTS = 5;

const refused = (message) => Object.assign(new Error(message), { blocked: true });

const specialV4 = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10] /* carrier NAT, and Tailscale */, ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) specialV4.addSubnet(addr, bits, 'ipv4');
// For IPv6 it is safer to say what is allowed: ordinary global addresses, less the ranges inside them that wrap or stand for something else.
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
for (const [addr, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) specialV6.addSubnet(addr, bits, 'ipv6');

/** Is this IP address one on the public internet? */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !specialV4.check(address, 'ipv4');
  if (family === 6) return !address.includes('%') && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
  return false;
}

function ownerAllows(url) {
  const named = String(process.env.GAMESAUCE_FETCH_ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (named.includes(url.host.toLowerCase()) || named.includes(url.hostname.toLowerCase())) return true;
  try { return Boolean(process.env.SS_API_BASE) && url.host === new URL(process.env.SS_API_BASE).host; } catch { return false; }
}

// Used for the connection itself: every address the name stands for must be public.
export function publicLookup(hostname, options, callback, resolve = dns.lookup) {
  resolve(hostname, { ...options, all: true }, (err, found) => {
    if (err) return callback(err);
    if (!found.length || found.some((a) => !isPublicAddress(a.address))) return callback(refused('That address is on a private network: not allowed'));
    return options.all ? callback(null, found) : callback(null, found[0].address, found[0].family);
  });
}

function once(url, { headers, signal }) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refused('Only web addresses are allowed: not allowed');
  if (url.username || url.password) throw refused('An address with a sign-in inside it is not allowed');
  const trusted = ownerAllows(url);
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (!trusted && net.isIP(literal) && !isPublicAddress(literal)) throw refused('That address is on a private network: not allowed');   // an address written as numbers is never looked up
  return new Promise((resolve, reject) => {
    const lookup = (hostname, options, callback) => publicLookup(hostname, options, callback);
    const req = (url.protocol === 'https:' ? https : http).request(url, { headers, signal, agent: false, ...(trusted ? {} : { lookup }) }, resolve);
    req.on('error', reject);
    req.end();
  });
}

function readBody(res, maxBytes) {
  const tooBig = () => Object.assign(new Error('the file is over the size limit'), { tooBig: true });
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  if (!encoding && Number(res.headers['content-length']) > maxBytes) { res.destroy(); return Promise.reject(tooBig()); }
  const unpack = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'br' ? zlib.createBrotliDecompress() : encoding === 'deflate' ? zlib.createInflate() : null;
  const from = unpack ? res.pipe(unpack) : res;
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const stop = (err) => { reject(err); res.destroy(); unpack?.destroy(); };   // the reason first: closing the download reports a "cut off" of its own
    from.on('data', (c) => { size += c.length; if (size > maxBytes) stop(tooBig()); else chunks.push(c); });
    from.on('end', () => resolve(Buffer.concat(chunks)));
    from.on('error', stop);
    if (unpack) res.on('error', stop);
    res.on('aborted', () => stop(new Error('the download was cut off')));
  });
}

/**
 * Download one file. Returns { ok, status, body } (body only when ok). Throws for an address that is not allowed (err.blocked),
 * a file over maxBytes (err.tooBig), too many redirects, a timeout or a network failure. No message it throws holds the address.
 */
export async function fetchRemote(address, { maxBytes, timeoutMs = 20000, userAgent = 'game-sauce' } = {}) {
  if (!(maxBytes > 0)) throw new Error('A size limit is required');
  const signal = AbortSignal.timeout(timeoutMs);
  let url;
  try { url = new URL(address); } catch { throw refused('That is not a web address: not allowed'); }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await once(url, { headers: { 'User-Agent': userAgent }, signal });
    const status = res.statusCode;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.destroy();
      try { url = new URL(res.headers.location, url); } catch { throw refused('A redirect to something that is not a web address: not allowed'); }
      continue;
    }
    if (status < 200 || status >= 300) { res.destroy(); return { ok: false, status, body: null }; }
    return { ok: true, status, body: await readBody(res, maxBytes) };
  }
  throw refused('Too many redirects');
}

/* ───────── a match picked in the browser ───────── */

// The identify search offers matches from TheGamesDB, IGDB and LaunchBox, and the page sends the picked one back. By then it is only what the browser says it is,
// so its picture addresses are accepted only when they are where those services keep pictures.
const PICTURE_HOSTS = [/(^|\.)thegamesdb\.net$/, /^images\.igdb\.com$/, /^images\.launchbox-app\.com$/];
const URL_FIELDS = ['cover_url', 'spine_url', 'disc_url', 'back_url'];

function fromSearchService(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PICTURE_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

/** A copy of a picked match with every picture address that is not from a search service taken out. The rest of the details stay. */
export function pickedCandidate(candidate) {
  const out = { ...candidate };
  for (const f of URL_FIELDS) if (out[f] !== undefined && !fromSearchService(out[f])) delete out[f];
  const media = out.media && typeof out.media === 'object' ? out.media : {};
  out.media = Object.fromEntries(Object.entries(media).filter(([, v]) => fromSearchService(v)));
  return out;
}
