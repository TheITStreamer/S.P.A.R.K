const fs = require('fs');

// Read current version from package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next = `${major}.${minor}.${patch + 1}`;

// Bump package.json
pkg.version = next;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// Bump tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
tauriConf.version = next;
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(tauriConf, null, 2) + '\n');

// Bump Cargo.toml (first version = line only)
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/^version = "[\d.]+"/m, `version = "${next}"`);
fs.writeFileSync('src-tauri/Cargo.toml', cargo);

console.log(`Bumped to ${next}`);
