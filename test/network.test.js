const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { isPrivateAddress, requestPublic } = require('../src/core/network');

test('private, loopback and link-local addresses are recognised', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateAddress(address), address);
  }
  for (const address of ['1.1.1.1', '188.245.171.201', '2a01:4f8::1']) {
    assert.ok(!isPrivateAddress(address), address);
  }
});

test('requestPublic refuses private addresses, by IP and by name', async () => {
  await assert.rejects(requestPublic('http://127.0.0.1:9/x', { maxBytes: 100, timeoutMs: 2000 }), { status: 400 });
  await assert.rejects(requestPublic('http://localhost:9/x', { maxBytes: 100, timeoutMs: 2000 }), { status: 400 });
  await assert.rejects(requestPublic('http://[::1]:9/x', { maxBytes: 100, timeoutMs: 2000 }), { status: 400 });
  await assert.rejects(requestPublic('file:///etc/passwd', { maxBytes: 100, timeoutMs: 2000 }), { status: 400 });
});

test('requestPublic follows redirects, and stops at maxBytes', async t => {
  // A local server stands in for a public one; ALLOW_PRIVATE_NETWORKS is read
  // at load, so this part runs in a child process with it on.
  const server = http.createServer((req, res) => {
    if (req.url === '/big') return res.end('x'.repeat(1000));
    if (req.url === '/moved') return res.writeHead(302, { location: '/small' }).end();
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const { promisify } = require('util');
  const execFile = promisify(require('child_process').execFile);
  const run = async url => (await execFile(process.execPath, ['-e', `
    require('./src/core/network').requestPublic(${JSON.stringify(url)}, { maxBytes: 100, timeoutMs: 2000 })
      .then(r => console.log(r.status, r.body.toString()), e => console.log(e.status, e.message))`],
  { env: { ...process.env, ALLOW_PRIVATE_NETWORKS: '1' }, cwd: require('path').join(__dirname, '..') })).stdout.trim();

  assert.strictEqual(await run(`http://127.0.0.1:${port}/small`), '200 ok');
  assert.strictEqual(await run(`http://127.0.0.1:${port}/moved`), '200 ok');
  assert.match(await run(`http://127.0.0.1:${port}/big`), /^502 .*more than 100/);
});
