const test = require('node:test');
const assert = require('node:assert');
const { signUrl, checkSignature, keysFromEnv, canonicalString } = require('../src/core/signing');

const keys = keysFromEnv('main:s3cret, old:0ld');
const signingKey = async kid => keys.get(kid) ?? null;

test('keysFromEnv reads kid:secret pairs, and secrets may contain colons', () => {
  assert.deepStrictEqual([...keysFromEnv('a:b, c:d:e')], [['a', 'b'], ['c', 'd:e']]);
  assert.throws(() => keysFromEnv('nosecret'));
});

test('the canonical string sorts parameters and leaves sig out', () => {
  const params = new URLSearchParams('title=Hello world&kid=main&sig=x&a=2&a=1');
  assert.strictEqual(canonicalString('/image/article', params), '/image/article?a=1&a=2&kid=main&title=Hello%20world');
});

test('a signed URL checks out, in any parameter order', async () => {
  const signed = signUrl('/image/article?title=Hello&width=1080', { kid: 'main', secret: 's3cret' });
  assert.strictEqual(await checkSignature(signed, signingKey), 'valid');

  const url = new URL(signed, 'http://x');
  const reordered = `/image/article?sig=${url.searchParams.get('sig')}&width=1080&kid=main&title=Hello`;
  assert.strictEqual(await checkSignature(reordered, signingKey), 'valid');
});

test('signing keeps an absolute URL absolute', () => {
  assert.match(signUrl('https://img.example.com/image/a?title=x', { kid: 'main', secret: 's3cret' }), /^https:\/\/img\.example\.com\/image\/a\?title=x&kid=main&sig=[0-9a-f]{64}$/);
});

test('changed parameters, another template, an unknown kid or no kid are invalid', async () => {
  const signed = signUrl('/image/article?title=Hello', { kid: 'main', secret: 's3cret' });
  assert.strictEqual(await checkSignature(signed.replace('Hello', 'Bye'), signingKey), 'invalid');
  assert.strictEqual(await checkSignature(signed.replace('/article', '/split'), signingKey), 'invalid');
  assert.strictEqual(await checkSignature(signed.replace('kid=main', 'kid=nope'), signingKey), 'invalid');
  assert.strictEqual(await checkSignature(signed.replace('kid=main&', ''), signingKey), 'invalid');
  assert.strictEqual(await checkSignature(signed.replace(/sig=[0-9a-f]+/, 'sig=00'), signingKey), 'invalid');
});

test('a URL without sig is unsigned', async () => {
  assert.strictEqual(await checkSignature('/image/article?title=Hello&kid=main', signingKey), 'unsigned');
});
