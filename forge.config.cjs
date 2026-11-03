const path = require('node:path');
const {materializeProductionDependencies} = require('./scripts/materialize-production-dependencies.cjs');
const candidate = process.env.EDUCODER_CANDIDATE_BUILD === '1';
const edgeOnly = candidate || process.env.EDUCODER_EDGE_ONLY_INTERNAL === '1';
const version = require('./package.json').version;

const excludedRoots = new Set(['data', 'vendor', 'build-assets', 'docs', 'test', 'scripts', 'service', 'installer', 'evidence', 'out', '.git', '.github', '.worktrees', '.superpowers', '.private-quarantine', 'README.md', 'CHANGELOG.md']);

module.exports = {
  ...(edgeOnly ? { buildIdentifier: candidate ? `edge-candidate-${version}` : 'edge-internal' } : {}),
  packagerConfig: {
    asar: true,
    tmpdir: path.resolve(__dirname, '..', 'packager-tmp'),
    afterCopy: [(buildPath, electronVersion, platform, arch, done) => {
      materializeProductionDependencies({projectRoot: __dirname, buildPath}).then(() => done(), done);
    }],
    extraResource: [...(edgeOnly ? ['build-assets/edge-only.marker'] : ['vendor/ms-playwright']),
      'src/local-single-video/local-single-video-native-control.ps1'],
    ignore(absolutePath) {
      const input = String(absolutePath);
      const relative = (/^[A-Za-z]:[\\/]/.test(input)
        ? path.relative(__dirname, input)
        : input.replace(/^[\\/]+/, '')).replaceAll('\\', '/');
      if (!relative || relative.startsWith('../')) return false;
      const [root, second] = relative.split('/');
      if (excludedRoots.has(root)) return true;
      // Development may use a cache junction. Only the afterCopy hook may add
      // a verified real production dependency directory to the private stage.
      if (root === 'node_modules') return true;
      return /^backup-.*\.zip$/i.test(root);
    },
  },
  makers: [],
};
