import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearProfileIndexCache,
  loadCategoryIndex,
  lookupProfile,
} from "../../src/routes/slicing/profile-index";
import {
  resolveProfile,
  type ProfileJson,
} from "../../src/routes/slicing/profile-resolver";
import { readBundledDir } from "../../src/routes/profiles/route";

// A hand-made vendor tree in the shape the slicers ship: most presets flat in
// the category folder, some brands in a subfolder of their own, and a preset
// whose NAME holds a "/" stored under a file name that cannot.
let root: string;

async function put(rel: string, profile: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    typeof profile === "string" ? profile : JSON.stringify(profile),
    "utf8",
  );
}

beforeEach(async () => {
  clearProfileIndexCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-index-"));

  await put("filament/fdm_filament_common.json", {
    type: "filament",
    name: "fdm_filament_common",
    instantiation: "false",
    filament_flow_ratio: ["1"],
  });
  await put("filament/fdm_filament_pla.json", {
    type: "filament",
    name: "fdm_filament_pla",
    inherits: "fdm_filament_common",
    instantiation: "false",
    filament_type: ["PLA"],
    nozzle_temperature: ["220"],
  });
  await put("filament/Bambu PLA Basic @BBL X1C.json", {
    type: "filament",
    name: "Bambu PLA Basic @BBL X1C",
    inherits: "fdm_filament_pla",
    instantiation: "true",
    compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"],
  });
  // A brand in a folder of its own, its base beside it.
  await put("filament/SUNLU/SUNLU PLA Matte @base.json", {
    type: "filament",
    name: "SUNLU PLA Matte @base",
    inherits: "fdm_filament_pla",
    instantiation: "false",
    filament_vendor: ["SUNLU"],
    nozzle_temperature: ["215"],
  });
  await put("filament/SUNLU/SUNLU PLA Matte @BBL X1C.json", {
    type: "filament",
    name: "SUNLU PLA Matte @BBL X1C",
    inherits: "SUNLU PLA Matte @base",
    instantiation: "true",
    compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"],
  });
  // "/" cannot be in a file name, so the slicers store this one under "-".
  await put("filament/Bambu Support For PLA-PETG @base.json", {
    type: "filament",
    name: "Bambu Support For PLA/PETG @base",
    inherits: "fdm_filament_pla",
    instantiation: "false",
    filament_is_support: ["1"],
    nozzle_temperature: ["210"],
  });
  await put("filament/Bambu Support For PLA-PETG @BBL X1C.json", {
    type: "filament",
    name: "Bambu Support For PLA/PETG @BBL X1C",
    inherits: "Bambu Support For PLA/PETG @base",
    instantiation: "true",
    compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function resolveFilament(profile: ProfileJson): Promise<ProfileJson> {
  return resolveProfile(profile, "filament", { bundledProfilesPath: root });
}

describe("the preset listing walks the vendor tree", () => {
  it("lists a preset that lives in a subfolder", async () => {
    const out = await readBundledDir(path.join(root, "filament"), "filament");
    expect(out.map((p) => p.name)).toContain("SUNLU PLA Matte @BBL X1C");
  });

  it("reads an inherited field through a base in the same subfolder", async () => {
    const out = await readBundledDir(path.join(root, "filament"), "filament");
    const sunlu = out.find((p) => p.name === "SUNLU PLA Matte @BBL X1C");
    expect(sunlu).toMatchObject({ filament_type: "PLA" });
  });

  it("lists a preset whose name holds a slash under its name, not its file name", async () => {
    const out = await readBundledDir(path.join(root, "filament"), "filament");
    const names = out.map((p) => p.name);
    expect(names).toContain("Bambu Support For PLA/PETG @BBL X1C");
    expect(names).not.toContain("Bambu Support For PLA-PETG @BBL X1C");
  });
});

describe("a parent is found by its name, wherever its file is", () => {
  it("resolves a parent that lives in a subfolder", async () => {
    const result = await resolveFilament({
      type: "filament",
      name: "My SUNLU",
      inherits: "SUNLU PLA Matte @BBL X1C",
      from: "User",
    });
    // 215 from the base beside it in SUNLU/, PLA and the flow ratio from the
    // two bases at the top of the category: the chain crosses folders twice.
    expect(result.nozzle_temperature).toEqual(["215"]);
    expect(result.filament_vendor).toEqual(["SUNLU"]);
    expect(result.filament_type).toEqual(["PLA"]);
    expect(result.filament_flow_ratio).toEqual(["1"]);
    expect(result.inherits).toBeUndefined();
  });

  it("resolves the stub of a stock preset whose name holds a slash", async () => {
    // What the Slice dialog sends for a "Standard" pick: only the name.
    const result = await resolveFilament({
      name: "Bambu Support For PLA/PETG @BBL X1C",
      inherits: "Bambu Support For PLA/PETG @BBL X1C",
    });
    expect(result.nozzle_temperature).toEqual(["210"]);
    expect(result.filament_is_support).toEqual(["1"]);
    expect(result.filament_type).toEqual(["PLA"]);
    expect(result.compatible_printers).toEqual([
      "Bambu Lab X1 Carbon 0.4 nozzle",
    ]);
  });

  it("does not take a file name for a preset name", async () => {
    const index = await loadCategoryIndex(path.join(root, "filament"));
    expect(
      lookupProfile(index, "Bambu Support For PLA-PETG @BBL X1C"),
    ).toBeUndefined();
    expect(
      lookupProfile(index, "Bambu Support For PLA/PETG @BBL X1C")?.rel,
    ).toBe("Bambu Support For PLA-PETG @BBL X1C.json");
  });

  it("knows a file without a name field by its file name", async () => {
    await put("filament/nameless_base.json", { filament_density: ["1.3"] });
    const result = await resolveFilament({
      name: "child",
      inherits: "nameless_base",
    });
    expect(result.filament_density).toEqual(["1.3"]);
  });

  it("stops a cycle that runs through two folders at the depth cap", async () => {
    await put("filament/A/loop_a.json", { name: "loop a", inherits: "loop b" });
    await put("filament/B/loop_b.json", { name: "loop b", inherits: "loop a" });
    await expect(
      resolveProfile({ name: "x", inherits: "loop a" }, "filament", {
        bundledProfilesPath: root,
        maxDepth: 6,
      }),
    ).rejects.toThrow(/exceeded maximum depth/i);
  });
});

describe("two files with one preset name", () => {
  beforeEach(async () => {
    await put("filament/Twin PLA.json", {
      name: "Twin PLA",
      inherits: "fdm_filament_pla",
      instantiation: "true",
      nozzle_temperature: ["200"],
    });
    await put("filament/Other/Twin PLA copy.json", {
      name: "Twin PLA",
      inherits: "fdm_filament_pla",
      instantiation: "true",
      nozzle_temperature: ["240"],
    });
  });

  it("refuses to resolve the name and names both files", async () => {
    const attempt = resolveFilament({ name: "mine", inherits: "Twin PLA" });
    await expect(attempt).rejects.toThrow(/Twin PLA/);
    await expect(attempt).rejects.toMatchObject({
      status: 500,
      causeMessage: expect.stringMatching(
        /Other\/Twin PLA copy\.json.*Twin PLA\.json|Twin PLA\.json.*Other\/Twin PLA copy\.json/,
      ),
    });
  });

  it("leaves the ambiguous name out of the listing and keeps the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await readBundledDir(path.join(root, "filament"), "filament");
    const names = out.map((p) => p.name);
    expect(names).not.toContain("Twin PLA");
    expect(names).toContain("Bambu PLA Basic @BBL X1C");
  });
});

describe("the index is built once per profile root", () => {
  it("does not read the files again for a second resolution", async () => {
    await resolveFilament({ name: "a", inherits: "Bambu PLA Basic @BBL X1C" });
    const read = vi.spyOn(fs, "readFile");
    await resolveFilament({ name: "b", inherits: "SUNLU PLA Matte @BBL X1C" });
    expect(read).not.toHaveBeenCalled();
  });

  it("is rebuilt when a file appears in the tree", async () => {
    await resolveFilament({ name: "a", inherits: "Bambu PLA Basic @BBL X1C" });
    await put("filament/New/Late PLA.json", {
      name: "Late PLA",
      inherits: "fdm_filament_pla",
      nozzle_temperature: ["230"],
    });
    const result = await resolveFilament({ name: "b", inherits: "Late PLA" });
    expect(result.nozzle_temperature).toEqual(["230"]);
  });
});
