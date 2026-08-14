import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  HostingEvidenceMismatch,
  assertStrictScriptCsp,
  readLiveHostingEvidence,
} from './hosting-deployment-evidence.mjs';

const CSP = "default-src 'self'; script-src 'self' " +
  'https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; ' +
  "media-src 'self' data: blob: https://firebasestorage.googleapis.com; " +
  'frame-src https://www.google.com/recaptcha/ ' +
  'https://recaptcha.google.com/recaptcha/ https://www.youtube-nocookie.com; ' +
  "script-src-attr 'none'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'";
const sha256 = value => createHash('sha256').update(value).digest('hex');

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attendance-hosting-evidence-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  const files = new Map([
    ['/index.html', Buffer.from(
      '<!doctype html><script type="module" src="/assets/app.js"></script>'
    )],
    ['/assets/app.js', Buffer.from('console.log("fixture");\n')],
    ['/sw.js', Buffer.from('self.addEventListener("fetch", () => {});\n')],
  ]);
  await Promise.all([...files].map(([path, bytes]) =>
    writeFile(join(dist, path.slice(1)), bytes)
  ));
  const firebaseConfig = {
    hosting: {
      public: 'dist',
      rewrites: [{ source: '**', destination: '/index.html' }],
      headers: [
        {
          source: '**',
          headers: [{ key: 'Content-Security-Policy', value: CSP }],
        },
        {
          source: '/assets/**',
          headers: [{
            key: 'Cache-Control',
            value: 'public,max-age=31536000,immutable',
          }],
        },
        {
          source: '/sw.js',
          headers: [{ key: 'Cache-Control', value: 'no-cache' }],
        },
        {
          source: '/index.html',
          headers: [{
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          }],
        },
      ],
    },
  };
  const configPath = join(root, 'firebase.json');
  await writeFile(configPath, JSON.stringify(firebaseConfig));
  const deployedFiles = [
    ...[...files].map(([path, bytes]) => ({
      path,
      hash: sha256(bytes),
      status: 'ACTIVE',
    })),
    {
      path: '/__/firebase/init.js',
      hash: '1'.repeat(64),
      status: 'ACTIVE',
    },
    {
      path: '/__/firebase/init.json',
      hash: '2'.repeat(64),
      status: 'ACTIVE',
    },
  ];
  const versionConfig = {
    headers: firebaseConfig.hosting.headers.map(entry => ({
      glob: entry.source,
      headers: Object.fromEntries(entry.headers.map(header => [
        header.key,
        header.value,
      ])),
    })),
    rewrites: [{ glob: '**', path: '/index.html' }],
  };
  const channel = {
    name: 'projects/test-project/sites/test-project/channels/live',
    url: 'https://test-project.web.app',
    updateTime: '2026-07-23T00:00:00Z',
    release: {
      name: 'projects/test-project/sites/test-project/channels/live/releases/1',
      type: 'DEPLOY',
      version: {
        name: 'projects/test-project/sites/test-project/versions/version-1',
        status: 'FINALIZED',
        fileCount: String(deployedFiles.length),
        config: versionConfig,
      },
    },
  };
  const api = async url => {
    if (url.includes('/channels/live')) return structuredClone(channel);
    if (url.includes('/versions/version-1/files?')) {
      return { files: structuredClone(deployedFiles) };
    }
    throw new Error(`Unexpected API URL: ${url}`);
  };
  return {
    root,
    files,
    deployedFiles,
    channel,
    api,
    options: {
      api,
      projectId: 'test-project',
      distUrl: pathToFileURL(`${dist}/`),
      firebaseConfigUrl: pathToFileURL(configPath),
    },
  };
};

test('strict CSP rejects executable inline script policy', () => {
  assert.throws(
    () => assertStrictScriptCsp(CSP.replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-inline'"
    )),
    error => error instanceof HostingEvidenceMismatch &&
      error.code === 'HOSTING_CSP_SCRIPT_POLICY_INVALID'
  );
});

test('strict CSP requires the exact deliverable media and frame origins', () => {
  assert.doesNotThrow(() => assertStrictScriptCsp(CSP));
  assert.throws(
    () => assertStrictScriptCsp(CSP.replace(
      ' https://firebasestorage.googleapis.com',
      ''
    )),
    error => error instanceof HostingEvidenceMismatch &&
      error.code === 'HOSTING_CSP_MEDIA_POLICY_INVALID'
  );
  assert.throws(
    () => assertStrictScriptCsp(CSP.replace(
      ' https://www.youtube-nocookie.com',
      ''
    )),
    error => error instanceof HostingEvidenceMismatch &&
      error.code === 'HOSTING_CSP_FRAME_POLICY_INVALID'
  );
  assert.throws(
    () => assertStrictScriptCsp(CSP.replace(
      'https://www.youtube-nocookie.com',
      'https:'
    )),
    error => error instanceof HostingEvidenceMismatch &&
      error.code === 'HOSTING_CSP_FRAME_POLICY_INVALID'
  );
});

test('firebase Hosting config carries the strict deliverable CSP allowlists', async () => {
  const firebaseConfig = JSON.parse(await readFile(
    new URL('../../firebase.json', import.meta.url),
    'utf8'
  ));
  const csp = firebaseConfig.hosting.headers
    .find(entry => entry.source === '**')?.headers
    .find(header => header.key.toLowerCase() === 'content-security-policy')?.value;

  assert.doesNotThrow(() => assertStrictScriptCsp(csp));
  assert.match(csp, /media-src[^;]*https:\/\/firebasestorage\.googleapis\.com(?:[;\s]|$)/);
  assert.match(csp, /frame-src[^;]*https:\/\/www\.youtube-nocookie\.com(?:[;\s]|$)/);
});

test('live Hosting evidence accepts omitted advisory fileCount', async () => {
  const data = await fixture();
  delete data.channel.release.version.fileCount;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async value => {
    const url = new URL(value);
    const bytes = data.files.get(url.pathname);
    const deployed = data.deployedFiles.find(file => file.path === url.pathname);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Cache-Control': url.pathname === '/index.html'
          ? 'no-cache, no-store, must-revalidate'
          : url.pathname === '/sw.js'
            ? 'no-cache'
            : 'public,max-age=31536000,immutable',
        'Content-Security-Policy': CSP,
        ETag: `"${deployed.hash}"`,
      },
    });
  };
  try {
    const evidence = await readLiveHostingEvidence(data.options);
    assert.equal(evidence.hostingFileCount, data.deployedFiles.length);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(data.root, { recursive: true, force: true });
  }
});

test('live Hosting evidence binds config, manifest, ETags, and exact bytes', async () => {
  const data = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async value => {
    const url = new URL(value);
    const bytes = data.files.get(url.pathname);
    assert.ok(bytes, `Unexpected fetch path: ${url.pathname}`);
    const deployed = data.deployedFiles.find(file => file.path === url.pathname);
    const cacheControl = url.pathname === '/index.html'
      ? 'no-cache, no-store, must-revalidate'
      : url.pathname === '/sw.js'
        ? 'no-cache'
        : 'public,max-age=31536000,immutable';
    const compressedSuffix = url.pathname === '/assets/app.js' ? '-br' : '';
    return new Response(bytes, {
      status: 200,
      headers: {
        'Cache-Control': cacheControl,
        'Content-Security-Policy': CSP,
        ETag: `"${deployed.hash}${compressedSuffix}"`,
      },
    });
  };
  try {
    const evidence = await readLiveHostingEvidence(data.options);
    assert.equal(evidence.verifiedPublicFiles, 3);
    assert.equal(evidence.hostingFileCount, 5);
    assert.equal(evidence.internalHostingFiles, 2);
    assert.equal(evidence.strictScriptCsp, true);
    for (const [key, value] of Object.entries(evidence)) {
      if (key.endsWith('Fingerprint')) assert.match(value, /^[a-f0-9]{20}$/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(data.root, { recursive: true, force: true });
  }
});

test('live Hosting evidence fails closed on byte drift', async () => {
  const data = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async value => {
    const url = new URL(value);
    const expected = data.files.get(url.pathname);
    const bytes = url.pathname === '/sw.js' ? Buffer.from('changed') : expected;
    const deployed = data.deployedFiles.find(file => file.path === url.pathname);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Cache-Control': url.pathname === '/index.html'
          ? 'no-cache, no-store, must-revalidate'
          : url.pathname === '/sw.js'
            ? 'no-cache'
            : 'public,max-age=31536000,immutable',
        'Content-Security-Policy': CSP,
        ETag: `"${deployed.hash}"`,
      },
    });
  };
  try {
    await assert.rejects(
      readLiveHostingEvidence(data.options),
      error => error instanceof HostingEvidenceMismatch &&
        error.code === 'HOSTING_ARTIFACT_MISMATCH'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(data.root, { recursive: true, force: true });
  }
});
