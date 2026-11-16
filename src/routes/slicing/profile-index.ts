import { promises as fs } from "fs";
import * as path from "path";
import { AppError } from "../../middleware/error";

// One index "preset name -> file" per category folder of a profile root,
// shared by the preset listing, the inherits resolver and the companion
// lookup, so the three cannot disagree about what a name means.
//
// It exists because a preset's name is not its file name, and its file is not
// necessarily in the top folder of its category:
//
//   - brands keep their presets in a subfolder (`filament/P1P/`,
//     `filament/Polymaker/`, `filament/SUNLU/` in the BBL tree; nearly
//     everything in OrcaFilamentLibrary), 150 files a flat `readdir` never saw;
//   - a name may hold a "/" (`Bambu Support For PLA/PETG @BBL A1`) and is then
//     stored as `Bambu Support For PLA-PETG @BBL A1.json`, so composing
//     `<name>.json` points into a folder that does not exist.
//
// The slicers themselves go through the vendor manifest (`BBL.json`,
// name -> sub_path). Walking the tree and reading each file's own `name`
// gives the same mapping without depending on where an image put the
// manifest, and covers a file the manifest forgot.
//
// THE KEY of a file is its `name` field; a file without one is known by its
// file name (minus `.json`). Nothing is ever found by guessing a file name
// from a preset name.
//
// DUPLICATES: two files of one folder tree with the same key make that name
// AMBIGUOUS. It is taken out of the index — never resolved to "the first
// one" — a lookup of it is an error that names both files, and the listing
// does not offer it. The shipped trees have none (measured on OrcaSlicer
// 2.5.0 and BambuStudio 02.09.01.70); this is for a tree somebody edited.

export type IndexedJson = Record<string, unknown> & {
  name?: string;
  inherits?: string;
  instantiation?: string;
};

export interface IndexedProfile {
  /** The key the file is indexed under. */
  name: string;
  /** Absolute path. */
  file: string;
  /** Path inside the category folder, with forward slashes. */
  rel: string;
  /** Parsed content. Shared with every caller: copy before changing it. */
  json: IndexedJson;
}

export interface IndexedCompanion {
  /** File name minus `.json`: `<owner> template <setting key>`. */
  baseName: string;
  file: string;
  /** Absent when the file is not valid JSON; `error` then says why. */
  json?: IndexedJson;
  error?: string;
}

export interface CategoryIndex {
  dir: string;
  byName: Map<string, IndexedProfile>;
  /** Name -> every file that claims it (sorted), for names claimed twice. */
  ambiguous: Map<string, string[]>;
  /** File name minus `.json` -> parse error, for files that are not JSON. */
  invalid: Map<string, { rel: string; error: string }>;
  /** Owner preset name -> its companion files (see profile-resolver.ts). */
  companions: Map<string, IndexedCompanion[]>;
}

// Bundled presets may keep a setting in a companion file named
// `<preset name> template <setting key>.json`. Nothing in the preset points
// at it — the GUI finds it by this file name — so companions are the one
// thing here that IS keyed by file name.
export const TEMPLATE_MARKER = " template ";

const JSON_EXT = ".json";

type CacheEntry = { listing: string; index: CategoryIndex };
const cache = new Map<string, CacheEntry>();
// Builds in progress, by folder, for the listing they were started from.
const building = new Map<
  string,
  { listing: string; index: Promise<CategoryIndex> }
>();

/** Forget every index. For tests that rewrite a file in place. */
export function clearProfileIndexCache(): void {
  cache.clear();
  building.clear();
}

/**
 * The index of one category folder (`<root>/filament`, …), built once.
 *
 * "Once" is checked against the folder's file LISTING, not a timer: every
 * call lists the tree (names only — a couple of thousand entries, no file is
 * opened) and reuses the parsed index while that listing is unchanged. An
 * image's profile tree never changes, so in production this is one build per
 * process; a tree that gains or loses a file is indexed again. A file
 * rewritten in place under the same name is not noticed.
 *
 * A folder that does not exist is an empty index: a category with no bundled
 * tree has no presets and no companions.
 */
export async function loadCategoryIndex(dir: string): Promise<CategoryIndex> {
  const files = await listJsonFiles(dir);
  const listing = files.join("\n");
  const cached = cache.get(dir);
  if (cached && cached.listing === listing) {
    return cached.index;
  }
  // Single flight: requests that arrive together on a cold start share one
  // build instead of each parsing the whole category.
  const flying = building.get(dir);
  if (flying && flying.listing === listing) {
    return flying.index;
  }
  const build = buildIndex(dir, files);
  const flight = { listing, index: build };
  building.set(dir, flight);
  try {
    const index = await build;
    cache.set(dir, { listing, index });
    return index;
  } finally {
    if (building.get(dir) === flight) {
      building.delete(dir);
    }
  }
}

/**
 * The file a preset name stands for, or `undefined` when no file has it.
 *
 * Throws for an ambiguous name: picking one of two files silently would
 * slice with settings nobody chose.
 */
export function lookupProfile(
  index: CategoryIndex,
  name: string,
): IndexedProfile | undefined {
  const twins = index.ambiguous.get(name);
  if (twins) {
    throw new AppError(
      500,
      `Bundled profile name is ambiguous: "${name}"`,
      `dir=${index.dir} files=${twins.join(", ")}`,
    );
  }
  return index.byName.get(name);
}

/** Every `.json` under `dir`, as sorted forward-slash relative paths. */
async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const sub = pending.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true });
    } catch {
      // Missing or unreadable folder: nothing to index there.
      continue;
    }
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      // Links are not followed, so the walk cannot loop.
      if (entry.isDirectory()) {
        pending.push(rel);
      } else if (entry.isFile() && entry.name.endsWith(JSON_EXT)) {
        out.push(rel);
      }
    }
  }
  // Sorted so that the index, the ambiguity report and the listing built
  // from it do not depend on the order a filesystem returns entries in.
  return out.sort();
}

async function buildIndex(dir: string, files: string[]): Promise<CategoryIndex> {
  const index: CategoryIndex = {
    dir,
    byName: new Map(),
    ambiguous: new Map(),
    invalid: new Map(),
    companions: new Map(),
  };

  for (const rel of files) {
    const file = path.join(dir, rel);
    const baseName = path.posix.basename(rel).slice(0, -JSON_EXT.length);

    let json: IndexedJson | undefined;
    let error: string | undefined;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as IndexedJson;
      } else {
        // A list or a scalar is some other kind of data file, not a preset.
        continue;
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        error = err.message;
      } else {
        // Listed a moment ago, so a race or a permission problem. It is not
        // in the index; a preset that needs it is told it was not found.
        continue;
      }
    }

    // Last occurrence, so the owner keeps every earlier word: the marker is
    // a separator before the setting key. Index 0 would mean a file named
    // " template x.json" with no owner.
    const marker = baseName.lastIndexOf(TEMPLATE_MARKER);
    if (marker > 0) {
      const owner = baseName.slice(0, marker);
      const companion: IndexedCompanion = { baseName, file, json, error };
      const list = index.companions.get(owner);
      if (list) list.push(companion);
      else index.companions.set(owner, [companion]);
    }

    if (!json) {
      index.invalid.set(baseName, { rel, error: error ?? "not valid JSON" });
      continue;
    }

    const name =
      typeof json.name === "string" && json.name.length > 0
        ? json.name
        : baseName;
    const twins = index.ambiguous.get(name);
    if (twins) {
      twins.push(rel);
      continue;
    }
    const first = index.byName.get(name);
    if (first) {
      index.byName.delete(name);
      index.ambiguous.set(name, [first.rel, rel]);
      continue;
    }
    index.byName.set(name, { name, file, rel, json });
  }

  for (const [name, twins] of index.ambiguous) {
    console.warn(
      `Bundled profile name "${name}" is claimed by ${twins.length} files in ${dir} ` +
        `(${twins.join(", ")}); it is not offered and cannot be resolved.`,
    );
  }

  return index;
}
