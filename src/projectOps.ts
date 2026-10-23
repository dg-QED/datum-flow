// Whole-project operations shared by the UI and the AI tools.
import { buildSample, type SampleId } from "./model/samples";
import type { Project } from "./model/types";
import { getState, initialSim, setState } from "./store";
import * as simctl from "./simctl";
import { resetLive } from "./live";

/** Replace the open model. keepUndo: push the current model as one undo step instead of clearing history. */
export function openProject(p: Project, opts: { keepUndo?: boolean } = {}) {
  simctl.cancelMonteCarlo();
  resetLive(null);
  const level = p.view?.level && p.levels.some((l) => l.id === p.view!.level) ? p.view.level : [...p.levels].sort((a, b) => b.elevation - a.elevation)[0].id;
  const prev = getState().project;
  setState((s) => ({
    project: p, level, selection: [],
    undo: opts.keepUndo && prev ? [...s.undo.slice(-79), structuredClone({ ...prev, results: undefined })] : [], redo: [],
    sim: { ...initialSim, speed: s.sim.speed }, info: null, handCalc: null, series: null, results: null, scrub: null, follow: null, mc: null, rev: s.rev + 1, tool: "select",
  }));
}
export function loadSample(id: SampleId, opts: { keepUndo?: boolean } = {}) {
  const p = buildSample(id);
  openProject(p, opts);
  if (id === "office") setState({ level: p.levels.find((l) => l.name === "Level 2")!.id });
}
