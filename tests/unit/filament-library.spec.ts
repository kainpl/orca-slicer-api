import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import supertest from "supertest";
import { configureApp } from "../../src/index";
import { clearProfileIndexCache } from "../../src/routes/slicing/profile-index";
import {
  getFilamentLibraryPath,
  resolveProfile,
  type ProfileJson,
} from "../../src/routes/slicing/profile-resolver";
import {
  buildBundledListing,
  type BundledFilament,
} from "../../src/routes/profiles/route";

// OrcaSlicer ships a second profile tree beside the vendors': the filament
// library ("… @System" presets of Elegoo, Polymaker, eSUN …), meant for
// printers whose vendor has no preset of that filament. This is a hand-made
// pair of trees in the shapes the real ones have:
//
//   profiles/BBL/                    the vendor: two printers, a few filaments
//   profiles/OrcaFilamentLibrary/    the library: every preset in a subfolder,
//                                    its bases under base/ — and those bases
//                                    carry the SAME NAMES as the vendor's
//                                    with different content.

const ORIGINAL_ENV = { ...process.env };
let profiles: string;
let vendor: string;
let library: string;

const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

async function put(root: string, rel: string, profile: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile), "utf8");
}

function vendorFilament(
  name: string,
  brand: string,
  printers: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    inherits: "fdm_filament_pla",
    instantiation: "true",
    filament_vendor: [brand],
    compatible_printers: printers,
    ...extra,
  };
}

function libraryFilament(
  name: string,
  brand: string,
  printers: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    inherits: "fdm_filament_pla",
    from: "system",
    instantiation: "true",
    filament_vendor: [brand],
    compatible_printers: printers,
    ...extra,
  };
}

beforeEach(async () => {
  clearProfileIndexCache();
  profiles = await fs.mkdtemp(path.join(os.tmpdir(), "filament-library-"));
  vendor = path.join(profiles, "BBL");
  library = path.join(profiles, "OrcaFilamentLibrary");

  for (const printer of [X1C, A1]) {
    await put(vendor, `machine/${printer}.json`, {
      name: printer,
      instantiation: "true",
    });
  }
  await put(vendor, "machine/fdm_machine_common.json", {
    name: "fdm_machine_common",
    instantiation: "false",
  });
  await put(vendor, "process/0.20mm Standard @BBL X1C.json", {
    name: "0.20mm Standard @BBL X1C",
    instantiation: "true",
    compatible_printers: [X1C],
  });

  await put(vendor, "filament/fdm_filament_common.json", {
    name: "fdm_filament_common",
    instantiation: "false",
    filament_flow_ratio: ["1"],
  });
  await put(vendor, "filament/fdm_filament_pla.json", {
    name: "fdm_filament_pla",
    inherits: "fdm_filament_common",
    instantiation: "false",
    filament_type: ["PLA"],
    nozzle_temperature: ["220"],
  });
  await put(
    vendor,
    "filament/Bambu PLA Basic @BBL X1C.json",
    vendorFilament("Bambu PLA Basic @BBL X1C", "Bambu Lab", [X1C]),
  );
  await put(
    vendor,
    "filament/Generic PLA @BBL X1C.json",
    vendorFilament("Generic PLA @BBL X1C", "Generic", [X1C]),
  );
  await put(
    vendor,
    "filament/Bambu Support For PLA @BBL X1C.json",
    vendorFilament("Bambu Support For PLA @BBL X1C", "Bambu Lab", [X1C], {
      filament_is_support: ["1"],
    }),
  );
  await put(
    vendor,
    "filament/SUNLU/SUNLU PLA @BBL X1C.json",
    vendorFilament("SUNLU PLA @BBL X1C", "SUNLU", [X1C]),
  );
  await put(
    vendor,
    "filament/Covered PLA @BBL X1C.json",
    vendorFilament("Covered PLA @BBL X1C", "Generic", [X1C]),
  );
  await put(
    vendor,
    "filament/Covered PLA @BBL A1.json",
    vendorFilament("Covered PLA @BBL A1", "Generic", [A1]),
  );

  // The library. Same base names as the vendor, other values.
  await put(library, "filament/base/fdm_filament_common.json", {
    name: "fdm_filament_common",
    instantiation: "false",
    filament_flow_ratio: ["0.98"],
  });
  await put(library, "filament/base/fdm_filament_pla.json", {
    name: "fdm_filament_pla",
    inherits: "fdm_filament_common",
    instantiation: "false",
    filament_type: ["PLA"],
    nozzle_temperature: ["210"],
  });
  await put(
    library,
    "filament/Generic PLA @System.json",
    libraryFilament("Generic PLA @System", "Generic", []),
  );
  await put(
    library,
    "filament/Elegoo/Elegoo PLA @System.json",
    libraryFilament("Elegoo PLA @System", "Elegoo", []),
  );
  await put(
    library,
    "filament/Polymaker/Polymaker PolyLite PLA @System.json",
    libraryFilament("Polymaker PolyLite PLA @System", "Polymaker", []),
  );
  await put(
    library,
    "filament/Polymaker/BBL/Polymaker PolyLite PLA @BBL A1.json",
    libraryFilament("Polymaker PolyLite PLA @BBL A1", "Polymaker", [A1]),
  );
  await put(
    library,
    "filament/Covered PLA @System.json",
    libraryFilament("Covered PLA @System", "Generic", []),
  );
  await put(
    library,
    "filament/Elegoo/Elegoo Support @System.json",
    libraryFilament("Elegoo Support @System", "Elegoo", [], {
      filament_is_support: ["1"],
    }),
  );
  await put(
    library,
    "filament/Prusa/Prusament PLA @MK4.json",
    libraryFilament("Prusament PLA @MK4", "Prusa", ["Prusa MK4 0.4 nozzle"]),
  );
  // A name the vendor has as well: the vendor's file is the preset.
  await put(
    library,
    "filament/Bambu/Bambu PLA Basic @BBL X1C.json",
    libraryFilament("Bambu PLA Basic @BBL X1C", "Bambu Lab", [X1C, A1], {
      nozzle_temperature: ["199"],
    }),
  );
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(profiles, { recursive: true, force: true });
});

async function filaments(): Promise<BundledFilament[]> {
  return (await buildBundledListing(vendor, library)).filament;
}

async function byName(name: string): Promise<BundledFilament | undefined> {
  return (await filaments()).find((f) => f.name === name);
}

describe("which printers a library filament is offered for", () => {
  it("every printer of the vendor, when the vendor has no preset of that filament", async () => {
    const elegoo = await byName("Elegoo PLA @System");
    expect(elegoo?.compatible_printers).toEqual([A1, X1C]);
    expect(elegoo?.library).toBe(true);
  });

  it("not a printer the vendor ships its own preset of that filament for", async () => {
    // "Generic PLA @BBL X1C" exists, so the X1C keeps the vendor's preset and
    // only the A1 — which has none — is offered the library's.
    expect((await byName("Generic PLA @System"))?.compatible_printers).toEqual([A1]);
  });

  it("not a printer a printer-specific preset of the library itself covers", async () => {
    expect(
      (await byName("Polymaker PolyLite PLA @System"))?.compatible_printers,
    ).toEqual([X1C]);
  });

  it("lists that printer-specific library preset under its own list", async () => {
    const specific = await byName("Polymaker PolyLite PLA @BBL A1");
    expect(specific?.compatible_printers).toEqual([A1]);
    expect(specific?.library).toBe(true);
  });

  it("is not listed at all when every printer has a preset of its own", async () => {
    expect(await byName("Covered PLA @System")).toBeUndefined();
  });

  it("is not listed when it is made for another vendor's printers", async () => {
    expect(await byName("Prusament PLA @MK4")).toBeUndefined();
  });

  it("gives the result in the same order whatever order the files were written in", async () => {
    const first = (await filaments()).map((f) => f.name);
    clearProfileIndexCache();
    const second = (await filaments()).map((f) => f.name);
    expect(second).toEqual(first);
  });
});

describe("a name both trees have", () => {
  it("is listed once, as the vendor's preset", async () => {
    const all = (await filaments()).filter(
      (f) => f.name === "Bambu PLA Basic @BBL X1C",
    );
    expect(all).toHaveLength(1);
    expect(all[0].library).toBe(false);
    expect(all[0].compatible_printers).toEqual([X1C]);
  });
});

describe("the listing's fields and order", () => {
  it("reads a library preset's material through the library's own bases", async () => {
    expect(await byName("Elegoo PLA @System")).toMatchObject({
      filament_type: "PLA",
      filament_vendor: "Elegoo",
      filament_is_support: false,
    });
  });

  it("orders real filaments before supports; Bambu, Generic, other brands, then the library", async () => {
    expect((await filaments()).map((f) => f.name)).toEqual([
      // the vendor's tree: Bambu Lab, then Generic, then other brands
      "Bambu PLA Basic @BBL X1C",
      "Covered PLA @BBL A1",
      "Covered PLA @BBL X1C",
      "Generic PLA @BBL X1C",
      "SUNLU PLA @BBL X1C",
      // the library
      "Elegoo PLA @System",
      "Generic PLA @System",
      "Polymaker PolyLite PLA @BBL A1",
      "Polymaker PolyLite PLA @System",
      // support materials last, in the same order
      "Bambu Support For PLA @BBL X1C",
      "Elegoo Support @System",
    ]);
  });

  it("leaves printers and processes as they were", async () => {
    const listing = await buildBundledListing(vendor, library);
    expect(listing.printer.map((p) => p.name)).toEqual([A1, X1C]);
    expect(listing.process.map((p) => p.name)).toEqual([
      "0.20mm Standard @BBL X1C",
    ]);
  });

  it("lists only the vendor's filaments when there is no library (Bambu Studio)", async () => {
    const listing = await buildBundledListing(
      vendor,
      path.join(profiles, "no-such-library"),
    );
    expect(listing.filament.some((f) => f.library)).toBe(false);
    expect(listing.filament.map((f) => f.name)).toContain("SUNLU PLA @BBL X1C");

    const none = await buildBundledListing(vendor, undefined);
    expect(none.filament.map((f) => f.name)).toEqual(
      listing.filament.map((f) => f.name),
    );
  });
});

describe("resolving against the two trees", () => {
  function resolveFilament(profile: ProfileJson): Promise<ProfileJson> {
    return resolveProfile(profile, "filament", {
      bundledProfilesPath: vendor,
      libraryProfilesPath: library,
    });
  }

  it("resolves a library preset with the library's bases, not the vendor's namesakes", async () => {
    const result = await resolveFilament({
      name: "Elegoo PLA @System",
      inherits: "Elegoo PLA @System",
    });
    expect(result.nozzle_temperature).toEqual(["210"]);
    expect(result.filament_flow_ratio).toEqual(["0.98"]);
    expect(result.filament_vendor).toEqual(["Elegoo"]);
  });

  it("resolves a vendor preset with the vendor's bases although the library has the same names", async () => {
    const result = await resolveFilament({
      name: "SUNLU PLA @BBL X1C",
      inherits: "SUNLU PLA @BBL X1C",
    });
    expect(result.nozzle_temperature).toEqual(["220"]);
    expect(result.filament_flow_ratio).toEqual(["1"]);
  });

  it("takes the vendor's file for a name both trees have", async () => {
    const result = await resolveFilament({
      name: "Bambu PLA Basic @BBL X1C",
      inherits: "Bambu PLA Basic @BBL X1C",
    });
    expect(result.nozzle_temperature).toEqual(["220"]);
  });

  it("resolves a user preset made from a library preset", async () => {
    const result = await resolveFilament({
      name: "My Elegoo",
      inherits: "Elegoo PLA @System",
      nozzle_temperature: ["205"],
    });
    expect(result.nozzle_temperature).toEqual(["205"]);
    expect(result.filament_flow_ratio).toEqual(["0.98"]);
  });

  it("once a chain has reached the library it stays there", async () => {
    // A vendor preset whose parent only the library has: everything above
    // that parent is the library's, namesakes included.
    await put(library, "filament/base/Library Only Base.json", {
      name: "Library Only Base",
      inherits: "fdm_filament_pla",
      instantiation: "false",
    });
    await put(
      vendor,
      "filament/Odd PLA @BBL X1C.json",
      { ...vendorFilament("Odd PLA @BBL X1C", "Odd", [X1C]), inherits: "Library Only Base" },
    );
    const result = await resolveFilament({
      name: "Odd PLA @BBL X1C",
      inherits: "Odd PLA @BBL X1C",
    });
    expect(result.nozzle_temperature).toEqual(["210"]);
    expect(result.filament_flow_ratio).toEqual(["0.98"]);
  });

  it("refuses a library preset when no library is configured", async () => {
    await expect(
      resolveProfile(
        { name: "Elegoo PLA @System", inherits: "Elegoo PLA @System" },
        "filament",
        { bundledProfilesPath: vendor },
      ),
    ).rejects.toMatchObject({ status: 422, code: "preset_unresolved" });
  });

  it("does not look for printers or processes in the library", async () => {
    await put(library, "process/Stray process.json", {
      name: "Stray process",
      layer_height: "0.3",
    });
    await expect(
      resolveProfile({ name: "p", inherits: "Stray process" }, "process", {
        bundledProfilesPath: vendor,
        libraryProfilesPath: library,
      }),
    ).rejects.toMatchObject({ status: 422, code: "preset_unresolved" });
  });
});

describe("where the library is looked for", () => {
  it("beside the vendor's tree, under OrcaFilamentLibrary", () => {
    delete process.env.FILAMENT_LIBRARY_PATH;
    process.env.BUNDLED_PROFILES_PATH = vendor;
    expect(getFilamentLibraryPath()).toBe(library);
  });

  it("where FILAMENT_LIBRARY_PATH says, when it is set", () => {
    process.env.BUNDLED_PROFILES_PATH = vendor;
    process.env.FILAMENT_LIBRARY_PATH = "/somewhere/else";
    expect(getFilamentLibraryPath()).toBe("/somewhere/else");
  });

  it("nowhere, when FILAMENT_LIBRARY_PATH is set to nothing", () => {
    process.env.BUNDLED_PROFILES_PATH = vendor;
    process.env.FILAMENT_LIBRARY_PATH = "";
    expect(getFilamentLibraryPath()).toBeUndefined();
  });

  it("GET /profiles/bundled and POST /profiles/resolve both read it", async () => {
    delete process.env.FILAMENT_LIBRARY_PATH;
    process.env.BUNDLED_PROFILES_PATH = vendor;
    const app = supertest(configureApp());

    const listing = await app.get("/profiles/bundled").expect(200);
    const names = listing.body.filament.map((f: BundledFilament) => f.name);
    expect(names).toContain("Elegoo PLA @System");

    const resolved = await app
      .post("/profiles/resolve")
      .send({
        category: "filament",
        profile: { name: "Elegoo PLA @System", inherits: "Elegoo PLA @System" },
      })
      .expect(200);
    expect(resolved.body.profile.nozzle_temperature).toEqual(["210"]);
  });
});
