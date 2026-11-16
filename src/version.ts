// The version of THIS wrapper's code — not the slicer's, which /health reports
// separately. Reported as `sidecarVersion` by GET /health.
//
// BamDude builds the wrapper from this repository whenever an operator
// rebuilds the slicer containers, on its own schedule, so a BamDude release
// cannot assume which wrapper it is talking to. It reads this number and
// compares it with the one it needs; an image that reports none predates the
// number and counts as older than every version.
//
// Bumped BY HAND, by one, in the commit that adds or changes something a
// caller can depend on — a new endpoint or field, a changed refusal, a
// different listing. Not for refactors or fixes a caller cannot observe.
// Say here what each number added.
//
//   1  Presets found by name in any folder of their category (subfolders,
//      "/" in a name); 422 `preset_unresolved` instead of slicing on defaults;
//      a renamed printer keeps its stock parent; OrcaSlicer's filament
//      library listed and resolved; ordered filament listing; this number.
export const SIDECAR_VERSION = 1;
