import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { clearProfileIndexCache } from "../../src/routes/slicing/profile-index";
import {
  acceptPrinterParent,
  normalizeFromField,
  resolveProfile,
  type ProfileJson,
} from "../../src/routes/slicing/profile-resolver";
import { materializeSliceProfiles } from "../../src/routes/slicing/slicing.service";

// A printer preset saved under a name of its own ("Bambu Lab H2D 0.4 nozzle -
// Apply Skew Calibration") could not be sliced with ANY process: the CLI
// answered "The selected printer is not compatible with the process preset".
//
// The CLI does not compare a process's `compatible_printers` with the
// printer's name but with its SYSTEM name — the name itself when the file
// says `from: "system"`, else its `inherits` (BambuStudio.cpp, where
// `new_printer_system_name` is set, and the CLI_PROCESS_NOT_COMPATIBLE check;
// OrcaSlicer.cpp has the same lines). We flatten a preset and mark the result
// `from: "system"`, so a renamed preset's system name became its own name,
// which no stock process lists. The flattened printer now keeps what the CLI
// asks for: `inherits` = its nearest stock ancestor, and `from: "User"`.

let root: string;
let inputDir: string;

async function put(rel: string, profile: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile), "utf8");
}

beforeEach(async () => {
  clearProfileIndexCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "printer-parent-"));
  inputDir = await fs.mkdtemp(path.join(os.tmpdir(), "printer-parent-in-"));

  await put("machine/fdm_machine_common.json", {
    type: "machine",
    name: "fdm_machine_common",
    instantiation: "false",
    gcode_flavor: "marlin",
  });
  await put("machine/Bambu Lab H2D 0.4 nozzle.json", {
    type: "machine",
    name: "Bambu Lab H2D 0.4 nozzle",
    inherits: "fdm_machine_common",
    from: "system",
    instantiation: "true",
    printer_model: "Bambu Lab H2D",
    printer_variant: "0.4",
    nozzle_diameter: ["0.4", "0.4"],
  });
  // The other nozzle sizes inherit their 0.4 sibling, as in the shipped tree.
  await put("machine/Bambu Lab H2D 0.6 nozzle.json", {
    type: "machine",
    name: "Bambu Lab H2D 0.6 nozzle",
    inherits: "Bambu Lab H2D 0.4 nozzle",
    from: "system",
    instantiation: "true",
    printer_variant: "0.6",
    nozzle_diameter: ["0.6", "0.6"],
  });
  await put("process/0.20mm Standard @BBL H2D.json", {
    type: "process",
    name: "0.20mm Standard @BBL H2D",
    from: "system",
    instantiation: "true",
    layer_height: "0.2",
    compatible_printers: ["Bambu Lab H2D 0.4 nozzle"],
  });
  await put("filament/Bambu PLA Basic @BBL H2D.json", {
    type: "filament",
    name: "Bambu PLA Basic @BBL H2D",
    from: "system",
    instantiation: "true",
    filament_type: ["PLA"],
    compatible_printers: ["Bambu Lab H2D 0.4 nozzle"],
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(inputDir, { recursive: true, force: true });
});

function resolveMachine(profile: ProfileJson): Promise<ProfileJson> {
  return resolveProfile(profile, "machine", { bundledProfilesPath: root });
}

const RENAMED = "Bambu Lab H2D 0.4 nozzle - Apply Skew Calibration";

describe("a printer preset saved under a name of its own", () => {
  it("keeps its stock parent as inherits and says it is a user preset", async () => {
    const result = await resolveMachine({
      type: "machine",
      name: RENAMED,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
      machine_start_gcode: "; skew",
    });
    expect(result.name).toBe(RENAMED);
    expect(result.inherits).toBe("Bambu Lab H2D 0.4 nozzle");
    expect(result.from).toBe("User");
  });

  it("still carries the parent's model, variant and nozzle, flattened", async () => {
    const result = await resolveMachine({
      name: RENAMED,
      inherits: "Bambu Lab H2D 0.4 nozzle",
    });
    expect(result.printer_model).toBe("Bambu Lab H2D");
    expect(result.printer_variant).toBe("0.4");
    expect(result.nozzle_diameter).toEqual(["0.4", "0.4"]);
    expect(result.gcode_flavor).toBe("marlin");
  });

  it("is marked a user preset even when the caller sent from: system", async () => {
    // What BamDude sends for a Bambu Cloud / Orca Cloud preset.
    const result = await resolveMachine({
      name: "Workshop H2D",
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "system",
    });
    expect(result.from).toBe("User");
    expect(result.inherits).toBe("Bambu Lab H2D 0.4 nozzle");
  });

  it("takes the nearest stock ancestor, not the one further up", async () => {
    const result = await resolveMachine({
      name: "My 0.6",
      inherits: "Bambu Lab H2D 0.6 nozzle",
    });
    expect(result.inherits).toBe("Bambu Lab H2D 0.6 nozzle");
    expect(result.printer_variant).toBe("0.6");
    expect(result.printer_model).toBe("Bambu Lab H2D");
  });

  it("survives the second normalisation every materialised profile gets", async () => {
    const result = await resolveMachine({
      name: RENAMED,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
    });
    expect(normalizeFromField(result).from).toBe("User");
  });
});

describe("presets that are not renamed printers stay as they were", () => {
  it("a stock preset picked by name is a system preset with no inherits", async () => {
    const result = await resolveMachine({
      name: "Bambu Lab H2D 0.4 nozzle",
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "system",
    });
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
  });

  it("a '# ' clone that kept the stock name is that stock preset", async () => {
    const result = await resolveMachine({
      name: "# Bambu Lab H2D 0.4 nozzle",
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
    });
    expect(result.name).toBe("Bambu Lab H2D 0.4 nozzle");
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
  });

  it("a printer built straight on an abstract base has no stock parent to keep", async () => {
    const result = await resolveMachine({
      name: "Anycubic Mega S",
      inherits: "fdm_machine_common",
      from: "User",
    });
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
  });

  it("a renamed process or filament is flattened to a system preset as before", async () => {
    const process = await resolveProfile(
      { name: "My 0.20", inherits: "0.20mm Standard @BBL H2D", from: "User" },
      "process",
      { bundledProfilesPath: root },
    );
    expect(process.inherits).toBeUndefined();
    expect(process.from).toBe("system");

    const filament = await resolveProfile(
      { name: "My PLA", inherits: "Bambu PLA Basic @BBL H2D", from: "User" },
      "filament",
      { bundledProfilesPath: root },
    );
    expect(filament.inherits).toBeUndefined();
    expect(filament.from).toBe("system");
  });

  it("normalizeFromField still rewrites a profile that kept no inherits", () => {
    expect(normalizeFromField({ from: "User" }).from).toBe("system");
    expect(normalizeFromField({ from: "User", inherits: "" }).from).toBe("system");
  });
});

// A Bambu Cloud / Orca Cloud / imported COPY of a stock preset keeps the stock
// NAME and its real `inherits`. In the shipped tree every 0.2 / 0.6 / 0.8
// printer inherits its 0.4 sibling and both are instantiable, so "the nearest
// instantiable ancestor differs from my name" also holds for such a copy —
// and it was handed to the CLI as a user preset of the 0.4 printer: a process
// made for the 0.4 nozzle then passed the compatibility check against a 0.6
// printer. A profile whose own name IS a stock printer's is that stock
// printer, whatever its `inherits` and `from` say.
describe("a copy of a stock printer under its stock name is that stock printer", () => {
  const STOCK_06 = "Bambu Lab H2D 0.6 nozzle";

  it("a user copy of the 0.6 preset is not re-parented to the 0.4 preset", async () => {
    const result = await resolveMachine({
      type: "machine",
      name: STOCK_06,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
      printer_variant: "0.6",
      nozzle_diameter: ["0.6", "0.6"],
    });
    expect(result.name).toBe(STOCK_06);
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
    // Still flattened: the copy's own values over the chain's.
    expect(result.printer_variant).toBe("0.6");
    expect(result.printer_model).toBe("Bambu Lab H2D");
    expect(result.gcode_flavor).toBe("marlin");
  });

  it("neither is a copy that says from: system", async () => {
    const result = await resolveMachine({
      name: STOCK_06,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "system",
    });
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
  });

  it("nor a '# ' clone of it that kept the stock name", async () => {
    const result = await resolveMachine({
      name: `# ${STOCK_06}`,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
    });
    expect(result.name).toBe(STOCK_06);
    expect(result.inherits).toBeUndefined();
    expect(result.from).toBe("system");
  });

  it("answers exactly as the stock preset picked by name does", async () => {
    const stub = await resolveMachine({ name: STOCK_06, inherits: STOCK_06, from: "system" });
    const copy = await resolveMachine({
      name: STOCK_06,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
      printer_variant: "0.6",
      nozzle_diameter: ["0.6", "0.6"],
    });
    expect({ name: copy.name, inherits: copy.inherits, from: copy.from }).toEqual({
      name: stub.name,
      inherits: stub.inherits,
      from: stub.from,
    });
  });

  it("a name that only an abstract base carries is not a stock printer's", async () => {
    // `fdm_machine_common` is in the index but nobody can pick it.
    const result = await resolveMachine({
      name: "fdm_machine_common",
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
    });
    expect(result.inherits).toBe("Bambu Lab H2D 0.4 nozzle");
    expect(result.from).toBe("User");
  });

  it("a genuinely renamed copy of the 0.6 preset still keeps its stock parent", async () => {
    const result = await resolveMachine({
      name: "Workshop H2D 0.6",
      inherits: STOCK_06,
      from: "User",
    });
    expect(result.inherits).toBe(STOCK_06);
    expect(result.from).toBe("User");
  });

  it("a 0.4 process is not widened for a stock-named 0.6 copy", async () => {
    const out = await materializeSliceProfiles({
      inputDir,
      settings: {},
      basePath: root,
      bundledProfilesPath: root,
      tempProfiles: {
        printer: Buffer.from(
          JSON.stringify({ name: STOCK_06, inherits: "Bambu Lab H2D 0.4 nozzle", from: "User" }),
        ),
        preset: Buffer.from(
          JSON.stringify({
            name: "Made for the 0.6",
            inherits: "0.20mm Standard @BBL H2D",
            compatible_printers: [STOCK_06],
          }),
        ),
        filaments: [],
      },
    });
    const printer = JSON.parse(await fs.readFile(out.printerPath as string, "utf8")) as ProfileJson;
    const preset = JSON.parse(await fs.readFile(out.presetPath as string, "utf8")) as ProfileJson;
    expect(printer.name).toBe(STOCK_06);
    expect(printer.inherits).toBeUndefined();
    expect(printer.from).toBe("system");
    // The CLI compares with the printer's own name; the 0.4 name is not added.
    expect(preset.compatible_printers).toEqual([STOCK_06]);
  });
});

describe("acceptPrinterParent", () => {
  it("adds the stock parent to a list that names the renamed printer", () => {
    const process: ProfileJson = { compatible_printers: [RENAMED] };
    acceptPrinterParent(process, RENAMED, "Bambu Lab H2D 0.4 nozzle");
    expect(process.compatible_printers).toEqual([
      RENAMED,
      "Bambu Lab H2D 0.4 nozzle",
    ]);
  });

  it("leaves a list that does not name the renamed printer alone", () => {
    // Not ours to widen: a process made for another printer stays refused.
    const process: ProfileJson = {
      compatible_printers: ["Bambu Lab A1 0.4 nozzle"],
    };
    acceptPrinterParent(process, RENAMED, "Bambu Lab H2D 0.4 nozzle");
    expect(process.compatible_printers).toEqual(["Bambu Lab A1 0.4 nozzle"]);
  });

  it("does not add the parent twice", () => {
    const process: ProfileJson = {
      compatible_printers: [RENAMED, "Bambu Lab H2D 0.4 nozzle"],
    };
    acceptPrinterParent(process, RENAMED, "Bambu Lab H2D 0.4 nozzle");
    expect(process.compatible_printers).toHaveLength(2);
  });

  it("builds a new list instead of growing the one it was given", () => {
    // A resolved profile shares its arrays with the cached bundled preset
    // they came from; pushing into one would widen the stock preset for
    // every later request.
    const shared = [RENAMED];
    const process: ProfileJson = { compatible_printers: shared };
    acceptPrinterParent(process, RENAMED, "Bambu Lab H2D 0.4 nozzle");
    expect(shared).toEqual([RENAMED]);
  });
});

describe("what a slice with a renamed printer hands the CLI", () => {
  async function written(file: string): Promise<ProfileJson> {
    return JSON.parse(await fs.readFile(file, "utf8")) as ProfileJson;
  }

  it("printer with its stock parent, stock process and filament untouched", async () => {
    const out = await materializeSliceProfiles({
      inputDir,
      settings: {},
      basePath: root,
      bundledProfilesPath: root,
      tempProfiles: {
        printer: Buffer.from(
          JSON.stringify({ name: RENAMED, inherits: "Bambu Lab H2D 0.4 nozzle", from: "User" }),
        ),
        preset: Buffer.from(
          JSON.stringify({
            name: "0.20mm Standard @BBL H2D",
            inherits: "0.20mm Standard @BBL H2D",
          }),
        ),
        filaments: [
          Buffer.from(
            JSON.stringify({
              name: "Bambu PLA Basic @BBL H2D",
              inherits: "Bambu PLA Basic @BBL H2D",
            }),
          ),
        ],
      },
    });

    const printer = await written(out.printerPath as string);
    expect(printer).toMatchObject({
      name: RENAMED,
      inherits: "Bambu Lab H2D 0.4 nozzle",
      from: "User",
      type: "machine",
    });
    // The stock process already lists the name the CLI will compare with.
    expect((await written(out.presetPath as string)).compatible_printers).toEqual([
      "Bambu Lab H2D 0.4 nozzle",
    ]);
    expect((await written(out.filamentPaths[0])).compatible_printers).toEqual([
      "Bambu Lab H2D 0.4 nozzle",
    ]);
  });

  it("a process and a filament made for the renamed printer accept its parent", async () => {
    const out = await materializeSliceProfiles({
      inputDir,
      settings: {},
      basePath: root,
      bundledProfilesPath: root,
      tempProfiles: {
        printer: Buffer.from(
          JSON.stringify({ name: RENAMED, inherits: "Bambu Lab H2D 0.4 nozzle" }),
        ),
        preset: Buffer.from(
          JSON.stringify({
            name: "Skew process",
            inherits: "0.20mm Standard @BBL H2D",
            compatible_printers: [RENAMED],
          }),
        ),
        filaments: [
          Buffer.from(
            JSON.stringify({
              name: "Skew PLA",
              inherits: "Bambu PLA Basic @BBL H2D",
              compatible_printers: [RENAMED],
            }),
          ),
        ],
      },
    });

    expect((await written(out.presetPath as string)).compatible_printers).toEqual([
      RENAMED,
      "Bambu Lab H2D 0.4 nozzle",
    ]);
    expect((await written(out.filamentPaths[0])).compatible_printers).toEqual([
      RENAMED,
      "Bambu Lab H2D 0.4 nozzle",
    ]);
  });
});
