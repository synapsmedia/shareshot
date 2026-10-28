const dns = require('dns').promises;
const net = require('net');
const { selfOrigin } = require('./server');
const { HttpError } = require('./errors');

/**
 * Templates render whatever URLs their variables contain (such as images),
 * and sources fetch the URLs they are given, so neither may
 * become a way into the network this server runs in. Requests to private,
 * loopback and link-local addresses are refused, except the browser's to this
 * server itself. ALLOW_PRIVATE_NETWORKS=1 turns this off, e.g. to render a
 * Ghost site on a local network.
 */
const { ALLOW_PRIVATE_NETWORKS } = process.env;

const SOURCE_FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const privateNetworks = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
]) {
  privateNetworks.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
  privateNetworks.addSubnet(address, prefix, 'ipv6');
}

function isPrivateAddress(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return privateNetworks.check(mapped[1], 'ipv4');
  return privateNetworks.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/** An http(s) URL whose host resolves only to public addresses. */
async function isPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (ALLOW_PRIVATE_NETWORKS === '1') return true;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname)
    ? [hostname]
    : await dns.lookup(hostname, { all: true }).then(results => results.map(r => r.address)).catch(() => []);

  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

/** What the browser may load while rendering: public URLs, inline data and this server. */
async function isAllowedRequest(url) {
  if (/^(data|blob):/i.test(url)) return true;
  if (url.startsWith(`${selfOrigin}/`)) return true;
  return isPublicUrl(url);
}

/**
 * `fetch` for sources: public URLs only, every redirect checked again, and a
 * timeout, since the URL comes from whoever requests the image.
 */
async function fetchPublic(url, init = {}) {
  const signal = AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS);

  for (let redirects = 0; ; redirects++) {
    if (!(await isPublicUrl(url))) {
      throw new HttpError(400, `Refusing to fetch ${new URL(url).origin}: not a public http(s) address`);
    }

    const response = await fetch(url, { ...init, signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (redirects === MAX_REDIRECTS) throw new HttpError(502, `Too many redirects from ${new URL(url).origin}`);

    url = new URL(location, url).toString();
  }
}

module.exports = { isAllowedRequest, isPrivateAddress, isPublicUrl, fetchPublic };
