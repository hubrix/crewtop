#!/bin/sh
# Builds dist/crewtop_<version>_amd64.deb and smoke-tests the result.
# Needs curl, xz and dpkg-deb. The Node below also runs npm, so the build does
# not use a system Node.
set -eu
umask 022

NODE_VERSION=24.22.2
# From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75

repo=$(cd "$(dirname "$0")/.." && pwd -P)
dist=$repo/dist

arch=$(dpkg --print-architecture)
if [ "$arch" != amd64 ]; then
  echo "build-deb: the package is amd64 only; this machine is $arch" >&2
  exit 1
fi

node_dir=node-v$NODE_VERSION-linux-x64
node_tar=$dist/$node_dir.tar.xz
mkdir -p "$dist"
[ -f "$node_tar" ] || curl -fsSL -o "$node_tar" "https://nodejs.org/dist/v$NODE_VERSION/$node_dir.tar.xz"
echo "$NODE_SHA256  $node_tar" | sha256sum -c --quiet

work=$(mktemp -d "$dist/build.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xJf "$node_tar" -C "$work"
build_node=$work/$node_dir/bin

stage=$work/stage
lib=$stage/usr/lib/crewtop
mkdir -p "$lib/node/bin" "$stage/usr/bin" "$stage/usr/share/doc/crewtop" "$stage/DEBIAN"

cp -R "$repo/bin" "$repo/src" "$repo/package.json" "$repo/package-lock.json" "$lib/"
(cd "$lib" && PATH=$build_node:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
cp "$build_node/node" "$lib/node/bin/node"
cp "$work/$node_dir/LICENSE" "$lib/node/LICENSE"
cp "$repo/packaging/deb/crewtop" "$stage/usr/bin/crewtop"
cp "$repo/packaging/deb/copyright" "$stage/usr/share/doc/crewtop/copyright"
cp "$repo/LICENSE" "$stage/usr/share/doc/crewtop/LICENSE"
cp "$repo/fleet.example.toml" "$stage/usr/share/doc/crewtop/fleet.example.toml"
chmod -R u=rwX,go=rX "$stage"
chmod 755 "$stage/usr/bin/crewtop"

read_json() { "$build_node/node" -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))$2" "$1"; }
version=$(read_json "$repo/package.json" .version)
ccusage=$(read_json "$repo/package.json" ".dependencies.ccusage")
size=$(du -sk "$stage/usr" | cut -f1)
sed -e "s/@VERSION@/$version/" -e "s/@INSTALLED_SIZE@/$size/" \
  "$repo/packaging/deb/control.in" > "$stage/DEBIAN/control"

deb=$dist/crewtop_${version}_amd64.deb
dpkg-deb --root-owner-group -Zxz --build "$stage" "$deb"

# Smoke test: unpack the .deb and run it on a minimal environment. The decoy node
# comes first on PATH, so anything that does not use the bundled Node fails.
check=$work/check
mkdir -p "$check/home" "$check/decoy"
dpkg-deb -x "$deb" "$check/root"
printf '#!/bin/sh\nexit 99\n' > "$check/decoy/node"
chmod 755 "$check/decoy/node"
run() { env -i HOME="$check/home" PATH="$check/decoy:/usr/bin:/bin" "$@"; }

fail() { echo "build-deb: smoke test failed: $1" >&2; exit 1; }
got=$(run "$check/root/usr/bin/crewtop" --version)
[ "$got" = "crewtop $version" ] || fail "crewtop --version printed '$got'"
got=$(PATH="$check/root/usr/lib/crewtop/node/bin:/usr/bin:/bin" "$check/root/usr/lib/crewtop/node_modules/.bin/ccusage" --version)
[ "$got" = "ccusage $ccusage" ] || fail "ccusage --version printed '$got'"
got=$("$check/root/usr/lib/crewtop/node/bin/node" --version)
[ "$got" = "v$NODE_VERSION" ] || fail "bundled node --version printed '$got'"

# The collector stops when stdin closes. With an empty HOME ccusage still reports,
# and it reports only if it found the bundled Node through the launcher's PATH.
sleep 15 | run "$check/root/usr/bin/crewtop" collect --stream > "$check/frames"
grep -q '"t":"usage"' "$check/frames" || fail "no usage frame: $(cat "$check/frames")"
grep -q '"code":"ccusage' "$check/frames" && fail "ccusage error: $(cat "$check/frames")"
[ "$(stat -c %a "$check/home/.local/state/crewtop/salt")" = 600 ] || fail "salt is not mode 0600"
dpkg-deb -c "$deb" | grep -q '/salt$' && fail "the package ships a salt"

echo "$deb"
