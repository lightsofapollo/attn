#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedIconsDir = path.join(projectRoot, 'src/lib/icons/vscode-generated');
const generatedModulePath = path.join(projectRoot, 'src/lib/vscode-icon-map.generated.ts');
const generatedReadmePath = path.join(generatedIconsDir, 'README.md');
const SUPPORTED_PACKS = ['material', 'eyecons', 'catppuccin', 'vscode-icons', 'seti'];
const DEFAULT_PACK = process.env.ATTN_DEFAULT_ICON_PACK || 'eyecons';

const APP_FILE_OVERRIDES = {
  'agents.md': 'file_type_agents.svg',
  'claude.md': 'file_type_claude.svg',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function writeFileIfChanged(filePath, content) {
  const next = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const prev = readFileIfExists(filePath);
  if (prev && Buffer.compare(prev, next) === 0) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function copyFileIfChanged(srcPath, destPath) {
  const next = fs.readFileSync(srcPath);
  const prev = readFileIfExists(destPath);
  if (prev && Buffer.compare(prev, next) === 0) return false;
  fs.writeFileSync(destPath, next);
  return true;
}

function safeLower(value) {
  return String(value ?? '').toLowerCase();
}

function iconFileFromDefinition(definitions, id) {
  const def = definitions[id];
  const relPath = def?.iconPath;
  if (!relPath) return null;
  return path.basename(relPath);
}

function toIconMap(rawMap, definitions) {
  const out = {};
  for (const [key, id] of Object.entries(rawMap ?? {})) {
    const file = iconFileFromDefinition(definitions, id);
    if (!file) continue;
    out[safeLower(key)] = file;
  }
  return out;
}

function parseDefaultPackArg(argv) {
  for (const arg of argv) {
    if (!arg.startsWith('--default-pack=')) continue;
    return arg.slice('--default-pack='.length).trim();
  }
  return DEFAULT_PACK;
}

function readTsObject(filePath, assignmentPattern, returnExpr) {
  let source = fs.readFileSync(filePath, 'utf8');
  source = source.replace(/^import[^\n]*\n/gm, '');
  source = source.replace(assignmentPattern, 'const extensions =');
  source = source.replace(/FileFormat\.\w+/g, "'svg'");
  source = source.replace(/export\s+\{[^}]+\}\s*;?/g, '');
  const fn = new Function(`const languages = {};\n${source}\nreturn ${returnExpr};`);
  return fn();
}

function loadEyeconsArray(filePath, exportName) {
  const source = fs.readFileSync(filePath, 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(new RegExp(`export\\s+let\\s+${exportName}\\s*:[^=]+=`), `const ${exportName} =`);
  const fn = new Function(`${source}\nreturn ${exportName};`);
  const arr = fn();
  if (!Array.isArray(arr)) {
    throw new Error(`Expected array export ${exportName} in ${filePath}`);
  }
  return arr;
}

function loadCatppuccinFileMaps(filePath) {
  let source = fs.readFileSync(filePath, 'utf8');
  source = source.replace(/type FileIcons[\s\S]*?const fileIcons: FileIcons =/, 'const fileIcons =');
  source = source.replace(/export\s+\{[^}]+\}\s*;?/g, '');
  const fn = new Function(`${source}\nreturn { fileExtensions, fileNames };`);
  return fn();
}

function loadCatppuccinFolderMaps(filePath) {
  let source = fs.readFileSync(filePath, 'utf8');
  source = source.replace(/type FolderIcons[\s\S]*?const folderIcons: FolderIcons =/, 'const folderIcons =');
  source = source.replace(/export\s+\{[^}]+\}\s*;?/g, '');
  const fn = new Function(`${source}\nreturn { folderNames };`);
  return fn();
}

function buildMappingsFromVsCodeTheme(themeJson) {
  const defs = themeJson.iconDefinitions ?? {};
  const fileNames = toIconMap(themeJson.fileNames ?? {}, defs);
  const fileExtensions = toIconMap(themeJson.fileExtensions ?? {}, defs);
  const folderNames = toIconMap(
    { ...(themeJson.folderNames ?? {}), ...(themeJson.rootFolderNames ?? {}) },
    defs,
  );
  const folderNamesExpanded = toIconMap(
    { ...(themeJson.folderNamesExpanded ?? {}), ...(themeJson.rootFolderNamesExpanded ?? {}) },
    defs,
  );

  const defaultFile = iconFileFromDefinition(defs, themeJson.file) ?? 'file.svg';
  const defaultFolder = iconFileFromDefinition(defs, themeJson.folder) ?? 'folder.svg';
  const defaultFolderExpanded =
    iconFileFromDefinition(defs, themeJson.folderExpanded) ?? 'folder-open.svg';

  return {
    defaultFile,
    defaultFolder,
    defaultFolderExpanded,
    fileNames,
    fileExtensions,
    folderNames,
    folderNamesExpanded,
  };
}

function withPrefix(prefix, iconFile) {
  return `${prefix}__${iconFile}`;
}

function normalizeExt(ext) {
  const lower = safeLower(ext);
  return lower.startsWith('.') ? lower.slice(1) : lower;
}

function normalizeInlineSvg(svg) {
  let out = String(svg ?? '').trim();
  if (!out.startsWith('<svg')) return out;
  if (!/xmlns=/.test(out)) {
    out = out.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return out;
}

function buildEyeconsMappings(eyeconsRoot) {
  const fileIcons = loadEyeconsArray(path.join(eyeconsRoot, 'data/file-icons.ts'), 'fileIcons');
  const baseIcons = loadEyeconsArray(path.join(eyeconsRoot, 'data/base-icons.ts'), 'baseIcons');

  const fileNames = {};
  const fileExtensions = {};

  for (const item of fileIcons) {
    const id = safeLower(item?.id);
    if (!id) continue;
    const iconFile = withPrefix('eyecons', `${id}.svg`);
    for (const file of item?.files ?? []) {
      fileNames[safeLower(file)] = iconFile;
    }
    for (const ext of item?.extensions ?? []) {
      fileExtensions[normalizeExt(ext)] = iconFile;
    }
  }

  const baseById = new Map(baseIcons.map((icon) => [safeLower(icon?.id), icon]));
  const defaultFile = baseById.has('file')
    ? withPrefix('eyecons', 'file.svg')
    : withPrefix('eyecons', 'file.svg');
  const defaultFolder = baseById.has('folder')
    ? withPrefix('eyecons', 'folder.svg')
    : withPrefix('eyecons', 'folder.svg');
  const defaultFolderExpanded = baseById.has('folder-open')
    ? withPrefix('eyecons', 'folder-open.svg')
    : withPrefix('eyecons', 'folder-open.svg');

  return {
    defaultFile,
    defaultFolder,
    defaultFolderExpanded,
    fileNames,
    fileExtensions,
    folderNames: {},
    folderNamesExpanded: {},
  };
}

function buildCatppuccinMappings(catppuccinRoot) {
  const { fileExtensions, fileNames } = loadCatppuccinFileMaps(
    path.join(catppuccinRoot, 'src/defaults/fileIcons.ts'),
  );
  const { folderNames } = loadCatppuccinFolderMaps(
    path.join(catppuccinRoot, 'src/defaults/folderIcons.ts'),
  );

  const outFileNames = {};
  const outFileExtensions = {};
  const outFolderNames = {};
  const outFolderNamesExpanded = {};

  for (const [name, icon] of Object.entries(fileNames ?? {})) {
    outFileNames[safeLower(name)] = withPrefix('catppuccin', `${icon}.svg`);
  }
  for (const [ext, icon] of Object.entries(fileExtensions ?? {})) {
    outFileExtensions[normalizeExt(ext)] = withPrefix('catppuccin', `${icon}.svg`);
  }
  for (const [folder, icon] of Object.entries(folderNames ?? {})) {
    const closed = withPrefix('catppuccin', `${icon}.svg`);
    const opened = withPrefix('catppuccin', `${icon}_open.svg`);
    outFolderNames[safeLower(folder)] = closed;
    outFolderNamesExpanded[safeLower(folder)] = opened;
  }

  return {
    defaultFile: withPrefix('catppuccin', '_file.svg'),
    defaultFolder: withPrefix('catppuccin', '_folder.svg'),
    defaultFolderExpanded: withPrefix('catppuccin', '_folder_open.svg'),
    fileNames: outFileNames,
    fileExtensions: outFileExtensions,
    folderNames: outFolderNames,
    folderNamesExpanded: outFolderNamesExpanded,
  };
}

function buildVscodeIconsMappings(vscodeIconsRoot) {
  const extManifest = readTsObject(
    path.join(vscodeIconsRoot, 'src/iconsManifest/supportedExtensions.ts'),
    /export const extensions: IFileCollection =/,
    'extensions',
  );
  const folderManifest = readTsObject(
    path.join(vscodeIconsRoot, 'src/iconsManifest/supportedFolders.ts'),
    /export const extensions: IFolderCollection =/,
    'extensions',
  );

  const fileNames = {};
  const fileExtensions = {};
  const folderNames = {};
  const folderNamesExpanded = {};

  for (const item of extManifest.supported ?? []) {
    if (item?.disabled) continue;
    const icon = safeLower(item?.icon);
    if (!icon) continue;
    const iconFile = withPrefix('vscode-icons', `file_type_${icon}.svg`);
    for (const value of item.extensions ?? []) {
      if (item.filename) {
        fileNames[safeLower(value)] = iconFile;
      } else {
        fileExtensions[normalizeExt(value)] = iconFile;
      }
    }
  }

  for (const item of folderManifest.supported ?? []) {
    if (item?.disabled) continue;
    const icon = safeLower(item?.icon);
    if (!icon) continue;
    const closed = withPrefix('vscode-icons', `folder_type_${icon}.svg`);
    const opened = withPrefix('vscode-icons', `folder_type_${icon}_opened.svg`);
    for (const name of item.extensions ?? []) {
      const key = safeLower(name);
      folderNames[key] = closed;
      folderNamesExpanded[key] = opened;
    }
  }

  return {
    defaultFile: withPrefix('vscode-icons', 'default_file.svg'),
    defaultFolder: withPrefix('vscode-icons', 'default_folder.svg'),
    defaultFolderExpanded: withPrefix('vscode-icons', 'default_folder_opened.svg'),
    fileNames,
    fileExtensions,
    folderNames,
    folderNamesExpanded,
  };
}

function buildSetiMappings(setiPkgRoot, setiVirtualIcons) {
  const defs = readJson(path.join(setiPkgRoot, 'lib/definitions.json'));
  const svgs = readJson(path.join(setiPkgRoot, 'lib/icons.json'));

  const fileNames = {};
  const fileExtensions = {};

  for (const [name, [iconName]] of Object.entries(defs.files ?? {})) {
    fileNames[safeLower(name)] = withPrefix('seti', `${iconName}.svg`);
  }
  for (const [ext, [iconName]] of Object.entries(defs.extensions ?? {})) {
    fileExtensions[normalizeExt(ext)] = withPrefix('seti', `${iconName}.svg`);
  }
  for (const [pattern, [iconName]] of defs.partials ?? []) {
    fileNames[safeLower(pattern)] = withPrefix('seti', `${iconName}.svg`);
  }

  for (const [name, svg] of Object.entries(svgs)) {
    setiVirtualIcons.set(withPrefix('seti', `${name}.svg`), normalizeInlineSvg(svg));
  }

  return {
    defaultFile: withPrefix('seti', 'default.svg'),
    defaultFolder: withPrefix('seti', 'folder.svg'),
    defaultFolderExpanded: withPrefix('seti', 'folder.svg'),
    fileNames,
    fileExtensions,
    folderNames: {},
    folderNamesExpanded: {},
  };
}

function writeGeneratedModule(packMappings, copiedIcons, defaultPack) {
  const lines = [];
  lines.push('// AUTO-GENERATED by scripts/generate-vscode-icon-map.mjs');
  lines.push('// Do not edit by hand.');
  lines.push('');

  const importVarByFile = new Map();
  copiedIcons.forEach((file, idx) => {
    const varName = `icon_${idx}`;
    importVarByFile.set(file, varName);
    lines.push(`import ${varName} from '$lib/icons/vscode-generated/${file}';`);
  });

  lines.push('');
  lines.push(`export type IconPack = ${SUPPORTED_PACKS.map((pack) => JSON.stringify(pack)).join(' | ')};`);
  lines.push('');

  const emitMap = (name, mapObj) => {
    lines.push(`const ${name}: Record<string, string> = {`);
    for (const [k, v] of Object.entries(mapObj).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${JSON.stringify(k)}: ${importVarByFile.get(v)},`);
    }
    lines.push('};');
    lines.push('');
  };

  for (const pack of SUPPORTED_PACKS) {
    const mappings = packMappings[pack];
    const prefix = pack.toUpperCase().replace(/-/g, '_');
    emitMap(`${prefix}_FILE_NAME_ICONS`, mappings.fileNames);
    emitMap(`${prefix}_FILE_EXTENSION_ICONS`, mappings.fileExtensions);
    emitMap(`${prefix}_FOLDER_NAME_ICONS`, mappings.folderNames);
    emitMap(`${prefix}_FOLDER_NAME_OPEN_ICONS`, mappings.folderNamesExpanded);

    lines.push(`const ${prefix}_DEFAULT_FILE_ICON = ${importVarByFile.get(mappings.defaultFile)};`);
    lines.push(`const ${prefix}_DEFAULT_FOLDER_ICON = ${importVarByFile.get(mappings.defaultFolder)};`);
    lines.push(`const ${prefix}_DEFAULT_FOLDER_OPEN_ICON = ${importVarByFile.get(mappings.defaultFolderExpanded)};`);
    lines.push('');
  }

  lines.push('export const ICON_PACKS: Record<IconPack, {');
  lines.push('  DEFAULT_FILE_ICON: string;');
  lines.push('  DEFAULT_FOLDER_ICON: string;');
  lines.push('  DEFAULT_FOLDER_OPEN_ICON: string;');
  lines.push('  FILE_NAME_ICONS: Record<string, string>;');
  lines.push('  FILE_EXTENSION_ICONS: Record<string, string>;');
  lines.push('  FOLDER_NAME_ICONS: Record<string, string>;');
  lines.push('  FOLDER_NAME_OPEN_ICONS: Record<string, string>;');
  lines.push('}> = {');

  for (const pack of SUPPORTED_PACKS) {
    const prefix = pack.toUpperCase().replace(/-/g, '_');
    lines.push(`  ${JSON.stringify(pack)}: {`);
    lines.push(`    DEFAULT_FILE_ICON: ${prefix}_DEFAULT_FILE_ICON,`);
    lines.push(`    DEFAULT_FOLDER_ICON: ${prefix}_DEFAULT_FOLDER_ICON,`);
    lines.push(`    DEFAULT_FOLDER_OPEN_ICON: ${prefix}_DEFAULT_FOLDER_OPEN_ICON,`);
    lines.push(`    FILE_NAME_ICONS: ${prefix}_FILE_NAME_ICONS,`);
    lines.push(`    FILE_EXTENSION_ICONS: ${prefix}_FILE_EXTENSION_ICONS,`);
    lines.push(`    FOLDER_NAME_ICONS: ${prefix}_FOLDER_NAME_ICONS,`);
    lines.push(`    FOLDER_NAME_OPEN_ICONS: ${prefix}_FOLDER_NAME_OPEN_ICONS,`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');

  lines.push(`export const DEFAULT_ICON_PACK: IconPack = ${JSON.stringify(defaultPack)};`);
  lines.push('');
  lines.push('// Back-compat exports (default pack)');
  lines.push('export const DEFAULT_FILE_ICON = ICON_PACKS[DEFAULT_ICON_PACK].DEFAULT_FILE_ICON;');
  lines.push('export const DEFAULT_FOLDER_ICON = ICON_PACKS[DEFAULT_ICON_PACK].DEFAULT_FOLDER_ICON;');
  lines.push('export const DEFAULT_FOLDER_OPEN_ICON = ICON_PACKS[DEFAULT_ICON_PACK].DEFAULT_FOLDER_OPEN_ICON;');
  lines.push('export const FILE_NAME_ICONS = ICON_PACKS[DEFAULT_ICON_PACK].FILE_NAME_ICONS;');
  lines.push('export const FILE_EXTENSION_ICONS = ICON_PACKS[DEFAULT_ICON_PACK].FILE_EXTENSION_ICONS;');
  lines.push('export const FOLDER_NAME_ICONS = ICON_PACKS[DEFAULT_ICON_PACK].FOLDER_NAME_ICONS;');
  lines.push('export const FOLDER_NAME_OPEN_ICONS = ICON_PACKS[DEFAULT_ICON_PACK].FOLDER_NAME_OPEN_ICONS;');

  return writeFileIfChanged(generatedModulePath, `${lines.join('\n')}\n`);
}

function writeReadme(materialVersion, copiedIcons, defaultPack) {
  const body = `# Generated Icon Packs\n\nThis directory is auto-generated by:\n- \`web/scripts/generate-vscode-icon-map.mjs\`\n\nIncluded runtime packs:\n${SUPPORTED_PACKS.map((pack) => `- \`${pack}\``).join('\n')}\n\nDefault pack:\n- \`${defaultPack}\`\n\nMaterial source:\n- \`material-icon-theme@${materialVersion}\`\n\nIncluded SVG files:\n${copiedIcons.map((f) => `- \`${f}\``).join('\n')}\n\nLicense:\n- Material Icon Theme: MIT\n- Eyecons: MIT\n- Catppuccin Icons: MIT\n- VSCode Icons: MIT\n- Seti Icons: MIT\n`;
  return writeFileIfChanged(generatedReadmePath, body);
}

function main() {
  const defaultPack = parseDefaultPackArg(process.argv.slice(2));
  if (!SUPPORTED_PACKS.includes(defaultPack)) {
    throw new Error(`Unsupported --default-pack value: ${defaultPack}. Supported: ${SUPPORTED_PACKS.join(', ')}`);
  }

  const materialEntryPath = require.resolve('material-icon-theme', { paths: [projectRoot] });
  const materialRoot = path.resolve(path.dirname(materialEntryPath), '..', '..');
  const materialPkg = readJson(path.join(materialRoot, 'package.json'));
  const materialTheme = readJson(path.join(materialRoot, 'dist/material-icons.json'));
  const materialIconsDir = path.join(materialRoot, 'icons');

  const eyeconsPkgPath = require.resolve('eyecons/package.json', { paths: [projectRoot] });
  const eyeconsRoot = path.dirname(eyeconsPkgPath);

  const catppuccinPkgPath = require.resolve('catppuccin-vsc-icons/package.json', { paths: [projectRoot] });
  const catppuccinRoot = path.dirname(catppuccinPkgPath);
  const catppuccinIconsDir = path.join(catppuccinRoot, 'icons/latte');

  const vscodeIconsPkgPath = require.resolve('vscode-icons/package.json', { paths: [projectRoot] });
  const vscodeIconsRoot = path.dirname(vscodeIconsPkgPath);
  const vscodeIconsIconsDir = path.join(vscodeIconsRoot, 'icons');

  const setiPkgPath = require.resolve('seti-file-icons/package.json', { paths: [projectRoot] });
  const setiPkgRoot = path.dirname(setiPkgPath);
  const setiVirtualIcons = new Map();

  const packMappings = {
    material: buildMappingsFromVsCodeTheme(materialTheme),
    eyecons: buildEyeconsMappings(eyeconsRoot),
    catppuccin: buildCatppuccinMappings(catppuccinRoot),
    'vscode-icons': buildVscodeIconsMappings(vscodeIconsRoot),
    seti: buildSetiMappings(setiPkgRoot, setiVirtualIcons),
  };

  const usedIcons = new Set();
  for (const mappings of Object.values(packMappings)) {
    usedIcons.add(mappings.defaultFile);
    usedIcons.add(mappings.defaultFolder);
    usedIcons.add(mappings.defaultFolderExpanded);
    for (const file of Object.values(mappings.fileNames)) usedIcons.add(file);
    for (const file of Object.values(mappings.fileExtensions)) usedIcons.add(file);
    for (const file of Object.values(mappings.folderNames)) usedIcons.add(file);
    for (const file of Object.values(mappings.folderNamesExpanded)) usedIcons.add(file);
  }

  ensureDir(generatedIconsDir);
  const copied = [];
  let changedIconFiles = 0;

  for (const iconFile of Array.from(usedIcons).sort()) {
    const target = path.join(generatedIconsDir, iconFile);

    if (setiVirtualIcons.has(iconFile)) {
      if (writeFileIfChanged(target, setiVirtualIcons.get(iconFile))) changedIconFiles += 1;
      copied.push(iconFile);
      continue;
    }

    let sourcePath = null;
    if (iconFile.startsWith('eyecons__')) {
      const file = iconFile.replace(/^eyecons__/, '');
      const fromFile = path.join(eyeconsRoot, 'icons/files', file);
      const fromBase = path.join(eyeconsRoot, 'icons/base', file);
      sourcePath = fs.existsSync(fromFile) ? fromFile : (fs.existsSync(fromBase) ? fromBase : null);
    } else if (iconFile.startsWith('catppuccin__')) {
      sourcePath = path.join(catppuccinIconsDir, iconFile.replace(/^catppuccin__/, ''));
    } else if (iconFile.startsWith('vscode-icons__')) {
      sourcePath = path.join(vscodeIconsIconsDir, iconFile.replace(/^vscode-icons__/, ''));
    } else {
      sourcePath = path.join(materialIconsDir, iconFile);
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`Missing icon asset: ${iconFile}`);
    }

    if (copyFileIfChanged(sourcePath, target)) changedIconFiles += 1;
    copied.push(iconFile);
  }

  const currentFiles = new Set(copied);
  for (const existing of fs.readdirSync(generatedIconsDir)) {
    if (existing === 'README.md') continue;
    if (currentFiles.has(existing)) continue;
    fs.rmSync(path.join(generatedIconsDir, existing), { force: true });
    changedIconFiles += 1;
  }

  const moduleChanged = writeGeneratedModule(packMappings, copied, defaultPack);
  const readmeChanged = writeReadme(materialPkg.version ?? 'unknown', copied, defaultPack);
  const changedFiles = changedIconFiles + (moduleChanged ? 1 : 0) + (readmeChanged ? 1 : 0);

  if (changedFiles === 0) {
    console.log(`Icon map already up to date (${copied.length} SVG assets across ${SUPPORTED_PACKS.length} packs).`);
  } else {
    console.log(`Generated icon maps (${SUPPORTED_PACKS.join(', ')}) with ${copied.length} SVG assets (${changedFiles} files updated).`);
  }
}

main();
