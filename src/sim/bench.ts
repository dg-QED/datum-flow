// Synthetic benchmark model: an open hall with columns and four wide exits, filled to the requested
// population. Used by the in-app benchmark and the e2e performance check.
import { emptyProject, newElement, newScenario } from "../model/defaults";
import type { Element, P, Project } from "../model/types";

export function benchProject(agents: number): Project {
  const p = emptyProject(`Benchmark hall — ${agents.toLocaleString("en-CA")} people`);
  const L = p.levels[0].id;
  // ~1.2 p/m² over the occupied area
  const area = agents / 1.2;
  const W = Math.round(Math.sqrt(area * 1.6)), H = Math.round(area / W);
  const E: Element[] = [];
  const M = 12;   // circulation margin around the crowd
  const X = W + 2 * M, Y = H + 2 * M;
  const ex = (a: P, b: P) => newElement("exit", L, { a, b });
  E.push(newElement("wall", L, { pts: [[0, 0], [X, 0], [X, Y], [0, Y]], closed: true, thickness: 0.3 }));
  E.push(ex([X / 2 - 4, 0], [X / 2 + 4, 0]), ex([X / 2 - 4, Y], [X / 2 + 4, Y]), ex([0, Y / 2 - 4], [0, Y / 2 + 4]), ex([X, Y / 2 - 4], [X, Y / 2 + 4]));
  for (let cx = M + 6; cx < X - M; cx += 12) for (let cy = M + 6; cy < Y - M; cy += 12)
    E.push(newElement("obstacle", L, { pts: [[cx - 0.4, cy - 0.4], [cx + 0.4, cy - 0.4], [cx + 0.4, cy + 0.4], [cx - 0.4, cy + 0.4]] }));
  E.push(newElement("spawn", L, { pts: [[M, M], [M + W, M], [M + W, M + H], [M, M + H]], mode: "count", count: agents, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0.2 }));
  p.elements = E;
  const sc = newScenario("evacuation", "Benchmark");
  sc.exitChoice = "least-time";
  p.scenarios = [sc]; p.activeScenario = sc.id;
  return p;
}
