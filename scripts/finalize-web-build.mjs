import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const indexPath = path.join(distDir, 'index.html');
const manifestPath = path.join(distDir, 'web-artifact-manifest.json');

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let commitSha = process.env.GIT_COMMIT_SHA ?? 'uncommitted';
if (!process.env.GIT_COMMIT_SHA) {
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    commitSha = 'uncommitted';
  }
}
const releaseDate = process.env.BUILD_RELEASE_DATE ?? new Date().toISOString();

const indexHtml = readFileSync(indexPath, 'utf8').replace(/type=\"module\" crossorigin /g, 'defer ');
writeFileSync(indexPath, indexHtml);

const manifest = {
  bundleVersion: packageJson.version,
  commitSha,
  releaseDate,
  compatibilityNote: 'Opaque web bundle for explicit external consumers. No shared runtime source is supported.',
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
