// Version bump, run from npm's prebuild hook.
//
//   node bump.js          0.8.7 -> 0.8.8   (patch, the default)
//   node bump.js minor    0.8.7 -> 0.9.0
//   node bump.js major    0.8.7 -> 1.0.0
//
// Three files have to agree or the About box, the installer and the crash
// reports all disagree about what is running: package.json, tauri.conf.json
// and Cargo.toml.
//
// NOTE: this fires on every `npm run build`, INCLUDING builds that then fail to
// compile. That is why the version can run ahead of the last released commit.
// If that becomes annoying, move the bump out of prebuild and into a separate
// release script — but then it is on you to remember to run it.

const fs = require('fs');

const kind = (process.argv[2] || 'patch').toLowerCase();
if(!['patch', 'minor', 'major'].includes(kind)){
  console.error(`Unknown bump "${kind}". Use patch, minor or major.`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

if([major, minor, patch].some(n => !Number.isFinite(n))){
  console.error(`package.json version "${pkg.version}" is not x.y.z — refusing to guess.`);
  process.exit(1);
}

// A minor bump resets the patch, a major resets both. Getting this wrong gives
// you 0.9.7 instead of 0.9.0.
const next =
  kind === 'major' ? `${major + 1}.0.0` :
  kind === 'minor' ? `${major}.${minor + 1}.0` :
                     `${major}.${minor}.${patch + 1}`;

// package.json
pkg.version = next;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
tauriConf.version = next;
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(tauriConf, null, 2) + '\n');

// Cargo.toml — first `version = "..."` line only, so a dependency's pinned
// version further down the file is never touched.
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/^version = "[\d.]+"/m, `version = "${next}"`);
fs.writeFileSync('src-tauri/Cargo.toml', cargo);

console.log(`Bumped ${pkg.name || 'spark'} ${major}.${minor}.${patch} -> ${next} (${kind})`);
