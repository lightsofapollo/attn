// The upstream icon packs that are NOT published to npm, pinned by commit.
//
// `eyecons` on npm is an unrelated 0.0.1 placeholder; `catppuccin-vsc-icons`
// and `vscode-icons` are not published at all. They used to be `github:` deps,
// which made every `npm ci` non-hermetic: npm cloned each repo and resolved
// THAT project's own floating package.json against the live registry, so an
// unrelated upstream publish could — and did, on 2026-09-03 — break our
// install with no change in this repo (attn-6q7b).
//
// Now they are fetched as plain source tarballs, only when someone refreshes
// the icons, and the GENERATED output is committed. A normal `npm ci` needs
// none of this.
//
// To upgrade a pack: change its `commit` here, run `npm run refresh:icons`,
// and commit the regenerated output.

export const ICON_PACK_PINS = [
  {
    name: 'eyecons',
    repo: 'azat-io/eyecons',
    commit: '04dd62a6ba7102f1cdcf094b91f34d88e8e8ea44',
    license: 'MIT',
    // Only these are read by generate-vscode-icon-map.mjs.
    paths: ['icons/files', 'icons/base', 'data/file-icons.ts', 'data/base-icons.ts'],
  },
  {
    name: 'catppuccin-vsc-icons',
    repo: 'catppuccin/vscode-icons',
    commit: 'b6915da9f6889b683a110aa747de96c2820a537d',
    license: 'MIT',
    paths: ['icons/latte'],
  },
  {
    name: 'vscode-icons',
    repo: 'vscode-icons/vscode-icons',
    commit: '664b3de61a984888ee748de5b44897019b26ad3e',
    license: 'MIT',
    paths: ['icons', 'package.json'],
  },
];
