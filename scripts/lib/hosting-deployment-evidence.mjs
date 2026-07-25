import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';
const INTERNAL_HOSTING_FILES = new Set([
  '/__/firebase/init.js',
  '/__/firebase/init.json',
]);
const REQUIRED_SCRIPT_SOURCES = new Set([
  "'self'",
  'https://www.google.com/recaptcha/',
  'https://www.gstatic.com/recaptcha/',
]);

export class HostingEvidenceMismatch extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostingEvidenceMismatch';
    this.code = code;
  }
}

const mismatch = (code, message) => {
  throw new HostingEvidenceMismatch(code, message);
};

const isPlainObject = value => value !== null &&
  typeof value === 'object' && !Array.isArray(value);

const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])
    );
  }
  return value;
};

const canonicalJson = value => JSON.stringify(canonicalValue(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hostingFingerprint = value => sha256(
  `attendance-hosting-deployment-v1\u0000${String(value)}`
).slice(0, 20);

const sameStringSet = (actual, expected) =>
  actual.size === expected.size && [...expected].every(value => actual.has(value));

export const assertStrictScriptCsp = value => {
  if (typeof value !== 'string' || !value.trim()) {
    mismatch('HOSTING_CSP_MISSING', 'Header Content-Security-Policy tidak tersedia.');
  }
  const directives = new Map();
  for (const rawDirective of value.split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens.shift().toLowerCase();
    if (directives.has(name)) {
      mismatch('HOSTING_CSP_DUPLICATE_DIRECTIVE', `Directive CSP duplikat: ${name}.`);
    }
    directives.set(name, tokens);
  }

  const scriptSources = new Set(directives.get('script-src') || []);
  if (!sameStringSet(scriptSources, REQUIRED_SCRIPT_SOURCES)) {
    mismatch(
      'HOSTING_CSP_SCRIPT_POLICY_INVALID',
      'script-src live tidak sama dengan allowlist aplikasi.'
    );
  }
  for (const [directive, expected] of [
    ['script-src-attr', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['frame-ancestors', "'none'"],
  ]) {
    const tokens = directives.get(directive) || [];
    if (tokens.length !== 1 || tokens[0] !== expected) {
      mismatch(
        'HOSTING_CSP_REQUIRED_DIRECTIVE_INVALID',
        `Directive CSP ${directive} wajib bernilai ${expected}.`
      );
    }
  }
};

const normalizeLocalHostingConfig = firebaseConfig => {
  const hosting = firebaseConfig?.hosting;
  if (!isPlainObject(hosting) || hosting.public !== 'dist') {
    mismatch(
      'HOSTING_LOCAL_CONFIG_INVALID',
      'firebase.json harus memiliki satu konfigurasi Hosting dengan public=dist.'
    );
  }
  if (!Array.isArray(hosting.headers) || !Array.isArray(hosting.rewrites)) {
    mismatch(
      'HOSTING_LOCAL_CONFIG_INVALID',
      'Konfigurasi headers dan rewrites Hosting wajib berupa array.'
    );
  }

  const headers = hosting.headers.map(entry => {
    if (!isPlainObject(entry) || typeof entry.source !== 'string' ||
        !Array.isArray(entry.headers)) {
      mismatch('HOSTING_LOCAL_CONFIG_INVALID', 'Entry header Hosting tidak valid.');
    }
    const headerMap = {};
    const seen = new Set();
    for (const header of entry.headers) {
      if (!isPlainObject(header) || typeof header.key !== 'string' ||
          typeof header.value !== 'string') {
        mismatch('HOSTING_LOCAL_CONFIG_INVALID', 'Nilai header Hosting tidak valid.');
      }
      const lowerKey = header.key.toLowerCase();
      if (seen.has(lowerKey)) {
        mismatch(
          'HOSTING_LOCAL_CONFIG_INVALID',
          `Header ${header.key} duplikat pada source ${entry.source}.`
        );
      }
      seen.add(lowerKey);
      headerMap[header.key] = header.value;
    }
    return { glob: entry.source, headers: headerMap };
  });
  const rewrites = hosting.rewrites.map(entry => {
    if (!isPlainObject(entry) || typeof entry.source !== 'string' ||
        typeof entry.destination !== 'string') {
      mismatch('HOSTING_LOCAL_CONFIG_INVALID', 'Entry rewrite Hosting tidak valid.');
    }
    return { glob: entry.source, path: entry.destination };
  });
  return { headers, rewrites };
};

const collectLocalFiles = async rootPath => {
  const files = [];
  const walk = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        mismatch(
          'HOSTING_LOCAL_BUILD_INVALID',
          `File tersembunyi tidak boleh berada di build Hosting: ${entry.name}.`
        );
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        mismatch(
          'HOSTING_LOCAL_BUILD_INVALID',
          `Symbolic link tidak boleh berada di build Hosting: ${entry.name}.`
        );
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = relative(rootPath, absolutePath).split(sep).join('/');
        if (!relativePath || relativePath.startsWith('../')) {
          mismatch('HOSTING_LOCAL_BUILD_INVALID', 'Path build Hosting keluar dari dist.');
        }
        const bytes = await readFile(absolutePath);
        files.push({
          path: `/${relativePath}`,
          bytes,
          sha256: sha256(bytes),
          size: bytes.length,
        });
      } else {
        mismatch(
          'HOSTING_LOCAL_BUILD_INVALID',
          `Tipe filesystem build Hosting tidak didukung: ${entry.name}.`
        );
      }
    }
  };
  await walk(rootPath);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    mismatch('HOSTING_LOCAL_BUILD_INVALID', 'Build dist kosong.');
  }
  return files;
};

const entryScriptPath = localFiles => {
  const index = localFiles.find(file => file.path === '/index.html');
  if (!index) mismatch('HOSTING_INDEX_MISSING', 'dist/index.html tidak ditemukan.');
  const html = index.bytes.toString('utf8');
  if (/\son[a-z]+\s*=/i.test(html)) {
    mismatch('HOSTING_INLINE_SCRIPT_FOUND', 'Inline event handler ditemukan pada index.');
  }
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];
  if (scriptTags.length !== 1) {
    mismatch(
      'HOSTING_ENTRY_SCRIPT_INVALID',
      'index.html harus memiliki tepat satu entry script eksternal.'
    );
  }
  const sourceMatch = scriptTags[0][1].match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
  const source = sourceMatch?.[2];
  if (!/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(source || '') ||
      !localFiles.some(file => file.path === source)) {
    mismatch(
      'HOSTING_ENTRY_SCRIPT_INVALID',
      'Entry script index.html harus berupa file JavaScript lokal di /assets/.'
    );
  }
  return source;
};

const listVersionFiles = async (api, versionName) => {
  const files = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    if (++pageCount > 100) {
      mismatch('HOSTING_FILE_LIST_INVALID', 'Pagination file Hosting berlebihan.');
    }
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await api(`${HOSTING_API}/${versionName}/files?${query}`);
    files.push(...(result.files || []));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return files;
};

const readChannel = (api, projectId, siteId) => api(
  `${HOSTING_API}/projects/${encodeURIComponent(projectId)}/sites/` +
  `${encodeURIComponent(siteId)}/channels/live`
);

const validateChannel = (channel, projectId, siteId, origin) => {
  const expectedChannelName =
    `projects/${projectId}/sites/${siteId}/channels/live`;
  const versionName = channel?.release?.version?.name;
  const releaseName = channel?.release?.name;
  if (channel?.name !== expectedChannelName || channel?.url !== origin ||
      !new RegExp(
        `^projects/${projectId}/sites/${siteId}/versions/[A-Za-z0-9_-]+$`
      ).test(versionName || '') ||
      !new RegExp(
        `^projects/${projectId}/sites/${siteId}/channels/live/releases/[0-9]+$`
      ).test(releaseName || '') ||
      channel.release.version.status !== 'FINALIZED' ||
      !['DEPLOY', 'ROLLBACK'].includes(channel.release.type)) {
    mismatch(
      'HOSTING_CHANNEL_INVALID',
      'Channel live tidak menunjuk ke rilis Hosting FINALIZED yang valid.'
    );
  }
  return { versionName, releaseName, version: channel.release.version };
};

const expectedCacheControl = (firebaseConfig, source) => {
  const entry = firebaseConfig.hosting.headers.find(item => item.source === source);
  const header = entry?.headers?.find(item =>
    String(item.key).toLowerCase() === 'cache-control'
  );
  return header?.value || null;
};

const fetchLiveFile = async ({ origin, localFile, deployedFile, cacheNonce }) => {
  const url = new URL(localFile.path, origin);
  url.searchParams.set('__attendance_hosting_check', cacheNonce);
  const response = await fetch(url, {
    redirect: 'error',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  if (!response.ok) {
    mismatch(
      'HOSTING_ARTIFACT_FETCH_FAILED',
      `Artefak live gagal dibaca: ${localFile.path} (${response.status}).`
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.equals(localFile.bytes)) {
    mismatch(
      'HOSTING_ARTIFACT_MISMATCH',
      `Isi artefak live tidak sama dengan dist lokal: ${localFile.path}.`
    );
  }
  const etag = response.headers.get('etag')
    ?.replace(/^"|"$/g, '')
    .replace(/-(?:br|gzip)$/, '');
  if (!etag || etag !== deployedFile.hash) {
    mismatch(
      'HOSTING_ARTIFACT_VERSION_MISMATCH',
      `ETag artefak live tidak terikat ke versi Hosting: ${localFile.path}.`
    );
  }
  return { path: localFile.path, headers: response.headers };
};

/**
 * Return a sanitized, deterministic proof that local dist, the live Hosting
 * release, and the bytes served by the production origin are the same build.
 */
export const readLiveHostingEvidence = async ({
  api,
  projectId,
  siteId = projectId,
  origin = `https://${projectId}.web.app`,
  distUrl = new URL('../../dist/', import.meta.url),
  firebaseConfigUrl = new URL('../../firebase.json', import.meta.url),
}) => {
  if (typeof api !== 'function') throw new TypeError('api wajib berupa function.');
  const distPath = resolve(fileURLToPath(distUrl));
  const [firebaseConfigRaw, localFiles, channelBefore] = await Promise.all([
    readFile(firebaseConfigUrl, 'utf8'),
    collectLocalFiles(distPath),
    readChannel(api, projectId, siteId),
  ]);
  let firebaseConfig;
  try {
    firebaseConfig = JSON.parse(firebaseConfigRaw);
  } catch {
    mismatch('HOSTING_LOCAL_CONFIG_INVALID', 'firebase.json bukan JSON valid.');
  }
  const expectedConfig = normalizeLocalHostingConfig(firebaseConfig);
  const { versionName, releaseName, version } = validateChannel(
    channelBefore,
    projectId,
    siteId,
    origin,
  );
  if (canonicalJson(version.config) !== canonicalJson(expectedConfig)) {
    mismatch(
      'HOSTING_DEPLOYED_CONFIG_MISMATCH',
      'Headers/rewrites Hosting live tidak sama dengan firebase.json lokal.'
    );
  }

  const globalHeaders = expectedConfig.headers.find(item => item.glob === '**')?.headers;
  const configuredCsp = Object.entries(globalHeaders || {}).find(
    ([key]) => key.toLowerCase() === 'content-security-policy'
  )?.[1];
  assertStrictScriptCsp(configuredCsp);
  const entryPath = entryScriptPath(localFiles);

  const deployedFiles = await listVersionFiles(api, versionName);
  const deployedByPath = new Map();
  for (const file of deployedFiles) {
    if (typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash || '') ||
        file.status !== 'ACTIVE' || deployedByPath.has(file.path)) {
      mismatch('HOSTING_FILE_LIST_INVALID', 'Manifest file versi Hosting tidak valid.');
    }
    deployedByPath.set(file.path, file);
  }
  const expectedPaths = new Set([
    ...localFiles.map(file => file.path),
    ...INTERNAL_HOSTING_FILES,
  ]);
  if (!sameStringSet(new Set(deployedByPath.keys()), expectedPaths)) {
    mismatch(
      'HOSTING_FILE_SET_MISMATCH',
      'Daftar file versi Hosting tidak sama dengan dist lokal dan file internal resmi.'
    );
  }
  // The Hosting channel/version response can omit fileCount for a finalized
  // release. The fully paginated manifest above remains authoritative and is
  // already compared as an exact set. When the advisory count is present, it
  // must still agree with that manifest.
  if (version.fileCount !== undefined && version.fileCount !== null) {
    const declaredFileCount = Number(version.fileCount);
    if (!Number.isSafeInteger(declaredFileCount) ||
        declaredFileCount !== deployedFiles.length) {
      mismatch('HOSTING_FILE_COUNT_MISMATCH', 'fileCount versi Hosting tidak konsisten.');
    }
  }

  const cacheNonce = hostingFingerprint(`${versionName}\u0000${releaseName}`);
  const fetchedFiles = await Promise.all(localFiles.map(localFile =>
    fetchLiveFile({
      origin,
      localFile,
      deployedFile: deployedByPath.get(localFile.path),
      cacheNonce,
    })
  ));
  const fetchedByPath = new Map(fetchedFiles.map(file => [file.path, file]));
  const indexHeaders = fetchedByPath.get('/index.html')?.headers;
  const liveCsp = indexHeaders?.get('content-security-policy');
  if (liveCsp !== configuredCsp) {
    mismatch(
      'HOSTING_CSP_MISMATCH',
      'CSP yang disajikan origin live tidak sama dengan konfigurasi deployment.'
    );
  }
  assertStrictScriptCsp(liveCsp);
  if (indexHeaders?.get('cache-control') !==
      expectedCacheControl(firebaseConfig, '/index.html')) {
    mismatch('HOSTING_CACHE_POLICY_MISMATCH', 'Cache-Control index.html tidak aman.');
  }
  if (fetchedByPath.get('/sw.js')?.headers.get('cache-control') !==
      expectedCacheControl(firebaseConfig, '/sw.js')) {
    mismatch('HOSTING_CACHE_POLICY_MISMATCH', 'Cache-Control sw.js tidak aman.');
  }
  if (fetchedByPath.get(entryPath)?.headers.get('cache-control') !==
      expectedCacheControl(firebaseConfig, '/assets/**')) {
    mismatch('HOSTING_CACHE_POLICY_MISMATCH', 'Cache-Control asset immutable tidak aktif.');
  }

  const channelAfter = await readChannel(api, projectId, siteId);
  const after = validateChannel(channelAfter, projectId, siteId, origin);
  if (after.versionName !== versionName || after.releaseName !== releaseName ||
      channelAfter.updateTime !== channelBefore.updateTime) {
    mismatch(
      'HOSTING_DEPLOYMENT_CHANGED_DURING_CHECK',
      'Deployment Hosting berubah ketika bukti sedang dikumpulkan; ulangi pemeriksaan.'
    );
  }

  const publicManifest = localFiles.map(file => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
  }));
  const deployedManifest = deployedFiles
    .map(file => ({ path: file.path, hash: file.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const indexFile = localFiles.find(file => file.path === '/index.html');
  const entryFile = localFiles.find(file => file.path === entryPath);
  const serviceWorker = localFiles.find(file => file.path === '/sw.js');
  if (!serviceWorker) {
    mismatch('HOSTING_SERVICE_WORKER_MISSING', 'dist/sw.js tidak ditemukan.');
  }

  return {
    versionFingerprint: hostingFingerprint(versionName),
    releaseFingerprint: hostingFingerprint(releaseName),
    deploymentConfigFingerprint: hostingFingerprint(canonicalJson(version.config)),
    publicManifestFingerprint: hostingFingerprint(canonicalJson(publicManifest)),
    deployedManifestFingerprint: hostingFingerprint(canonicalJson(deployedManifest)),
    indexFingerprint: indexFile.sha256.slice(0, 20),
    entryScriptFingerprint: entryFile.sha256.slice(0, 20),
    serviceWorkerFingerprint: serviceWorker.sha256.slice(0, 20),
    verifiedPublicFiles: localFiles.length,
    hostingFileCount: deployedFiles.length,
    internalHostingFiles: INTERNAL_HOSTING_FILES.size,
    strictScriptCsp: true,
  };
};
