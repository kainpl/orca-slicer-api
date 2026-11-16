import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import supertest from "supertest";
import { configureApp } from "../../src/index";
import { clearProfileIndexCache } from "../../src/routes/slicing/profile-index";
import {
  resolveProfile,
  type ProfileJson,
} from "../../src/routes/slicing/profile-resolver";
import { sliceModel } from "../../src/routes/slicing/slicing.service";

// A preset that cannot be resolved must not be sliced. The resolver used to
// drop the `inherits` it could not follow and hand the CLI what was left; the
// CLI then filled every missing setting with its compiled-in default and
// reported success, so a PETG pick printed as PLA at 200 C with a warning in
// a log nobody reads. Now the request is refused, and the refusal says which
// preset and which parent, in fields a caller can read without parsing text.

const ORIGINAL_ENV = { ...process.env };
let root: string;

async function put(rel: string, profile: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile), "utf8");
}

beforeEach(async () => {
  clearProfileIndexCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "preset-unresolved-"));
  await put("filament/fdm_filament_petg.json", {
    name: "fdm_filament_petg",
    filament_type: ["PETG"],
    nozzle_temperature: ["255"],
  });
  // Its own parent is not in the tree: a link that breaks one hop up.
  await put("filament/Orphan PETG @base.json", {
    name: "Orphan PETG @base",
    inherits: "fdm_filament_gone",
  });
  await put("filament/Orphan PETG @BBL X1C.json", {
    name: "Orphan PETG @BBL X1C",
    inherits: "Orphan PETG @base",
    instantiation: "true",
  });
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(root, { recursive: true, force: true });
});

function resolveFilament(profile: ProfileJson): Promise<ProfileJson> {
  return resolveProfile(profile, "filament", { bundledProfilesPath: root });
}

describe("resolveProfile refuses a preset it cannot resolve", () => {
  it("refuses when the preset's own parent is not in the tree", async () => {
    await expect(
      resolveFilament({
        name: "My PETG",
        inherits: "Bambu PETG Basic @BBL H9",
        nozzle_temperature: ["250"],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "preset_unresolved",
      fields: {
        category: "filament",
        preset: "My PETG",
        missing_parent: "Bambu PETG Basic @BBL H9",
      },
    });
  });

  it("refuses when a link further up the chain is missing, and names that link", async () => {
    await expect(
      resolveFilament({ name: "My Orphan", inherits: "Orphan PETG @BBL X1C" }),
    ).rejects.toMatchObject({
      status: 422,
      code: "preset_unresolved",
      fields: {
        category: "filament",
        preset: "My Orphan",
        missing_parent: "fdm_filament_gone",
      },
    });
  });

  it("refuses the stub of a stock preset this tree does not have", async () => {
    // What the Slice dialog sends for a "Standard" pick: the name twice.
    const attempt = resolveFilament({
      name: "Bambu PETG HF @BBL H3C",
      inherits: "Bambu PETG HF @BBL H3C",
    });
    await expect(attempt).rejects.toMatchObject({
      status: 422,
      code: "preset_unresolved",
      fields: {
        preset: "Bambu PETG HF @BBL H3C",
        missing_parent: "Bambu PETG HF @BBL H3C",
      },
    });
    await expect(attempt).rejects.toThrow(
      'Preset "Bambu PETG HF @BBL H3C" is not among this slicer\'s filament profiles',
    );
  });

  it("says which parent of which preset in the message", async () => {
    await expect(
      resolveFilament({ name: "My PETG", inherits: "Nope" }),
    ).rejects.toThrow(
      'Preset "My PETG" cannot be resolved: its parent "Nope" is not among this slicer\'s filament profiles',
    );
  });

  it("refuses when the category has no bundled folder at all", async () => {
    await expect(
      resolveProfile({ name: "p", inherits: "0.20mm Standard" }, "process", {
        bundledProfilesPath: root,
      }),
    ).rejects.toMatchObject({ status: 422, code: "preset_unresolved" });
  });

  it("still resolves a preset whose whole chain is there", async () => {
    await put("filament/Good PETG.json", {
      name: "Good PETG",
      inherits: "fdm_filament_petg",
    });
    const result = await resolveFilament({ name: "mine", inherits: "Good PETG" });
    expect(result.filament_type).toEqual(["PETG"]);
  });
});

describe("the refusal on the wire", () => {
  it("POST /profiles/resolve answers 422 with the preset and the parent as fields", async () => {
    process.env.BUNDLED_PROFILES_PATH = root;
    const res = await supertest(configureApp())
      .post("/profiles/resolve")
      .send({
        category: "filament",
        profile: { name: "My PETG", inherits: "Bambu PETG Basic @BBL H9" },
      })
      .expect(422);

    expect(res.body).toMatchObject({
      error: "preset_unresolved",
      category: "filament",
      preset: "My PETG",
      missing_parent: "Bambu PETG Basic @BBL H9",
    });
    expect(res.body.message).toContain("Bambu PETG Basic @BBL H9");
  });

  it("a slice with such a filament is refused before the slicer is started", async () => {
    process.env.BUNDLED_PROFILES_PATH = root;
    // Never run: the refusal comes while the profiles are being prepared. A
    // request that got as far as the spawn would fail on this path instead,
    // with a 500 and a different message.
    process.env.ORCASLICER_PATH = path.join(root, "no-such-slicer");

    await expect(
      sliceModel(
        Buffer.from("solid x\nendsolid x\n"),
        "model.stl",
        { exportType: "3mf" },
        {
          printer: Buffer.from(JSON.stringify({ type: "machine", name: "P" })),
          preset: Buffer.from(JSON.stringify({ type: "process", name: "Q" })),
          filaments: [
            Buffer.from(
              JSON.stringify({ name: "My PETG", inherits: "Bambu PETG Basic @BBL H9" }),
            ),
          ],
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "preset_unresolved",
      fields: { category: "filament", preset: "My PETG" },
    });
  });
});
