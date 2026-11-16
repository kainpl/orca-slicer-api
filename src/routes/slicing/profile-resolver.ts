import * as path from "path";
import { AppError } from "../../middleware/error";
import {
  loadCategoryIndex,
  lookupProfile,
  type CategoryIndex,
  type IndexedProfile,
} from "./profile-index";

export type ProfileCategory = "machine" | "process" | "filament";

export type ProfileJson = Record<string, unknown> & {
  type?: string;
  name?: string;
  inherits?: string;
};

export interface ResolveOptions {
  bundledProfilesPath: string;
  // OrcaSlicer's filament library, the tree a filament parent is looked for
  // in when the vendor's does not have it. See getFilamentLibraryPath.
  libraryProfilesPath?: string;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 16;

// Bundled presets may keep a setting in a companion file named
// `<preset name> template <setting key>.json` instead of inline. Nothing in
// the preset itself points at them — the GUI finds them by this name — so a
// resolver that only walks `inherits` never sees them.
//
// It is not a corner case. Every one of the 56 instantiable BBL machine
// presets omits `machine_start_gcode` from its own file and from every
// ancestor bar `fdm_machine_common`, whose value is a 577-character generic
// stub. 29 of them ship the real block — 6.5 KB to 21 KB, per model — in a
// companion; the remaining 27 are the 0.2/0.6/0.8 nozzle variants, which
// inherit from their 0.4 sibling and so pick the companion up through the
// walk below. The same layout carries machine_end_gcode,
// change_filament_gcode, layer_change_gcode and time_lapse_gcode.
//
// Losing machine_start_gcode is not cosmetic: it holds the `M620` AMS load
// macros and the `M1002 gcode_claim_action` calls, so a print sliced without
// it heats the bed, moves the toolhead and extrudes nothing while reporting
// no preparation stage (bambuddy#2838).
// Copied from a companion only when the preset does not define the key
// itself, so these identity fields never leak across. `name` would rename
// the preset to "… template machine_start_gcode" and `instantiation: false`
// would mark it unusable — both are the companion's own bookkeeping, not
// settings it contributes.
const TEMPLATE_IDENTITY_KEYS = new Set([
  "name",
  "inherits",
  "instantiation",
  "type",
  "from",
]);

/** `error` of the refusal for a preset whose `inherits` chain is broken. */
export const PRESET_UNRESOLVED = "preset_unresolved";

/**
 * The refusal for a preset whose chain names a parent this slicer does not
 * have — the preset's own parent or one further up.
 *
 * 422, not 500: nothing is broken here, the caller named a preset this
 * image's profile tree cannot complete. `preset` is the name the caller's
 * profile carries (null when it has none) and `missing_parent` the link that
 * was not found; for the stub of a stock preset the two are the same name.
 */
export function presetUnresolved(
  category: ProfileCategory,
  preset: string | null,
  missingParent: string,
): AppError {
  const message =
    preset === null || preset === missingParent
      ? `Preset "${missingParent}" is not among this slicer's ${category} profiles`
      : `Preset "${preset}" cannot be resolved: its parent "${missingParent}" is not among this slicer's ${category} profiles`;
  return new AppError(
    422,
    message,
    "Nothing was sliced: without the parent the slicer would fill every setting " +
      "the preset does not state itself with its built-in defaults.",
    PRESET_UNRESOLVED,
    { category, preset, missing_parent: missingParent },
  );
}

// `--load-settings` does not run the GUI's preset-registry resolver.
// Required fields like layer_change_gcode live on parent templates
// (fdm_machine_common etc.) that the CLI will NOT pull in implicitly.
// The resolver therefore walks the chain fully — to the root — and emits
// a flat profile with everything baked in.
//
// A parent that is not in the tree REFUSES the request (`presetUnresolved`).
// It used to be dropped silently, on the reasoning that the CLI ignores an
// unresolvable `inherits` too. It does — and then slices on its compiled-in
// defaults and reports success: a PETG preset whose parent this image
// predates came back as PLA at 200 C, a preset with "/" in its name sliced
// on defaults for every printer. A profile that is complete in itself must
// not carry an `inherits` it does not need.
export async function resolveProfile(
  profile: ProfileJson,
  category: ProfileCategory,
  options: ResolveOptions,
): Promise<ProfileJson> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const presetName =
    typeof profile.name === "string" && profile.name.length > 0
      ? profile.name
      : null;
  let current: ProfileJson = { ...profile };
  stripUserSentinels(current);
  let depth = 0;
  // The nearest ancestor a user could have picked in the GUI: the stock
  // preset this profile is a copy of, if it is one. See the end of the walk.
  let stockParent: string | undefined;

  // One index for the whole walk: every ancestor is looked up by its NAME,
  // wherever in the category's tree its file sits and whatever that file is
  // called (see profile-index.ts). The same index lists the companions, and
  // it discovers their keys instead of hardcoding today's five, so a
  // companion for a new setting in a future bundle is picked up.
  //
  // Filaments have a second tree: OrcaSlicer's filament library, searched
  // after the vendor's. The two share NAMES with different content — both
  // have an `fdm_filament_pla`, 94 names in all in OrcaSlicer 2.5.0 — so the
  // walk never goes back: once a parent was found in the library, everything
  // above it is the library's. A vendor preset is completed from the
  // vendor's bases, a library preset from the library's, as in the slicer.
  const roots = [path.join(options.bundledProfilesPath, category)];
  if (category === "filament" && options.libraryProfilesPath) {
    roots.push(path.join(options.libraryProfilesPath, category));
  }
  const indexes = await Promise.all(roots.map(loadCategoryIndex));
  let rootAt = 0;

  while (
    typeof current.inherits === "string" &&
    current.inherits.length > 0
  ) {
    if (depth >= maxDepth) {
      throw new AppError(
        500,
        "Profile inheritance chain exceeded maximum depth",
        `category=${category} depth=${depth} stopped at inherits=${current.inherits}`,
      );
    }

    const parentName = current.inherits;
    let found: IndexedProfile | undefined;
    for (let at = rootAt; at < indexes.length; at += 1) {
      // Throws for a name two files claim: see the duplicate rule in
      // profile-index.ts.
      found = lookupProfile(indexes[at], parentName);
      if (found) {
        rootAt = at;
        break;
      }
    }
    if (!found) {
      // A broken file cannot say what it is called, so it is recognised by
      // its file name — and reported, not passed over as a missing parent.
      for (const index of indexes.slice(rootAt)) {
        const broken = index.invalid.get(parentName);
        if (broken) {
          throw new AppError(
            500,
            `Bundled profile is not valid JSON: "${parentName}"`,
            `category=${category} path=${path.join(index.dir, broken.rel)} ${broken.error}`,
          );
        }
      }
      throw presetUnresolved(category, presetName, parentName);
    }

    if (stockParent === undefined && found.json.instantiation === "true") {
      stockParent = found.name;
    }

    // A copy: the index hands out the one parsed object every resolution
    // shares, and the companions below are folded into it in place.
    const parent: ProfileJson = { ...found.json };

    // Fold the companions into the ancestor *before* merging, so they carry
    // that ancestor's precedence: below anything a descendant or the user's
    // own delta already set, above whatever the ancestor's own parents
    // provide. That ordering is what makes the generic
    // `fdm_machine_common` value lose to the model's real block, and what
    // lets a 0.6 nozzle preset inherit its 0.4 sibling's companion.
    applyCompanionTemplates(parent, parentName, category, indexes[rootAt]);

    current = mergeProfiles(parent, current);
    depth += 1;
  }

  // After full flattening the output is functionally a system preset, so
  // mark it as one (see normalizeFromField for the casing rationale).
  // materializeProfile also calls this unconditionally so System-tier
  // exports with `inherits: ""` — which never reach this code path — get
  // the same treatment.
  normalizeFromField(current);

  // OrcaSlicer's GUI prefixes user clones of system presets with "# "
  // (e.g. "# Bambu Lab X1 Carbon 0.4 nozzle"). The CLI's compatibility
  // check matches the printer's `name` literally against each profile's
  // `compatible_printers` list, which contains the un-prefixed system
  // names. Strip the prefix so a clone-and-export workflow lines up
  // with the bundled compat lists.
  if (typeof current.name === "string" && current.name.startsWith("# ")) {
    current.name = current.name.slice(2);
  }

  // A printer preset saved under a name of its own.
  //
  // The CLI does not look a process's or a filament's `compatible_printers`
  // up by the printer's NAME but by its "system name": the name itself when
  // the file says `from: "system"`, otherwise its `inherits`
  // (`new_printer_system_name` in BambuStudio.cpp / OrcaSlicer.cpp, read by
  // the CLI_PROCESS_NOT_COMPATIBLE check and, in BambuStudio, by the filament
  // check after it). Flattened and marked `system`, a preset called
  // "Bambu Lab H2D 0.4 nozzle - Apply Skew Calibration" answered with that
  // name, which no stock process lists, and every slice was refused as
  // "printer is not compatible with the process preset" (bambuddy#3250).
  //
  // So such a printer leaves here the way the GUI would export it: its
  // values flattened as always (the CLI still resolves nothing itself), plus
  // `inherits` naming the stock preset it was copied from — the NEAREST
  // instantiable ancestor, read off the chain, never guessed from the name —
  // and `from: "User"`, which is what makes the CLI read that `inherits`.
  //
  // A stock preset picked by name, and a "# " clone that kept the stock name,
  // are their own stock parent: nothing changes for them. Neither does it for
  // a printer built straight on an abstract base — it has no stock parent,
  // and its own name is the only system name it can have. Process and
  // filament presets are compared by their lists, not their names, and stay
  // flattened to `system`.
  //
  // "Renamed" is asked of the profile's OWN name, not of its parent: a copy of
  // a stock preset that kept the stock name (a Bambu Cloud / Orca Cloud /
  // imported "Bambu Lab H2D 0.6 nozzle") still carries its real `inherits`,
  // and in the shipped tree that is the 0.4 sibling — instantiable too. Taken
  // for a renamed printer it was handed over as a user preset of the 0.4
  // printer, and a process made for the 0.4 nozzle passed the check against a
  // 0.6 one. A profile named as a stock printer preset IS that preset: its
  // own name is its system name, whatever its `inherits` and `from` said.
  const ownName = current.name;
  const namedAsStock =
    typeof ownName === "string" &&
    indexes.some(
      (index) => index.byName.get(ownName)?.json.instantiation === "true",
    );
  if (
    category === "machine" &&
    stockParent !== undefined &&
    typeof ownName === "string" &&
    ownName !== stockParent &&
    !namedAsStock
  ) {
    current.inherits = stockParent;
    current.from = "User";
  }

  return current;
}

/**
 * Merge `name`'s companion files into `profile`, in place.
 *
 * `Bambu Lab X2D 0.4 nozzle template machine_start_gcode.json` belongs to
 * `Bambu Lab X2D 0.4 nozzle` (profile-index.ts keys companions by owner).
 *
 * A companion only fills a key the preset's own file leaves unset. No preset
 * in the bundle both defines one of these settings inline and ships a
 * companion for it, so the rule is unobservable there — it is chosen so that
 * an explicit value in the preset itself is never silently overwritten by a
 * file it does not reference.
 */
function applyCompanionTemplates(
  profile: ProfileJson,
  name: string,
  category: ProfileCategory,
  index: CategoryIndex,
): void {
  for (const companion of index.companions.get(name) ?? []) {
    if (!companion.json) {
      // Loud, like the parent path: swallowing this would put us back to
      // slicing with a silently generic start gcode, which is the failure
      // this whole mechanism exists to prevent.
      throw new AppError(
        500,
        `Bundled profile template is not valid JSON: "${companion.baseName}"`,
        `category=${category} path=${companion.file} ${companion.error ?? ""}`,
      );
    }

    for (const [key, value] of Object.entries(companion.json)) {
      if (TEMPLATE_IDENTITY_KEYS.has(key) || key in profile) {
        continue;
      }
      profile[key] = value;
    }
  }
}

/**
 * Strip "auto" sentinel values from a user-exported delta in place.
 *
 * OrcaSlicer's GUI lets users leave many numeric fields set to `-1`
 * (or array equivalents) meaning "use the slicer's default". The CLI's
 * range validation rejects these literally — e.g.
 * `prime_tower_brim_width: "-1" not in range [0, ∞]`. By dropping the
 * field from the user's delta, the merged profile picks up whatever
 * value its bundled ancestor sets, or the CLI's compiled-in default.
 *
 * Empty strings get the same treatment because the GUI emits them for
 * fields the user hasn't customized; the CLI rejects them where a
 * concrete value is expected.
 */
function stripUserSentinels(profile: ProfileJson): void {
  for (const k of Object.keys(profile)) {
    const v = profile[k];
    if (v === "-1" || v === "") {
      delete profile[k];
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x === "-1" || x === "")
    ) {
      delete profile[k];
    }
  }
}

// BambuStudio's "Export Preset Bundle" omits `type:` on System-tier presets
// (the GUI infers it from the directory the file lived in) and emits
// `inherits: ""` for them, so resolveProfile's inherits walk never runs and
// can't pick up `type` from a parent. The CLI's --load-settings/--load-filaments
// parser then sees a type-less file, logs `operator(): unknown config type
// ... in load-settings`, writes `error_string: "The input preset file is
// invalid and can not be parsed.", return_code: -5` to result.json, and
// exits 0. Stamp the category we already know.
export function ensureProfileType(
  profile: ProfileJson,
  category: ProfileCategory,
): ProfileJson {
  if (typeof profile.type !== "string" || profile.type.length === 0) {
    profile.type = category;
  }
  return profile;
}

// The CLI's compatibility check accepts `from: "system"` (lowercase) as the
// canonical system-tier marker and rejects everything else with
// `from <value> unsupported` (return_code -5, surfaced as the same
// "input preset file is invalid and can not be parsed." rejection).
//
// Two casings appear in real exports:
//   - "User"   — user-cloned presets out of the OrcaSlicer/BambuStudio GUI.
//                After resolveProfile flattens the inherits chain, the
//                output is functionally a system preset and should be
//                marked as such.
//   - "System" — BambuStudio's "Export Preset Bundle" for a System-tier
//                root preset (printer / built-in filament) writes this
//                literally. The GUI accepts it because the GUI's own
//                check is case-insensitive; the CLI's is not.
//
// "Default" and other values are NOT remapped — those are distinct tiers
// the CLI handles, and silently rewriting them would mask a real
// mis-tagged file.
//
// A profile that still has an `inherits` after resolution is left alone: only
// a renamed printer does (see the end of resolveProfile), and its `from:
// "User"` is the point — it is what makes the CLI take the `inherits` as the
// printer's system name. The CLI accepts "User" as it accepts "system".
export function normalizeFromField(profile: ProfileJson): ProfileJson {
  if (typeof profile.inherits === "string" && profile.inherits.length > 0) {
    return profile;
  }
  if (profile.from === "User" || profile.from === "System") {
    profile.from = "system";
  }
  return profile;
}

/**
 * Let a process or filament preset made for a renamed printer pass the CLI's
 * compatibility check, in place.
 *
 * The other half of the renamed-printer rule in resolveProfile: the CLI now
 * compares with the printer's stock parent, so a preset whose
 * `compatible_printers` names the renamed printer ITSELF would be refused
 * for the opposite reason. When the list names that printer, its stock
 * parent is added. A list that does not name it is not touched — a preset
 * made for another printer stays refused.
 *
 * The list is replaced, never grown: a resolved profile shares its arrays
 * with the cached bundled preset they came from.
 */
export function acceptPrinterParent(
  profile: ProfileJson,
  printerName: string,
  stockParent: string,
): ProfileJson {
  const list = profile.compatible_printers;
  if (
    Array.isArray(list) &&
    list.includes(printerName) &&
    !list.includes(stockParent)
  ) {
    profile.compatible_printers = [...list, stockParent];
  }
  return profile;
}

export function mergeProfiles(
  parent: ProfileJson,
  child: ProfileJson,
): ProfileJson {
  const merged: ProfileJson = { ...parent, ...child };
  if (typeof parent.inherits === "string" && parent.inherits.length > 0) {
    merged.inherits = parent.inherits;
  } else {
    delete merged.inherits;
  }
  return merged;
}

/** Folder name of OrcaSlicer's filament library among the vendor trees. */
export const FILAMENT_LIBRARY_DIR = "OrcaFilamentLibrary";

/**
 * Where OrcaSlicer's filament library is, if this slicer has one.
 *
 * `FILAMENT_LIBRARY_PATH` when set — set to nothing, it switches the library
 * off. Otherwise the folder beside the vendor's tree, where the slicer keeps
 * it (`resources/profiles/OrcaFilamentLibrary` next to `…/BBL`). The folder
 * is not checked here: one that does not exist is an empty tree to the
 * index, which is what a Bambu Studio image has.
 */
export function getFilamentLibraryPath(): string | undefined {
  const explicit = process.env.FILAMENT_LIBRARY_PATH;
  if (explicit !== undefined) {
    return explicit.length > 0 ? explicit : undefined;
  }
  const bundled = getDefaultBundledProfilesPath();
  return bundled
    ? path.join(path.dirname(bundled), FILAMENT_LIBRARY_DIR)
    : undefined;
}

export function getDefaultBundledProfilesPath(): string | undefined {
  const orcaPath = process.env.BUNDLED_PROFILES_PATH;
  if (orcaPath && orcaPath.length > 0) {
    return orcaPath;
  }
  if (process.env.ORCASLICER_PATH) {
    return path.join(
      path.dirname(process.env.ORCASLICER_PATH),
      "resources",
      "profiles",
      "BBL",
    );
  }
  return undefined;
}
