// .dflow.json save / open with light validation and defaults for missing fields.
import type { Project } from "../model/types";
import { DEFAULT_SETTINGS, PROFILES, newScenario } from "../model/defaults";

export function serializeProject(p: Project): string {
  return JSON.stringify({ ...p, format: "datum-flow", version: 1, savedAt: new Date().toISOString(), app: "Datum Flow 1.0.0" }, null, 1);
}

export function parseProject(text: string): Project {
  let j: Partial<Project> & { format?: string };
  try { j = JSON.parse(text); } catch { throw new Error("Not a JSON file"); }
  if (j.format !== "datum-flow") throw new Error("Not a Datum Flow project (.dflow.json)");
  if (!Array.isArray(j.levels) || !j.levels.length) throw new Error("Project has no levels");
  if (!Array.isArray(j.elements)) throw new Error("Project has no elements array");
  const levelIds = new Set(j.levels.map((l) => l.id));
  const elements = j.elements.filter((e) => e && typeof e === "object" && levelIds.has(e.level));
  const profiles = PROFILES.map((d) => ({ ...d, ...(j.profiles?.find((p) => p.id === d.id) ?? {}) }));
  const scenarios = Array.isArray(j.scenarios) && j.scenarios.length ? j.scenarios.map((s) => ({ ...newScenario(s.kind ?? "evacuation"), ...s })) : [newScenario("evacuation")];
  return {
    format: "datum-flow", version: 1,
    title: j.title ?? "Untitled model",
    sample: j.sample,
    levels: j.levels.map((l) => ({ ...l, height: l.height ?? 4 })),
    elements,
    profiles,
    scenarios,
    activeScenario: scenarios.some((s) => s.id === j.activeScenario) ? j.activeScenario! : scenarios[0].id,
    settings: { ...DEFAULT_SETTINGS, ...(j.settings ?? {}), sf: { ...DEFAULT_SETTINGS.sf, ...(j.settings?.sf ?? {}) } },
    results: j.results,
    view: j.view,
  };
}
