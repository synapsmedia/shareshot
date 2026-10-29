const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { HttpError } = require('./errors');
const { version } = require('../../package.json');

/**
 * Templates render whatever URLs their variables contain (such as images),
 * and sources fetch the URLs they are given, so neither may become a way
 * into the network this server runs in. Every outside request goes through
 * requestPublic, which connects only to public addresses: a host name is
 * resolved once, checked, and the connection made to the address that
 * passed, so a second lookup can't swap in a private one. Each redirect is
 * checked the same way. ALLOW_PRIVATE_NETWORKS=1 turns this off, e.g. to
 * render a Ghost site on a local network.
 */
const { ALLOW_PRIVATE_NETWORKS } = process.env;
const allowPrivate = ALLOW_PRIVATE_NETWORKS === '1';

const MAX_REDIRECTS = 3;
const USER_AGENT = `Shareshot/${version} (+https://github.com/synapsmedia/shareshot)`;

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

function refuse(hostname) {
  return new HttpError(400, `Refusing to reach ${hostname}: not a public address`);
}

/** dns.lookup for outgoing connections, failing when the host resolves to any private address. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      return callback(refuse(hostname));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** One request, without following redirects; the body is read up to maxBytes. */
function requestOnce(url, { maxBytes, signal, headers }) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(hostname) && isPrivateAddress(hostname)) return reject(refuse(hostname));

    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      signal,
      lookup: allowPrivate ? undefined : publicLookup,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
    }, response => {
      const length = Number(response.headers['content-length']);
      if (length > maxBytes) {
        response.destroy();
        return reject(new HttpError(502, `${url.origin} answered with ${length} bytes, more than ${maxBytes}`));
      }

      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          return reject(new HttpError(502, `${url.origin} answered with more than ${maxBytes} bytes`));
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

/**
 * GETs a public http(s) URL, following up to 3 redirects. Resolves to
 * { url, status, headers, body }; rejects with an HttpError for a private
 * address, a body over maxBytes, or no answer within timeoutMs.
 */
async function requestPublic(input, { maxBytes, timeoutMs, headers = {} }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(input);

  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError(400, `Refusing to fetch ${url.protocol} URLs`);
    }

    let response;
    try {
      response = await requestOnce(url, { maxBytes, signal, headers });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const reason = signal.aborted ? `no answer within ${timeoutMs / 1000} s` : error.code || error.message;
      throw new HttpError(502, `Couldn't reach ${url.origin}: ${reason}`);
    }

    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location) return { url: url.toString(), ...response };
    if (redirects === MAX_REDIRECTS) throw new HttpError(502, `Too many redirects from ${url.origin}`);
    url = new URL(location, url);
  }
}

const SOURCE_FETCH_TIMEOUT_MS = 10_000;
const SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/** `fetch` for sources: GET only, through requestPublic, resolving to a standard Response. */
async function fetchPublic(url, { headers } = {}) {
  const response = await requestPublic(url, { maxBytes: SOURCE_MAX_BYTES, timeoutMs: SOURCE_FETCH_TIMEOUT_MS, headers });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const empty = [204, 205, 304].includes(response.status);
  return new Response(empty ? null : response.body, { status: response.status, headers: responseHeaders });
}

module.exports = { isPrivateAddress, requestPublic, fetchPublic };
