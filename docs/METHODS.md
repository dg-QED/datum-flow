# Datum Flow: methods, parameters and sources

This note describes what Datum Flow 1.0 computes, with the equations, default parameters and the sources behind them. Flow is a planning tool. Its outputs support design and operational decisions, but they are **not** a code-compliance demonstration or a life-safety engineering analysis.

---

## 1. Geometry and compilation

A project has levels, each with an elevation, and plan elements in metres. Before every run, `sim/world.ts` turns the project and the chosen scenario into simulation geometry. It does six things:

1. **Wall segments.** Wall polylines become segments with a half-thickness. Any door or exit drawn along a wall cuts that wall: the opening must be parallel within cos > 0.97 and both ends must lie within the wall's half-thickness plus 8 cm. Closed doors and exits, and the doors and exits closed by the scenario, become walls. Obstacle polygons add their edges. Seating rows add solid segments 0.30 m deep. Stairs add side walls and a closed far end on their own level, and their footprint becomes solid on the level they connect to.
2. **Navigation grid.** Each level gets a grid with 0.25 m cells by default, covering everything on that level plus 3 m. A cell is blocked when its centre lies within max(half-thickness, 0.71·h) of a static segment, or inside an obstacle or stair underside. The 0.71·h threshold closes diagonal leaks for an 8-neighbour stencil. Grids are capped at 2 M cells and coarsen automatically beyond that.
3. **Slowness field.** s = 1 + 1.2·max(0, 1 − d/c), where d is the distance to the nearest blocked cell (chamfer 3-4 transform) and c is the wall clearance (0.4 m). Routes therefore keep off walls and corners without changing their topology. Stair footprints divide s by the mean of the stair's up and down speed factors.
4. **One-way barriers.** Cells within 1.6·h of a barrier carry the barrier id and the side they are on.
5. **Spatial hashes.** There are two per level: one for wall segments (1.5 m cells, each segment registered within its reach of 1.1 m) and one for openings (crossing detection).
6. **Seating layout.** Rows are generated parallel to the block's local x axis, front row at y = 0, at a pitch p (0.85 m by default). The solid part of each row is 0.30 m and the clearway is p − 0.30 m. People stand in the clearway at each seat centre (seat width 0.50 m). Aisles are cut at the chosen ends. With "open" ends, rows are open at both sides; otherwise any end without an aisle gets a side wall. Wheelchair users are placed only at seats next to an aisle.

## 2. Navigation: floor fields

For every goal Flow solves the eikonal equation

  |∇T(x)| = s(x),  T = 0 on the goal,

by **fast marching** (Sethian 1996). A goal is an exit segment, an attractor and its server points, a seating block, or a zone. Each trial cell takes the smaller of two first-order upwind solutions:

- the axis-aligned stencil with spacing h, using neighbours (x ± h, y) and (x, y ± h);
- the 45°-rotated stencil with spacing h√2, using the diagonal neighbours.

This follows the multi-stencil idea of Hassouna & Farag (2007). A diagonal update is only allowed through a corner that is open on at least one side. With a one-way barrier, cell c may not take its value from neighbour n when c lies on the barrier's forbidden (right) side and n on its permitted (left) side. Backward propagation from the goal therefore never creates a path that crosses the barrier the wrong way.

**Multi-level coupling.** A stair from a on level A to b on level B has two portals. One is the cells inside the flight within 0.6 m of b, on level A. The other is the cells in front of the b face, on level B. After marching each level, Flow seeds the portal on the side where the route through the stair is *shorter*:

  T_A(portal) ← T_B(arrival) + 0.05 if T_B(arrival) + 0.05 < T_A(b-end), and the reverse for going up.

It then re-marches the affected levels, repeating until no seed changes (at most 2·levels + 2 passes). Because a portal is never fed from its own value, no artificial sinks appear.

**Desired direction.** e = −∇T/|∇T|. The gradient is estimated by central differences at the four cell centres around the person (one-sided next to blocked cells), normalised, and blended bilinearly. A person inside a blocked cell heads for the lowest free cell within 2 cells. Each person's direction is refreshed every other step.

Accuracy (tests): on an empty grid with a point source, the maximum error is 0.17 m (0.68 cells) and the relative error is at most 2.3 % beyond 2 m. Around a 30 m wall the result is 45.53 m against a geodesic of 45.17 m.

## 3. Movement: social force

For each person *i* with mass mᵢ, radius rᵢ, desired speed v⁰ᵢ and relaxation time τᵢ (Helbing & Molnár 1995; Helbing, Farkas & Vicsek 2000):

  mᵢ dvᵢ/dt = mᵢ (v⁰ᵢ eᵢ − vᵢ)/τᵢ + Σⱼ fᵢⱼ + Σ_W fᵢW + f_group

**Person–person.** With dᵢⱼ the distance between centres, nᵢⱼ the unit vector from j to i, tᵢⱼ the tangent, rᵢⱼ = rᵢ + rⱼ and g(x) = max(0, x):

  fᵢⱼ = [A·exp((rᵢⱼ − dᵢⱼ)/B)·w(φ) + k·g(rᵢⱼ − dᵢⱼ)] nᵢⱼ + κ·g(rᵢⱼ − dᵢⱼ)·((vⱼ − vᵢ)·tᵢⱼ) tᵢⱼ

  w(φ) = λ + (1 − λ)(1 + cos φ)/2, where φ is the angle between eᵢ and −nᵢⱼ (Helbing & Johansson 2009).

**Person–wall.** With dᵢW the distance to the wall surface (centre-line distance minus half-thickness):

  fᵢW = A_w·exp((rᵢ − dᵢW)/B_w)·n′ + k·g(rᵢ − dᵢW) nᵢW − κ·g(rᵢ − dᵢW)(vᵢ·tᵢW) tᵢW

  where n′ is nᵢW with its component *against* eᵢ removed whenever nᵢW·eᵢ < 0.

This change to HFV 2000 is deliberate. With the isotropic wall term, a person slower than about 0.9 m/s stands in equilibrium in front of a 1 m door, held back by the two jambs. The contact force (k) and friction (κ) still act along the true normal. A hard limit stops a crowd pushing anyone more than 6 cm into a wall.

**Groups** (after Moussaïd et al. 2010). A member farther than 0.5 + 0.25(n − 1) m from the centre of its moving group is pulled back with a force of at most 40 % of its driving force. The pull applies only while the group is within 4 m of each other. Members share their leader's exit, start within 3 s of each other and walk at the group's slowest desired speed.

**Stairs.** On a stair footprint the desired speed is multiplied by the stair's factor for the direction of travel (down or up) and by the profile's stair factor. Reaching the far end within 0.3 m + r moves the person to the other level, 0.45 m + r in front of the stair face. The move waits until that spot is clear, and up to 5 lateral positions are tried.

**Blocked people.** After 2 s with less than 10 % of the free-speed step, a person's desired direction is turned by a pseudo-random angle of up to ±70°, re-drawn every 1.5 s. This is the fluctuation term ξ of HFV 2000, applied only when stuck. Their effective radius also shrinks linearly to 65 % over 8 s. Both measures break symmetric deadlocks that a deterministic social force can produce in narrow aisles, and they relax as soon as the person moves.

**Integration.** Semi-implicit Euler with a fixed step dt = 0.05 s and 2 sub-steps (ω·dt ≈ 0.97 for the contact stiffness). Speed is capped at |v| ≤ max(0.6, 1.3·v⁰) (HFV). Neighbours come from a 1 m uniform hash per level (3 × 3 cells). The neighbour loop reads cell-ordered copies of the positions for cache locality, and pairs beyond rᵢⱼ + 0.55 m are skipped (the exponential term is below 2 % of A there).

### Parameters

| Symbol | Value | Source |
|---|---|---|
| A, A_w | 2000 N | HFV 2000 |
| B, B_w | 0.08 m | HFV 2000 |
| k | 1.2·10⁵ kg/s² | HFV 2000 |
| κ | 2.4·10⁵ kg/(m·s) | HFV 2000 |
| τ | 0.5 s (adult) | HFV 2000 |
| m | 80 kg (adult) | HFV 2000 |
| λ | 0.5 | calibrated to the 1 m door test below; λ = 1 is HFV 2000 |
| dt / sub-steps | 0.05 s / 2 | — |

### Profiles

| Profile | v⁰ m/s (mean ± sd, clamp) | radius m | τ s | stair × | source |
|---|---|---|---|---|---|
| Adult | 1.34 ± 0.26 (0.7–2.0) | 0.23 ± 0.02 | 0.5 | 1.0 | Weidmann (1993); Fruin (1971) body ellipse 0.46 × 0.61 m |
| Older adult | 1.05 ± 0.20 (0.5–1.5) | 0.23 | 0.6 | 0.85 | Bohannon & Andrews (2011): 0.94–1.26 m/s for ages 70–99; Fujiyama & Tyler (2004) |
| Child | 1.10 ± 0.25 (0.5–1.8) | 0.18 | 0.5 | 0.9 | assumption; compare Larusdottir & Dederichs (2012) |
| Mobility impaired / wheelchair | 0.69 ± 0.35 (0.3–1.3) | 0.36 | 0.9 | 0.3 | Boyce, Shields & Silcock (1999): manual wheelchair 0.69 ± 0.35, electric 0.89, walking frame 0.57 m/s; 0.70 m chair width (ISO 7193) |
| Staff | 1.40 ± 0.15 (1.0–2.0) | 0.23 | 0.45 | 1.05 | assumption |

**Stair speed factors.** The defaults are 0.52 descending and 0.45 ascending, as fractions of free speed (horizontal component). Fujiyama & Tyler (2004, Table 3) measured normal-pace horizontal speeds on 30.5–35° flights for adults aged 25–60 of 0.56–0.63 m/s ascending and 0.65–0.74 m/s descending. Ramps default to 0.9 / 0.8.

**Pre-movement.** Distributions are set per spawn zone, plus one for seated occupants per scenario. The defaults are log-normal (median, σ): office 60 s / 0.4 (P90 ≈ 100 s); theatre seats 30 s / 0.5; arena evacuation seats 40 s / 0.45. Arena post-event egress uses uniform 0–120 s and half-time uses 0–180 s. All of these are **planning assumptions**. Replace them with project-specific values, for example from the SFPE Handbook pre-movement data or from drills.

## 4. Decisions

- **Nearest exit:** the exit with minimum T at the start position, kept for the whole run.
- **Least time (congestion-aware):** every 2 s each person evaluates every open exit e as cost_e = max(T_e / v⁰, Q_e / C_e). Here Q_e is the number of people assigned to e who are closer to it (by T_e, refreshed every 1 s) and C_e = 1.3 p/(m·s) × width. A person switches only if the new cost is below 85 % of the current one and saves more than 4 s. Group followers copy their leader.
- **Attractors:** a person goes to the instance of the requested type with minimum walk time plus queue length × mean service time / servers. They join the queue within 4 m of the service point or 2.5 m of the queue tail, and walk to their slot. Queue slots are spaced 0.62 m, snaking every 10 places. The head of the queue takes a free server, stays for a sampled service time, and then moves on to the next leg of their plan.
- **Doors with a max flow:** a token bucket with rate q p/s and capacity max(1, q). While it is empty, the door acts as a wall.

## 5. Metrics

- **Density:** person counts on a 0.5 m grid, summed over a 3 × 3 window (1.5 × 1.5 m) and divided by 2.25 m². A cell is set to 0 when the window holds fewer than 2 people, which avoids a halo around isolated people, and also inside seating blocks. Density is updated every 0.5 s. **Maximum density** is the per-cell maximum over the run. **Time in congestion** adds up time at or above the congestion density, which defaults to 2.0 p/m² (just below the 2.17 p/m² onset of Fruin walkway LOS F), per cell and per person.
- **LOS** (Fruin 1971), as area per person: walkway A ≥ 3.25, B 2.32–3.25, C 1.39–2.32, D 0.93–1.39, E 0.46–0.93, F < 0.46 m²/p. The app also offers Fruin's queuing (1.21 / 0.93 / 0.65 / 0.28 / 0.19) and stairway (1.86 / 1.39 / 0.93 / 0.65 / 0.37) standards.
- **Flows:** net crossings of each opening (stepping back over a line within the same opening cancels the crossing), binned every 10 s for peaks and as a 1 s cumulative series. The UI and CSV report flow as persons per metre of clear width per minute over a 10 s moving window.
- **TET** is the time the last person with an exit leg leaves. **P50 / P90** are completion-time percentiles. **RSET = pre-movement + travel**: the report gives mean pre-movement, P90 pre-movement and mean travel time after pre-movement.

## 6. Hand-calculation cross-checks

These are shown beside the simulation and clearly labelled as cross-checks.

**SFPE hydraulic method** (SFPE Handbook, 5th ed., 2016, ch. 59):
- Speed is S = k(1 − aD) with a = 0.266 m²/p. For D ≤ 0.54 p/m², S = 1.40·(1 − 0.266·0.54) ≈ 1.20 m/s.
- The maximum specific flow is Fsm = 1.32 p/(s·m) of effective width for doors, corridors and ramps, and 1.01 for 7/11 stairs.
- Effective width = clear width − boundary layers: 0.15 m each side for door jambs and stair walls.
- Each person is assigned to the exit with the shortest floor-field route. Per exit, t_e = max(L_max/S, L_min/S + N_e/(Fsm·W_e)).
- Stairs leaving levels without exits get N_s/(Fsm·W_s).
- RSET_hydraulic = P99 pre-movement + the largest of these times.

**Ontario Building Code** (O. Reg. 332/12) Div. B 3.4.3.2, identical to NBC 2015/2020 3.4.3.2:
- Sentence (1): the required aggregate exit width is the occupant load × 6.1 mm for doorways, corridors, passageways and ramps ≤ 1 in 8. It is 8 mm per person for stairs with rise ≤ 180 mm and run ≥ 280 mm, and 9.2 mm per person for other stairs and steeper ramps.
- Sentence (7): with more than one exit, no exit is counted for more than half the required width.
- Flow reports the exit check (population × 6.1 mm vs counted width) and, for multi-level models, the stair check (population on levels without exits × 8 mm vs total stair width).
- Every other code requirement is out of scope: travel distance, number and separation of exits, Group A-4 values (1.8 / 2.4 mm per person), care occupancies (18.4 mm per person) and aisle rules.

## 7. Validation summary

| Check | Expectation | Flow 1.0 |
|---|---|---|
| FMM vs Euclidean | ≤ 2 cells, ≤ 3 % | 0.68 cells, 2.3 % |
| FMM vs geodesic around a wall | ≤ 3 % + 2 cells | 45.53 vs 45.17 m |
| Free walking, 45 m | d/v⁰ + τ ± 5 % | −0.4 % |
| 1.0 m door, dense crowd | 1.2–1.5 p/(m·s) (SFPE 1.32; Weidmann 1.22; Fruin ≈ 1.3–1.4) | 1.32 (1.27–1.36 over 3 seeds) |
| Bidirectional corridor | lane order rises | Φ 0.20 → 0.41 |
| Determinism | same seed → identical | ✓ |
| Office sample | simulation ≈ hydraulic | 218 s vs 212 s |

Bottleneck experiments with motivated young adults report higher flows of 1.6–1.9 p/(m·s) (Seyfried et al. 2009; Kretz et al. 2006). Flow's defaults aim at the lower design values used in practice. Raise λ toward 1, or raise the desired speeds, to test more competitive egress.

## 8. Sources

- Boyce, K.E., Shields, T.J., Silcock, G.W.H. (1999). Toward the characterization of building occupancies for fire safety engineering: capabilities of disabled people moving horizontally and on an incline. *Fire Technology* 35(1):51–67.
- Bohannon, R.W., Andrews, A.W. (2011). Normal walking speed: a descriptive meta-analysis. *Physiotherapy* 97(3):182–189.
- Fruin, J.J. (1971). *Pedestrian Planning and Design*. Metropolitan Association of Urban Designers and Environmental Planners.
- Fujiyama, T., Tyler, N. (2004). Pedestrian speeds on stairs: an initial step for a simulation model. UTSG, Newcastle upon Tyne.
- Gwynne, S.M.V., Rosenbaum, E.R. (2016). Employing the hydraulic model in assessing emergency movement. *SFPE Handbook of Fire Protection Engineering*, 5th ed., ch. 59.
- Hassouna, M.S., Farag, A.A. (2007). Multistencils fast marching methods. *IEEE Trans. PAMI* 29(9):1563–1574.
- Helbing, D., Farkas, I., Vicsek, T. (2000). Simulating dynamical features of escape panic. *Nature* 407:487–490.
- Helbing, D., Johansson, A. (2009). Pedestrian, crowd and evacuation dynamics. *Encyclopedia of Complexity and Systems Science*, Springer.
- Helbing, D., Molnár, P. (1995). Social force model for pedestrian dynamics. *Physical Review E* 51:4282–4286.
- Kretz, T., Grünebohm, A., Schreckenberg, M. (2006). Experimental study of pedestrian flow through a bottleneck. *J. Stat. Mech.* P10014.
- Larusdottir, A.R., Dederichs, A.S. (2012). Evacuation of children: movement on stairs and on horizontal plane. *Fire Technology* 48:43–53.
- Moussaïd, M., Perozo, N., Garnier, S., Helbing, D., Theraulaz, G. (2010). The walking behaviour of pedestrian social groups and its impact on crowd dynamics. *PLoS ONE* 5(4):e10047.
- National Building Code of Canada 2015/2020, Div. B, Article 3.4.3.2; Ontario Building Code, O. Reg. 332/12, Div. B, Article 3.4.3.2.
- Sethian, J.A. (1996). A fast marching level set method for monotonically advancing fronts. *PNAS* 93(4):1591–1595.
- Seyfried, A., Passon, O., Steffen, B., Boltes, M., Rupprecht, T., Klingsch, W. (2009). New insights into pedestrian flow through bottlenecks. *Transportation Science* 43(3):395–406.
- Weidmann, U. (1993). *Transporttechnik der Fussgänger*. Schriftenreihe des IVT Nr. 90, ETH Zürich.
