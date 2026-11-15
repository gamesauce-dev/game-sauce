# Third-party software and licences

game-sauce itself is under the [MIT licence](../LICENSE). This page lists the software it ships with or loads, and under what terms. It is written by `scripts/third-party.mjs` (the numbers) with notes added by hand (the last section). Run the script before a release.

## What counts as "shipped"

- **Server (Docker image, Proxmox install, bare Node, desktop app):** the npm packages below, plus Node.js itself and the SQLite engine inside `better-sqlite3`.
- **Desktop app:** the Rust crates below (Tauri and what it uses), statically built into the app, plus the operating system's web view (WebView2 on Windows, WebKit on macOS and Linux).
- **Browser page:** `public/vendor/pdfjs` (pdf.js, Apache-2.0, with its licence file) and the icon and flag pictures.
- **Loaded when someone presses Play, not shipped:** EmulatorJS and its emulator cores, fetched by the visitor's browser from `cdn.emulatorjs.org`. See the notes.

## Server: npm packages (77)

Only the production dependencies (what is installed with `npm ci --omit=dev`). Tests and tools such as Playwright are development-only and are never shipped.

| Licence | Packages |
|---|---|
| MIT | 73 |
| ISC | 2 |
| BSD-3-Clause | 2 |

<details><summary>The full list</summary>

| Package | Version | Licence |
|---|---|---|
| [accepts](https://github.com/jshttp/accepts) | 1.3.8 | MIT |
| [append-field](https://github.com/LinusU/node-append-field) | 1.0.0 | MIT |
| [array-flatten](https://github.com/blakeembrey/array-flatten) | 1.1.1 | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 13.0.3 | MIT |
| [body-parser](https://github.com/expressjs/body-parser) | 1.20.9 | MIT |
| [busboy](https://github.com/mscdex/busboy) | 1.6.0 | MIT |
| [bytes](https://github.com/visionmedia/bytes.js) | 3.1.2 | MIT |
| [call-bind-apply-helpers](https://github.com/ljharb/call-bind-apply-helpers) | 1.0.2 | MIT |
| [call-bound](https://github.com/ljharb/call-bound) | 1.0.4 | MIT |
| [content-disposition](https://github.com/jshttp/content-disposition) | 0.5.4 | MIT |
| [content-type](https://github.com/jshttp/content-type) | 1.0.5 | MIT |
| [cookie](https://github.com/jshttp/cookie) | 0.7.2 | MIT |
| [cookie-signature](https://github.com/visionmedia/node-cookie-signature) | 1.0.7 | MIT |
| [debug](https://github.com/visionmedia/debug) | 2.6.9 | MIT |
| [depd](https://github.com/dougwilson/nodejs-depd) | 2.0.0 | MIT |
| [destroy](https://github.com/stream-utils/destroy) | 1.2.0 | MIT |
| [dunder-proto](https://github.com/es-shims/dunder-proto) | 1.0.1 | MIT |
| [ee-first](https://github.com/jonathanong/ee-first) | 1.1.1 | MIT |
| [encodeurl](https://github.com/pillarjs/encodeurl) | 2.0.0 | MIT |
| [es-define-property](https://github.com/ljharb/es-define-property) | 1.0.1 | MIT |
| [es-errors](https://github.com/ljharb/es-errors) | 1.3.0 | MIT |
| [es-object-atoms](https://github.com/ljharb/es-object-atoms) | 1.1.2 | MIT |
| [escape-html](https://github.com/component/escape-html) | 1.0.3 | MIT |
| [etag](https://github.com/jshttp/etag) | 1.8.1 | MIT |
| [express](https://github.com/expressjs/express) | 4.22.3 | MIT |
| [finalhandler](https://github.com/pillarjs/finalhandler) | 1.3.2 | MIT |
| [forwarded](https://github.com/jshttp/forwarded) | 0.2.0 | MIT |
| [fresh](https://github.com/jshttp/fresh) | 0.5.2 | MIT |
| [function-bind](https://github.com/Raynos/function-bind) | 1.1.2 | MIT |
| [get-intrinsic](https://github.com/ljharb/get-intrinsic) | 1.3.0 | MIT |
| [get-proto](https://github.com/ljharb/get-proto) | 1.0.1 | MIT |
| [gopd](https://github.com/ljharb/gopd) | 1.2.0 | MIT |
| [has-symbols](https://github.com/inspect-js/has-symbols) | 1.1.0 | MIT |
| [hasown](https://github.com/inspect-js/hasOwn) | 2.0.4 | MIT |
| [http-errors](https://github.com/jshttp/http-errors) | 2.0.1 | MIT |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | 0.4.24 | MIT |
| [inherits](https://github.com/isaacs/inherits) | 2.0.4 | ISC |
| [ipaddr.js](https://github.com/whitequark/ipaddr.js) | 1.9.1 | MIT |
| [jpeg-js](https://github.com/eugeneware/jpeg-js) | 0.4.4 | BSD-3-Clause |
| [math-intrinsics](https://github.com/es-shims/math-intrinsics) | 1.1.0 | MIT |
| [media-typer](https://github.com/jshttp/media-typer) | 0.3.0 | MIT |
| [merge-descriptors](https://github.com/sindresorhus/merge-descriptors) | 1.0.3 | MIT |
| [methods](https://github.com/jshttp/methods) | 1.1.2 | MIT |
| [mime](https://github.com/broofa/node-mime) | 1.6.0 | MIT |
| [mime-db](https://github.com/jshttp/mime-db) | 1.52.0 | MIT |
| [mime-types](https://github.com/jshttp/mime-types) | 2.1.35 | MIT |
| [ms](https://github.com/zeit/ms) | 2.0.0 | MIT |
| [ms](https://github.com/zeit/ms) | 2.1.3 | MIT |
| [multer](https://github.com/expressjs/multer) | 2.5.0 | MIT |
| [negotiator](https://github.com/jshttp/negotiator) | 0.6.3 | MIT |
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 8.9.2 | MIT |
| [object-inspect](https://github.com/inspect-js/object-inspect) | 1.13.4 | MIT |
| [on-finished](https://github.com/jshttp/on-finished) | 2.4.2 | MIT |
| [parseurl](https://github.com/pillarjs/parseurl) | 1.3.3 | MIT |
| [path-to-regexp](https://github.com/pillarjs/path-to-regexp) | 0.1.13 | MIT |
| [pngjs](https://github.com/pngjs/pngjs) | 7.0.0 | MIT |
| [proxy-addr](https://github.com/jshttp/proxy-addr) | 2.0.8 | MIT |
| [qs](https://github.com/ljharb/qs) | 6.16.1 | BSD-3-Clause |
| [range-parser](https://github.com/jshttp/range-parser) | 1.2.1 | MIT |
| [raw-body](https://github.com/stream-utils/raw-body) | 2.5.3 | MIT |
| [safe-buffer](https://github.com/feross/safe-buffer) | 5.2.1 | MIT |
| [safer-buffer](https://github.com/ChALkeR/safer-buffer) | 2.1.2 | MIT |
| [saxen](https://github.com/nikku/saxen) | 11.2.0 | MIT |
| [send](https://github.com/pillarjs/send) | 0.19.2 | MIT |
| [serve-static](https://github.com/expressjs/serve-static) | 1.16.3 | MIT |
| [setprototypeof](https://github.com/wesleytodd/setprototypeof) | 1.2.0 | ISC |
| [side-channel](https://github.com/ljharb/side-channel) | 1.1.1 | MIT |
| [side-channel-list](https://github.com/ljharb/side-channel-list) | 1.0.1 | MIT |
| [side-channel-map](https://github.com/ljharb/side-channel-map) | 1.0.1 | MIT |
| [side-channel-weakmap](https://github.com/ljharb/side-channel-weakmap) | 1.0.2 | MIT |
| [statuses](https://github.com/jshttp/statuses) | 2.0.2 | MIT |
| [streamsearch](https://github.com/mscdex/streamsearch) | 1.1.0 | MIT |
| [toidentifier](https://github.com/component/toidentifier) | 1.0.1 | MIT |
| [type-is](https://github.com/jshttp/type-is) | 1.6.18 | MIT |
| [unpipe](https://github.com/stream-utils/unpipe) | 1.0.0 | MIT |
| [utils-merge](https://github.com/jaredhanson/utils-merge) | 1.0.1 | MIT |
| [vary](https://github.com/jshttp/vary) | 1.1.2 | MIT |

</details>

## Desktop app: Rust crates (425)

From `desktop/src-tauri/Cargo.lock`, all platforms together (Windows, macOS and Linux crates are all counted).

| Licence | Packages |
|---|---|
| MIT OR Apache-2.0 | 197 |
| MIT | 98 |
| Apache-2.0 OR MIT | 31 |
| Unicode-3.0 | 18 |
| Zlib OR Apache-2.0 OR MIT | 17 |
| MIT/Apache-2.0 | 12 |
| Unlicense OR MIT | 9 |
| MPL-2.0 | 5 |
| BSD-3-Clause | 3 |
| Apache-2.0/MIT | 3 |
| ISC | 3 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 3 |
| Zlib | 2 |
| MIT OR Zlib OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| MIT OR Apache-2.0 OR Zlib | 2 |
| Unlicense/MIT | 2 |
| Apache-2.0 | 2 |
| CDLA-Permissive-2.0 | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause/MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| Apache-2.0 / MIT | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR ISC OR MIT | 1 |
| Apache-2.0 WITH LLVM-exception | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |

<details><summary>The full list</summary>

| Crate | Version | Licence |
|---|---|---|
| [adler2](https://github.com/oyvindln/adler2) | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| [aho-corasick](https://github.com/BurntSushi/aho-corasick) | 1.1.5 | Unlicense OR MIT |
| [alloc-no-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 3.0.0 | BSD-3-Clause |
| [alloc-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 0.3.0 | BSD-3-Clause |
| [android_system_properties](https://github.com/nical/android_system_properties) | 0.1.6 | MIT OR Apache-2.0 |
| [anyhow](https://github.com/dtolnay/anyhow) | 1.0.104 | MIT OR Apache-2.0 |
| [atk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atomic-waker](https://github.com/smol-rs/atomic-waker) | 1.1.2 | Apache-2.0 OR MIT |
| [autocfg](https://github.com/cuviper/autocfg) | 1.5.1 | Apache-2.0 OR MIT |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.21.7 | MIT OR Apache-2.0 |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.22.1 | MIT OR Apache-2.0 |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.23.1 | MIT OR Apache-2.0 |
| [bit-set](https://github.com/contain-rs/bit-set) | 0.8.0 | Apache-2.0 OR MIT |
| [bit-vec](https://github.com/contain-rs/bit-vec) | 0.8.0 | Apache-2.0 OR MIT |
| [bitflags](https://github.com/bitflags/bitflags) | 1.3.2 | MIT/Apache-2.0 |
| [bitflags](https://github.com/bitflags/bitflags) | 2.13.2 | MIT OR Apache-2.0 |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.10.4 | MIT OR Apache-2.0 |
| [block2](https://github.com/madsmtm/objc2) | 0.6.2 | MIT |
| [brotli](https://github.com/dropbox/rust-brotli) | 9.1.1 | BSD-3-Clause AND MIT |
| [brotli-decompressor](https://github.com/dropbox/rust-brotli-decompressor) | 6.3.0 | BSD-3-Clause/MIT |
| [bs58](https://github.com/Nullus157/bs58-rs) | 0.5.1 | MIT/Apache-2.0 |
| [bumpalo](https://github.com/fitzgen/bumpalo) | 3.20.3 | MIT OR Apache-2.0 |
| [bytemuck](https://github.com/Lokathor/bytemuck) | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| [byteorder](https://github.com/BurntSushi/byteorder) | 1.5.0 | Unlicense OR MIT |
| [bytes](https://github.com/tokio-rs/bytes) | 1.12.1 | MIT |
| [cairo-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [cairo-sys-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.2 | MIT |
| [camino](https://github.com/camino-rs/camino) | 1.2.6 | MIT OR Apache-2.0 |
| [cargo_metadata](https://github.com/oli-obk/cargo_metadata) | 0.19.2 | MIT |
| [cargo_toml](https://gitlab.com/lib.rs/cargo_toml) | 1.0.1 | Apache-2.0 OR MIT |
| [cargo-platform](https://github.com/rust-lang/cargo) | 0.1.9 | MIT OR Apache-2.0 |
| [cc](https://github.com/rust-lang/cc-rs) | 1.11.1 | MIT OR Apache-2.0 |
| [cesu8](https://github.com/emk/cesu8-rs) | 1.1.0 | Apache-2.0/MIT |
| [cfb](https://github.com/mdsteele/rust-cfb) | 0.14.0 | MIT |
| [cfg-expr](https://github.com/EmbarkStudios/cfg-expr) | 0.15.8 | MIT OR Apache-2.0 |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.5 | MIT OR Apache-2.0 |
| [chrono](https://github.com/chronotope/chrono) | 0.4.45 | MIT OR Apache-2.0 |
| [combine](https://github.com/Marwes/combine) | 4.6.9 | MIT |
| [cookie](https://github.com/SergioBenitez/cookie-rs) | 0.18.2 | MIT OR Apache-2.0 |
| [core-foundation](https://github.com/servo/core-foundation-rs) | 0.10.1 | MIT OR Apache-2.0 |
| [core-foundation-sys](https://github.com/servo/core-foundation-rs) | 0.8.7 | MIT OR Apache-2.0 |
| [core-graphics](https://github.com/servo/core-foundation-rs) | 0.25.0 | MIT OR Apache-2.0 |
| [core-graphics-types](https://github.com/servo/core-foundation-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.2.17 | MIT OR Apache-2.0 |
| [crc32fast](https://github.com/srijs/rust-crc32fast) | 1.5.4 | MIT OR Apache-2.0 |
| [crossbeam-channel](https://github.com/crossbeam-rs/crossbeam) | 0.5.17 | MIT OR Apache-2.0 |
| [crossbeam-utils](https://github.com/crossbeam-rs/crossbeam) | 0.8.23 | MIT OR Apache-2.0 |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.1.7 | MIT OR Apache-2.0 |
| [cssparser](https://github.com/servo/rust-cssparser) | 0.37.0 | MPL-2.0 |
| [cssparser-macros](https://github.com/servo/rust-cssparser) | 0.7.1 | MPL-2.0 |
| [ctor](https://github.com/mmastrac/linktime) | 1.0.13 | Apache-2.0 OR MIT |
| [darling](https://github.com/TedDriggs/darling) | 0.24.1 | MIT |
| [darling_core](https://github.com/TedDriggs/darling) | 0.24.1 | MIT |
| [darling_macro](https://github.com/TedDriggs/darling) | 0.24.1 | MIT |
| [dbus](https://github.com/diwic/dbus-rs) | 0.9.12 | Apache-2.0/MIT |
| [deranged](https://github.com/jhpratt/deranged) | 0.5.9 | MIT OR Apache-2.0 |
| [derive_more](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [derive_more-impl](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [digest](https://github.com/RustCrypto/traits) | 0.10.7 | MIT OR Apache-2.0 |
| [dirs](https://codeberg.org/dirs/dirs-rs) | 7.0.0 | MIT OR Apache-2.0 |
| [dirs-sys](https://github.com/dirs-dev/dirs-sys-rs) | 0.5.0 | MIT OR Apache-2.0 |
| [dispatch2](https://github.com/madsmtm/objc2) | 0.3.1 | Zlib OR Apache-2.0 OR MIT |
| [displaydoc](https://github.com/yaahc/displaydoc) | 0.2.7 | MIT OR Apache-2.0 |
| [dlopen2](https://github.com/OpenByteDev/dlopen2) | 0.8.2 | MIT |
| [dlopen2_derive](https://github.com/OpenByteDev/dlopen2) | 0.4.3 | MIT |
| [dom_query](https://github.com/niklak/dom_query) | 0.28.0 | MIT |
| [dpi](https://github.com/rust-windowing/winit) | 0.1.2 | Apache-2.0 AND MIT |
| [dtoa](https://github.com/dtolnay/dtoa) | 1.0.11 | MIT OR Apache-2.0 |
| [dtoa-short](https://github.com/upsuper/dtoa-short) | 0.3.5 | MPL-2.0 |
| [dunce](https://gitlab.com/kornelski/dunce) | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| [dyn-clone](https://github.com/dtolnay/dyn-clone) | 1.0.20 | MIT OR Apache-2.0 |
| [embed_plist](https://github.com/nvzqz/embed-plist-rs) | 1.2.2 | MIT OR Apache-2.0 |
| [embed-resource](https://github.com/nabijaczleweli/rust-embed-resource) | 3.0.12 | MIT |
| [equivalent](https://github.com/indexmap-rs/equivalent) | 1.0.3 | Apache-2.0 OR MIT |
| [erased-serde](https://github.com/dtolnay/erased-serde) | 0.4.11 | MIT OR Apache-2.0 |
| [fastrand](https://github.com/smol-rs/fastrand) | 2.5.0 | Apache-2.0 OR MIT |
| [fdeflate](https://github.com/image-rs/fdeflate) | 0.3.7 | MIT OR Apache-2.0 |
| [field-offset](https://github.com/Diggsey/rust-field-offset) | 0.3.6 | MIT OR Apache-2.0 |
| [find-msvc-tools](https://github.com/rust-lang/cc-rs) | 0.1.15 | MIT OR Apache-2.0 |
| [flate2](https://github.com/rust-lang/flate2-rs) | 1.1.11 | MIT OR Apache-2.0 |
| [fnv](https://github.com/servo/rust-fnv) | 1.0.7 | Apache-2.0 / MIT |
| [foldhash](https://github.com/orlp/foldhash) | 0.2.0 | Zlib |
| [foreign-types](https://github.com/sfackler/foreign-types) | 0.5.0 | MIT/Apache-2.0 |
| [foreign-types-macros](https://github.com/sfackler/foreign-types) | 0.2.4 | MIT/Apache-2.0 |
| [foreign-types-shared](https://github.com/sfackler/foreign-types) | 0.3.1 | MIT/Apache-2.0 |
| [form_urlencoded](https://github.com/servo/rust-url) | 1.2.2 | MIT OR Apache-2.0 |
| [futures-channel](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-core](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-executor](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-io](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-macro](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-sink](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-task](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [gdk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdk-pixbuf](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [gdk-pixbuf-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gdk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkwayland-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [generic-array](https://github.com/fizyk20/generic-array.git) | 0.14.7 | MIT |
| [getrandom](https://github.com/rust-random/getrandom) | 0.2.17 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.3.4 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.4.3 | MIT OR Apache-2.0 |
| [gio](https://github.com/gtk-rs/gtk-rs-core) | 0.18.4 | MIT |
| [gio-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glib](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-macros](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glob](https://github.com/rust-lang/glob) | 0.3.4 | MIT OR Apache-2.0 |
| [gobject-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gtk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk3-macros](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.12.3 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.17.1 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.4.1 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.5.0 | MIT OR Apache-2.0 |
| [hex](https://github.com/KokaKiwi/rust-hex) | 0.4.3 | MIT OR Apache-2.0 |
| [html5ever](https://github.com/servo/html5ever) | 0.39.0 | MIT OR Apache-2.0 |
| [http](https://github.com/hyperium/http) | 1.5.0 | MIT OR Apache-2.0 |
| [http-body](https://github.com/hyperium/http-body) | 1.1.0 | MIT |
| [http-body-util](https://github.com/hyperium/http-body) | 0.1.5 | MIT |
| [httparse](https://github.com/seanmonstar/httparse) | 1.10.1 | MIT OR Apache-2.0 |
| [hyper](https://github.com/hyperium/hyper) | 1.12.0 | MIT |
| [hyper-util](https://github.com/hyperium/hyper-util) | 0.1.21 | MIT |
| [iana-time-zone](https://github.com/strawlab/iana-time-zone) | 0.1.65 | MIT OR Apache-2.0 |
| [iana-time-zone-haiku](https://github.com/strawlab/iana-time-zone) | 0.1.2 | MIT OR Apache-2.0 |
| [ico](https://github.com/mdsteele/rust-ico) | 0.6.0 | MIT |
| [icu_collections](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_locale_core](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_normalizer](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_normalizer_data](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_properties](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_properties_data](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [icu_provider](https://github.com/unicode-org/icu4x) | 2.4.0 | Unicode-3.0 |
| [ident_case](https://github.com/TedDriggs/ident_case) | 1.0.1 | MIT/Apache-2.0 |
| [idna](https://github.com/servo/rust-url/) | 1.1.0 | MIT OR Apache-2.0 |
| [idna_adapter](https://github.com/hsivonen/idna_adapter) | 1.2.2 | Apache-2.0 OR MIT |
| [indexmap](https://github.com/bluss/indexmap) | 1.9.3 | Apache-2.0 OR MIT |
| [indexmap](https://github.com/indexmap-rs/indexmap) | 2.14.2 | Apache-2.0 OR MIT |
| [infer](https://github.com/bojand/infer) | 0.22.0 | MIT |
| [ipnet](https://github.com/krisprice/ipnet) | 2.12.2 | MIT OR Apache-2.0 |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | MIT OR Apache-2.0 |
| [javascriptcore-rs](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.2 | MIT |
| [javascriptcore-rs-sys](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.1 | MIT |
| [jiff](https://github.com/BurntSushi/jiff) | 0.2.40 | Unlicense OR MIT |
| [jiff-core](https://github.com/BurntSushi/jiff) | 0.1.3 | Unlicense OR MIT |
| [jiff-static](https://github.com/BurntSushi/jiff) | 0.2.40 | Unlicense OR MIT |
| [jiff-tzdb](https://github.com/BurntSushi/jiff) | 0.1.9 | Unlicense OR MIT |
| [jiff-tzdb-platform](https://github.com/BurntSushi/jiff) | 0.1.3 | Unlicense OR MIT |
| [jni](https://github.com/jni-rs/jni-rs) | 0.21.1 | MIT/Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.3.1 | MIT OR Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [jni-sys-macros](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [js-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys) | 0.3.107 | MIT OR Apache-2.0 |
| [json-patch](https://github.com/idubrov/json-patch) | 4.2.0 | MIT/Apache-2.0 |
| [jsonptr](https://github.com/chanced/jsonptr) | 0.7.1 | MIT OR Apache-2.0 |
| [keyboard-types](https://github.com/rust-windowing/keyboard-types) | 0.8.3 | MIT OR Apache-2.0 |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |
| [libc](https://github.com/rust-lang/libc) | 0.2.191 | MIT OR Apache-2.0 |
| [libdbus-sys](https://github.com/diwic/dbus-rs) | 0.2.7 | Apache-2.0/MIT |
| [libloading](https://github.com/nagisa/rust_libloading/) | 0.7.4 | ISC |
| [libredox](https://gitlab.redox-os.org/redox-os/libredox.git) | 0.1.25 | MIT |
| [litemap](https://github.com/unicode-org/icu4x) | 0.8.3 | Unicode-3.0 |
| [lock_api](https://github.com/Amanieu/parking_lot) | 0.4.14 | MIT OR Apache-2.0 |
| [log](https://github.com/rust-lang/log) | 0.4.35 | MIT OR Apache-2.0 |
| [markup5ever](https://github.com/servo/html5ever) | 0.39.0 | MIT OR Apache-2.0 |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.3 | Unlicense OR MIT |
| [memoffset](https://github.com/Gilnaa/memoffset) | 0.9.1 | MIT |
| [mime](https://github.com/hyperium/mime) | 0.3.18 | MIT OR Apache-2.0 |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| [mio](https://github.com/tokio-rs/mio) | 1.2.4 | MIT |
| [muda](https://github.com/tauri-apps/muda) | 0.20.0 | Apache-2.0 OR MIT |
| [ndk](https://github.com/rust-mobile/ndk) | 0.9.0 | MIT OR Apache-2.0 |
| [ndk-context](https://github.com/rust-windowing/android-ndk-rs) | 0.1.1 | MIT OR Apache-2.0 |
| [ndk-sys](https://github.com/rust-mobile/ndk) | 0.6.0+11769913 | MIT OR Apache-2.0 |
| [new_debug_unreachable](https://github.com/mbrubeck/rust-debug-unreachable) | 1.0.6 | MIT |
| [num_enum](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num_enum_derive](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num-conv](https://github.com/jhpratt/num-conv) | 0.2.2 | MIT OR Apache-2.0 |
| [num-traits](https://github.com/rust-num/num-traits) | 0.2.19 | MIT OR Apache-2.0 |
| [objc2](https://github.com/madsmtm/objc2) | 0.6.5 | MIT |
| [objc2-app-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-cloud-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-data](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-graphics](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-image](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-location](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-text](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-encode](https://github.com/madsmtm/objc2) | 4.1.0 | MIT |
| [objc2-exception-helper](https://github.com/madsmtm/objc2) | 0.1.1 | Zlib OR Apache-2.0 OR MIT |
| [objc2-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | MIT |
| [objc2-io-surface](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-quartz-core](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-ui-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-user-notifications](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-web-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [once_cell](https://github.com/matklad/once_cell) | 1.21.4 | MIT OR Apache-2.0 |
| [option-ext](https://github.com/soc/option-ext.git) | 0.2.0 | MPL-2.0 |
| [pango](https://github.com/gtk-rs/gtk-rs-core) | 0.18.3 | MIT |
| [pango-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [parking_lot](https://github.com/Amanieu/parking_lot) | 0.12.5 | MIT OR Apache-2.0 |
| [parking_lot_core](https://github.com/Amanieu/parking_lot) | 0.9.12 | MIT OR Apache-2.0 |
| [percent-encoding](https://github.com/servo/rust-url/) | 2.3.2 | MIT OR Apache-2.0 |
| [phf](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_codegen](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_generator](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_macros](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_shared](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [pin-project-lite](https://github.com/taiki-e/pin-project-lite) | 0.2.17 | Apache-2.0 OR MIT |
| [pkg-config](https://github.com/rust-lang/pkg-config-rs) | 0.3.34 | MIT OR Apache-2.0 |
| [plist](https://github.com/ebarnard/rust-plist/) | 1.10.3 | MIT |
| [png](https://github.com/image-rs/image-png) | 0.18.1 | MIT OR Apache-2.0 |
| [portable-atomic](https://github.com/taiki-e/portable-atomic) | 1.15.0 | Apache-2.0 OR MIT |
| [portable-atomic-util](https://github.com/taiki-e/portable-atomic-util) | 0.2.8 | Apache-2.0 OR MIT |
| [potential_utf](https://github.com/unicode-org/icu4x) | 0.1.6 | Unicode-3.0 |
| [powerfmt](https://github.com/jhpratt/powerfmt) | 0.2.1 | MIT OR Apache-2.0 |
| [precomputed-hash](https://github.com/emilio/precomputed-hash) | 0.1.1 | MIT |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 1.3.1 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 2.0.2 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 3.5.0 | MIT OR Apache-2.0 |
| [proc-macro-error](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro-error-attr](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.107 | MIT OR Apache-2.0 |
| [quick-xml](https://github.com/tafia/quick-xml) | 0.42.0 | MIT |
| [quote](https://github.com/dtolnay/quote) | 1.0.47 | MIT OR Apache-2.0 |
| [r-efi](https://github.com/r-efi/r-efi) | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [r-efi](https://github.com/r-efi/r-efi) | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [raw-window-handle](https://github.com/rust-windowing/raw-window-handle) | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| [redox_syscall](https://gitlab.redox-os.org/redox-os/syscall) | 0.5.18 | MIT |
| [redox_users](https://gitlab.redox-os.org/redox-os/users) | 0.5.3 | MIT |
| [ref-cast](https://github.com/dtolnay/ref-cast) | 1.0.27 | MIT OR Apache-2.0 |
| [ref-cast-impl](https://github.com/dtolnay/ref-cast) | 1.0.27 | MIT OR Apache-2.0 |
| [regex](https://github.com/rust-lang/regex) | 1.13.1 | MIT OR Apache-2.0 |
| [regex-automata](https://github.com/rust-lang/regex) | 0.4.18 | MIT OR Apache-2.0 |
| [regex-syntax](https://github.com/rust-lang/regex) | 0.8.11 | MIT OR Apache-2.0 |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.5 | MIT OR Apache-2.0 |
| [ring](https://github.com/briansmith/ring) | 0.17.14 | Apache-2.0 AND ISC |
| [rustc_version](https://github.com/djc/rustc-version-rs) | 0.4.1 | MIT OR Apache-2.0 |
| [rustc-hash](https://github.com/rust-lang/rustc-hash) | 2.1.3 | Apache-2.0 OR MIT |
| [rustls](https://github.com/rustls/rustls) | 0.23.46 | Apache-2.0 OR ISC OR MIT |
| [rustls-pki-types](https://github.com/rustls/pki-types) | 1.15.1 | MIT OR Apache-2.0 |
| [rustls-webpki](https://github.com/rustls/webpki) | 0.103.16 | ISC |
| [rustversion](https://github.com/dtolnay/rustversion) | 1.0.23 | MIT OR Apache-2.0 |
| [same-file](https://github.com/BurntSushi/same-file) | 1.0.6 | Unlicense/MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.9.0 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 1.2.3 | MIT |
| [schemars_derive](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [scopeguard](https://github.com/bluss/scopeguard) | 1.2.0 | MIT OR Apache-2.0 |
| [selectors](https://github.com/servo/stylo) | 0.38.0 | MPL-2.0 |
| [semver](https://github.com/dtolnay/semver) | 1.0.28 | MIT OR Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_derive_internals](https://github.com/serde-rs/serde) | 0.29.1 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.154 | MIT OR Apache-2.0 |
| [serde_repr](https://github.com/dtolnay/serde-repr) | 0.1.21 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 0.6.9 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 1.1.3 | MIT OR Apache-2.0 |
| [serde_with](https://github.com/jonasbb/serde_with/) | 3.24.0 | MIT OR Apache-2.0 |
| [serde_with_macros](https://github.com/jonasbb/serde_with/) | 3.24.0 | MIT OR Apache-2.0 |
| [serde-untagged](https://github.com/dtolnay/serde-untagged) | 0.1.9 | MIT OR Apache-2.0 |
| [serialize-to-javascript](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [serialize-to-javascript-impl](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [servo_arc](https://github.com/servo/stylo) | 0.4.3 | MIT OR Apache-2.0 |
| [sha2](https://github.com/RustCrypto/hashes) | 0.10.9 | MIT OR Apache-2.0 |
| [shlex](https://github.com/comex/rust-shlex) | 2.0.1 | MIT OR Apache-2.0 |
| [simd-adler32](https://github.com/mcountryman/simd-adler32) | 0.3.10 | MIT |
| [siphasher](https://github.com/jedisct1/rust-siphash) | 1.0.4 | MIT OR Apache-2.0 |
| [slab](https://github.com/tokio-rs/slab) | 0.4.12 | MIT |
| [smallvec](https://github.com/servo/rust-smallvec) | 1.16.5 | MIT OR Apache-2.0 |
| [socket2](https://github.com/rust-lang/socket2) | 0.6.5 | MIT OR Apache-2.0 |
| [softbuffer](https://github.com/rust-windowing/softbuffer) | 0.4.8 | MIT OR Apache-2.0 |
| [soup3](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [soup3-sys](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [stable_deref_trait](https://github.com/storyyeller/stable_deref_trait) | 1.2.1 | MIT OR Apache-2.0 |
| [static_vcruntime](https://github.com/ChrisDenton/static_vcruntime) | 3.0.0 | MIT OR Apache-2.0 OR Zlib |
| [string_cache](https://github.com/servo/string-cache) | 0.9.0 | MIT OR Apache-2.0 |
| [string_cache_codegen](https://github.com/servo/string-cache) | 0.6.1 | MIT OR Apache-2.0 |
| [strsim](https://github.com/rapidfuzz/strsim-rs) | 0.11.1 | MIT |
| [subtle](https://github.com/dalek-cryptography/subtle) | 2.6.1 | BSD-3-Clause |
| [swift-rs](https://github.com/Brendonovich/swift-rs) | 1.0.9 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 1.0.109 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 2.0.119 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 3.0.9 | MIT OR Apache-2.0 |
| [sync_wrapper](https://github.com/Actyx/sync_wrapper) | 1.0.2 | Apache-2.0 |
| [synstructure](https://github.com/mystor/synstructure) | 0.14.0 | MIT |
| [system-deps](https://github.com/gdesmott/system-deps) | 6.2.2 | MIT OR Apache-2.0 |
| [tao](https://github.com/tauri-apps/tao) | 0.37.2 | Apache-2.0 |
| [tao-macros](https://github.com/tauri-apps/tao) | 0.1.4 | MIT OR Apache-2.0 |
| [target-lexicon](https://github.com/bytecodealliance/target-lexicon) | 0.12.16 | Apache-2.0 WITH LLVM-exception |
| [tauri](https://github.com/tauri-apps/tauri) | 2.12.5 | Apache-2.0 OR MIT |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.7.4 | Apache-2.0 OR MIT |
| [tauri-codegen](https://github.com/tauri-apps/tauri) | 2.7.4 | Apache-2.0 OR MIT |
| [tauri-macros](https://github.com/tauri-apps/tauri) | 2.7.4 | Apache-2.0 OR MIT |
| [tauri-runtime](https://github.com/tauri-apps/tauri) | 2.12.2 | Apache-2.0 OR MIT |
| [tauri-runtime-wry](https://github.com/tauri-apps/tauri) | 2.12.3 | Apache-2.0 OR MIT |
| [tauri-utils](https://github.com/tauri-apps/tauri) | 2.10.2 | Apache-2.0 OR MIT |
| [tauri-winres](https://github.com/tauri-apps/winres) | 0.3.7 | MIT |
| [tendril](https://github.com/servo/html5ever) | 0.5.1 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.21 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 2.0.21 | MIT OR Apache-2.0 |
| [time](https://github.com/time-rs/time) | 0.3.55 | MIT OR Apache-2.0 |
| [time-core](https://github.com/time-rs/time) | 0.1.9 | MIT OR Apache-2.0 |
| [time-macros](https://github.com/time-rs/time) | 0.2.32 | MIT OR Apache-2.0 |
| [tinystr](https://github.com/unicode-org/icu4x) | 0.8.5 | Unicode-3.0 |
| [tinyvec](https://github.com/Lokathor/tinyvec) | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| [tokio](https://github.com/tokio-rs/tokio) | 1.54.1 | MIT |
| [tokio-util](https://github.com/tokio-rs/tokio) | 0.7.20 | MIT |
| [toml](https://github.com/toml-rs/toml) | 0.8.2 | MIT OR Apache-2.0 |
| [toml](https://github.com/toml-rs/toml) | 1.2.1+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.6.3 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.19.15 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.20.2 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.25.19+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_parser](https://github.com/toml-rs/toml) | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_writer](https://github.com/toml-rs/toml) | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 |
| [tower](https://github.com/tower-rs/tower) | 0.5.3 | MIT |
| [tower-http](https://github.com/tower-rs/tower-http) | 0.6.11 | MIT |
| [tower-layer](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tower-service](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tracing](https://github.com/tokio-rs/tracing) | 0.1.44 | MIT |
| [tracing-core](https://github.com/tokio-rs/tracing) | 0.1.36 | MIT |
| [tray-icon](https://github.com/tauri-apps/tray-icon) | 0.25.1 | MIT OR Apache-2.0 |
| [try-lock](https://github.com/seanmonstar/try-lock) | 0.2.5 | MIT |
| [typeid](https://github.com/dtolnay/typeid) | 1.0.3 | MIT OR Apache-2.0 |
| [typenum](https://github.com/paholg/typenum) | 1.20.1 | MIT OR Apache-2.0 |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| [unicode-segmentation](https://github.com/unicode-rs/unicode-segmentation) | 1.13.3 | MIT OR Apache-2.0 |
| [untrusted](https://github.com/briansmith/untrusted) | 0.9.0 | ISC |
| [ureq](https://github.com/algesten/ureq) | 2.12.1 | MIT OR Apache-2.0 |
| [url](https://github.com/servo/rust-url) | 2.5.8 | MIT OR Apache-2.0 |
| [urlpattern](https://github.com/denoland/rust-urlpattern) | 0.6.0 | MIT |
| [utf_types](https://github.com/hsivonen/utf_types) | 1.0.0 | Apache-2.0 OR MIT |
| [utf8_iter](https://github.com/hsivonen/utf8_iter) | 1.1.0 | Apache-2.0 OR MIT |
| [uuid](https://github.com/uuid-rs/uuid) | 1.29.1 | Apache-2.0 OR MIT |
| [version_check](https://github.com/SergioBenitez/version_check) | 0.9.5 | MIT/Apache-2.0 |
| [version-compare](https://gitlab.com/timvisee/version-compare) | 0.2.1 | MIT |
| [vswhom](https://github.com/nabijaczleweli/vswhom.rs) | 0.1.0 | MIT |
| [vswhom-sys](https://github.com/nabijaczleweli/vswhom-sys.rs) | 0.1.3 | MIT |
| [walkdir](https://github.com/BurntSushi/walkdir) | 2.5.0 | Unlicense/MIT |
| [want](https://github.com/seanmonstar/want) | 0.3.2 | MIT |
| [wasi](https://github.com/bytecodealliance/wasi) | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip2](https://github.com/bytecodealliance/wasi-rs) | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.130 | MIT OR Apache-2.0 |
| [wasm-bindgen-futures](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures) | 0.4.80 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro) | 0.2.130 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro-support](https://github.com/wasm-bindgen/wasm-bindgen/tree/main/crates/macro-support) | 0.2.130 | MIT OR Apache-2.0 |
| [wasm-bindgen-shared](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared) | 0.2.130 | MIT OR Apache-2.0 |
| [wasm-streams](https://github.com/MattiasBuelens/wasm-streams/) | 0.5.0 | MIT OR Apache-2.0 |
| [web_atoms](https://github.com/servo/html5ever) | 0.2.6 | MIT OR Apache-2.0 |
| [web-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys) | 0.3.107 | MIT OR Apache-2.0 |
| [web-time](https://github.com/daxpedda/web-time) | 1.1.0 | MIT OR Apache-2.0 |
| [webkit2gtk](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webkit2gtk-sys](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webpki-roots](https://github.com/rustls/webpki-roots) | 0.26.11 | CDLA-Permissive-2.0 |
| [webpki-roots](https://github.com/rustls/webpki-roots) | 1.0.11 | CDLA-Permissive-2.0 |
| [webview2-com](https://github.com/wravery/webview2-rs) | 0.39.1 | MIT |
| [webview2-com-macros](https://github.com/wravery/webview2-rs) | 0.8.1 | MIT |
| [webview2-com-sys](https://github.com/wravery/webview2-rs) | 0.39.1 | MIT |
| [winapi](https://github.com/retep998/winapi-rs) | 0.3.9 | MIT/Apache-2.0 |
| [winapi-i686-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT/Apache-2.0 |
| [winapi-util](https://github.com/BurntSushi/winapi-util) | 0.1.11 | Unlicense OR MIT |
| [winapi-x86_64-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT/Apache-2.0 |
| [window-vibrancy](https://github.com/tauri-apps/tauri-plugin-vibrancy) | 0.8.1 | Apache-2.0 OR MIT |
| [windows](https://github.com/microsoft/windows-rs) | 0.62.2 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows-collections](https://github.com/microsoft/windows-rs) | 0.3.2 | MIT OR Apache-2.0 |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.62.2 | MIT OR Apache-2.0 |
| [windows-future](https://github.com/microsoft/windows-rs) | 0.3.2 | MIT OR Apache-2.0 |
| [windows-implement](https://github.com/microsoft/windows-rs) | 0.60.2 | MIT OR Apache-2.0 |
| [windows-interface](https://github.com/microsoft/windows-rs) | 0.59.3 | MIT OR Apache-2.0 |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-numerics](https://github.com/microsoft/windows-rs) | 0.3.1 | MIT OR Apache-2.0 |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.4.1 | MIT OR Apache-2.0 |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.5.1 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.45.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.52.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.61.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows-threading](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-version](https://github.com/microsoft/windows-rs) | 0.1.7 | MIT OR Apache-2.0 |
| [winnow](https://github.com/winnow-rs/winnow) | 0.5.40 | MIT |
| [winnow](https://github.com/winnow-rs/winnow) | 1.0.5 | MIT |
| [winreg](https://github.com/gentoo90/winreg-rs) | 0.56.0 | MIT |
| [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [writeable](https://github.com/unicode-org/icu4x) | 0.6.4 | Unicode-3.0 |
| [wry](https://github.com/tauri-apps/wry) | 0.57.1 | Apache-2.0 OR MIT |
| [x11](https://github.com/AltF02/x11-rs.git) | 2.21.0 | MIT |
| [x11-dl](https://github.com/AltF02/x11-rs.git) | 2.21.0 | MIT |
| [yoke](https://github.com/unicode-org/icu4x) | 0.8.4 | Unicode-3.0 |
| [yoke-derive](https://github.com/unicode-org/icu4x) | 0.8.4 | Unicode-3.0 |
| [zerofrom](https://github.com/unicode-org/icu4x) | 0.1.8 | Unicode-3.0 |
| [zerofrom-derive](https://github.com/unicode-org/icu4x) | 0.1.8 | Unicode-3.0 |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.1 | Apache-2.0 OR MIT |
| [zerotrie](https://github.com/unicode-org/icu4x) | 0.2.5 | Unicode-3.0 |
| [zerovec](https://github.com/unicode-org/icu4x) | 0.11.9 | Unicode-3.0 |
| [zerovec-derive](https://github.com/unicode-org/icu4x) | 0.11.7 | Unicode-3.0 |
| [zlib-rs](https://github.com/trifectatechfoundation/zlib-rs) | 0.6.8 | Zlib |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.23 | MIT |

</details>

## Notes (checked by hand)

**Result of the audit (November 2026):** everything game-sauce ships is under permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode and similar). **No GPL or AGPL code is shipped**, so nothing conflicts with game-sauce being MIT. One open item (the icon pictures) is listed at the end.

- **Mozilla Public Licence 2.0 (five Rust crates in the desktop app):** `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext` and `selectors`. MPL-2.0 asks that changes to *those files* be shared. game-sauce uses them unmodified, their source is public (linked in the table), and they are not a problem for the rest of the app staying MIT.
- **Dual-licensed crates:** a few crates offer a choice (for example `r-efi` is "MIT or Apache-2.0 or LGPL-2.1-or-later"). We take the MIT or Apache terms, so the LGPL option does not apply.
- **pdf.js** (Mozilla, Apache-2.0) is bundled unchanged in `public/vendor/pdfjs` with its licence file, to draw the first page of a PDF manual.
- **EmulatorJS and its cores are not shipped.** When someone presses *Play in browser*, their own browser downloads EmulatorJS from `cdn.emulatorjs.org`. game-sauce does not copy or redistribute it, which is why it stays out of the lists above. EmulatorJS is, as far as its project states, under the GPL (version 3), and some cores carry their own terms (a few are non-commercial). If game-sauce ever bundled EmulatorJS (for use without the internet), those terms would apply to the bundled files and this page would have to say so. Check its repository before doing that.
- **Linux web view:** the `.deb` and `.rpm` use the system's WebKitGTK and GTK libraries (LGPL), which are not copied into the package. The **AppImage** carries its own copies, which the LGPL allows; if you redistribute it, keep the AppImage's licence notices with it.
- **Windows web view:** the Windows app uses Microsoft's WebView2 runtime under Microsoft's own terms. macOS uses the system's WebKit.
- **Node.js** (shipped inside the desktop app and the Docker image) is MIT, with its own bundled components under permissive terms. **SQLite** inside `better-sqlite3` is in the public domain. The Docker image is built on the official `node` image (Debian), whose packages keep their own licences.
- **Our own pictures:** the logo, the language flags (simple drawings made for this project, not copies of anyone's artwork), the generated demo covers and the screenshots (an invented library) are ours. Console, game and company names and logos belong to their owners, as the website and README say.
- **The website** (gamesauce.app) loads one third-party script, the Buy Me a Coffee widget, from buymeacoffee.com, and is hosted on Cloudflare. It sets no cookies of its own and has no analytics.
- **Keeping notices:** MIT and Apache-2.0 ask that the copyright and licence notices travel with copies of the software. The Docker image and the server in the desktop app keep each npm package's licence file inside `node_modules`. The Rust crates in the desktop installers are not listed inside the installers themselves: this page is the attribution for them. A copy of this page could be included in the installers.

**Open item: the icons.** The 151 small pictures in `public/modern/icons` (the Modern look's icons) have no licence or source recorded in the repository. Many icon libraries are free to use but ask for credit or a notice. Their source needs to be written down here (library, author, licence), and any that require credit need to be credited. Until then they are the one part of this audit that cannot be signed off from the files alone.

