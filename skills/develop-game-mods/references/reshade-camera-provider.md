# ReShade Camera Provider Development

## Contents

1. Scope and authority
2. Capability profiles
3. DCC2 contract
4. Runtime architecture
5. Projection and coordinate semantics
6. Cross-game development workflow
7. Probe and binding diagnostics
8. Build, deployment, and verification
9. Project knowledge boundaries
10. Known-bad assumptions
11. Acceptance criteria

## Scope and authority

Use this reference when a game Mod or native plugin must publish camera data to
ReShade DataCollector through `DataCollectorCameraBridge`.

This is a cross-game playbook, not the protocol source of truth. Before each
implementation, read the target DataCollector ABI header and normal-data
standard. Record their version or hash in the game project. If they disagree
with this reference, the current source wins.

Keep game APIs, RTTI class names, native hashes, loader entry points, world axes,
and observed FOV behavior in the game project. Do not promote one game's adapter
details into this reference without evidence from another target.

## Capability profiles

Choose the smallest profile required by the capture workflow.

### Camera Normal Profile

Required semantic data:

```text
vertical FOV in degrees
```

Publish a structurally valid packet, a changing `sequence`, valid bit 0, and
`fov_y_degrees`. Producer frame ID, timestamp, camera basis, position, and world
matrix are not required for Camera Normal.

In DataCollector, select `UDN Camera Space`. The shader reconstructs positions
from depth using the render-target aspect ratio and the provided vertical FOV.
It does not require the Provider to publish aspect ratio.

### Canonical World Normal Profile

Required semantic data:

```text
vertical FOV in degrees
camera_to_canonical_world 3x3 rotation
```

Set valid bits 0 and 3 independently. Frame ID and timestamp remain optional.
World Normal first reconstructs Camera Normal, so a valid matrix without valid
FOV is insufficient.

If the matrix is missing while World mode is selected, expect the defined
invalid-normal placeholder. Do not fake matrix validity with identity and do not
silently fall back to Camera Normal unless the current receiver specification
explicitly requires that behavior.

### Optional observability fields

- `producer_frame_id`: useful for producer/consumer timing diagnostics.
- `timestamp_qpc`: useful for packet age diagnostics on Windows.
- `sequence`: has no separate valid bit; advance it when publishing a new
  producer snapshot.

A receiver reporting that it accepted a packet does not imply that FOV or the
matrix is valid. Inspect the per-field valid flags.

## DCC2 contract

For DCC2 ABI 2.0, revalidate these values against the current header:

```text
magic: "DCC2" / 0x32434344
ABI: 2.0
struct size: 120 bytes
getter: extern "C" bool __cdecl DC_GetCameraPacketV2(packet*, uint32_t)
matrix layout: row-major float[9]
matrix convention: column-vector multiplication
```

Valid flags:

| Bit | Field | Required for Camera Normal | Required for World Normal |
| --- | --- | --- | --- |
| 0 | vertical FOV | yes | yes |
| 1 | producer frame ID | no | no |
| 2 | QPC timestamp | no | no |
| 3 | camera-to-canonical-world rotation | no | yes |

Typical valid masks are:

```text
0x1: FOV only
0x7: FOV plus frame ID and timestamp
0xF: complete World Normal packet with optional diagnostics
```

The getter must validate the output pointer and size. Clear reserved fields.
Keep struct alignment and offset assertions close to the copied or shared ABI
declaration. Prefer V2 for new Providers; V1 can carry FOV but cannot carry the
world rotation.

The Provider module must already be loaded into the game process for loaded-
module discovery. Verify the Bridge's current discovery policy rather than
assuming it loads arbitrary game plugins itself.

## Runtime architecture

Use this boundary unless the target loader forces a different safe design:

```text
game camera system on a game-safe callback
  -> validate and convert current camera data
  -> publish one synchronized immutable snapshot
  -> DC_GetCameraPacketV2 copies the snapshot only
  -> DataCollectorCameraBridge publishes shader uniforms
```

Rules:

- Do not access game RTTI, entities, or camera systems from the exported getter.
- Do not access game memory during an early loader callback if RTTI or allocators
  are not ready. Register a later ready/running callback.
- Use a mutex, atomically replaced immutable object, or another data-race-safe
  publication mechanism. A logically plausible but formally racy byte copy is
  not sufficient.
- Treat each field independently. A missing matrix must not erase a valid FOV.
- Publish invalid flags during unavailable camera states; do not retain stale
  camera validity across loading, menus, save transitions, or camera teardown.
- Reacquire systems or instances when target runtime evidence shows they can be
  replaced. Cache RTTI metadata only when its lifetime is stable.
- Avoid sidecar or IPC transport unless direct in-process publication is not
  feasible and the additional lifecycle is explicitly designed.

## Projection and coordinate semantics

### FOV

Publish the vertical FOV used by the depth projection, in degrees.

Never infer horizontal-versus-vertical semantics from a getter name. Test at two
controlled game FOV settings and record render aspect ratio. For comparison:

```text
fov_y = 2 * atan(tan(fov_x / 2) / aspect)
fov_x = 2 * atan(tan(fov_y / 2) * aspect)
```

Test dynamic camera states separately: aim/ADS, sprint, vehicle cameras, photo
mode, cutscenes, scopes, scripted zoom, resolution/aspect changes, and menu
transitions. A getter that tracks the settings slider may still omit visible
ADS or post-projection zoom.

Script-wrapper and native calls may return different values or bind different
functions. Validate the exact production call path; preserve contradictory raw
observations instead of averaging or correcting them without proof.

### UDN camera space

The projection-normal camera convention is:

```text
+X: camera right
+Y: camera up
+Z: toward camera
camera forward: -Z
```

The Provider does not publish Camera Normal pixels. It publishes the camera data
needed for DataCollector to reconstruct them from depth.

### Camera-to-game basis

Given game-space camera direction getters:

```text
r_game = camera right
u_game = camera up
f_game = camera viewing direction
B_camera_to_game = [r_game, u_game, -f_game]
```

Do not infer handedness from names. Measure vector lengths, pairwise dot products,
the sign of `cross(right, up)` relative to Forward, and the determinant.

### Canonical world mapping

Construct:

```text
R_camera_to_canonical = A_game_to_canonical * B_camera_to_game
```

Publish only a finite proper rotation: approximately orthonormal with determinant
approximately `+1`. Do not include translation, projection, scale, or shear.

Define and document a heading policy:

- `native-heading`: normalize axes/handedness and preserve the game's heading.
- `capture-start-heading`: map horizontal camera forward at recording start to
  canonical `-Z`.
- `map-heading`: map a verified game north or stable world direction.
- `provider-first-valid-heading`: useful for smoke tests, but not equivalent to
  recording-start heading unless startup is synchronized to capture.

If horizontal forward is degenerate because the camera looks near world up,
wait for a valid heading or use a documented fallback.

## Cross-game development workflow

1. Select Camera-only or World-capable scope before researching APIs.
2. Inventory game version, loader, SDK, compiler, logs, restart/reload behavior,
   and the current DCC ABI.
3. Search the project interface matrix, experiments, pitfalls, installed working
   Mods, SDK declarations, runtime reflection data, and authoritative docs.
4. Build the smallest read-only script or high-level probe when available.
5. Validate FOV semantics with controlled settings and camera modes.
6. For World capability, validate Right/Up/Forward or transform semantics and
   derive the game-to-canonical mapping.
7. Build one bounded native load/read/log milestone before packet publication.
8. Implement synchronized DCC2 publication and exact C exports.
9. Build, inspect exports, deploy while the game is stopped, and verify hashes.
10. Verify loader, Provider, Bridge, shader, and captured output as separate
    layers. Promote evidence only after the exact layer runs.

Stop after the selected profile passes. Do not require world-pose research for a
Camera-only Provider.

## Probe and binding diagnostics

A useful camera probe records:

```text
receiver availability and runtime class
raw FOV and aspect ratio
Right, Up, Forward components
lengths, pairwise dots, cross-product sign, determinant
transform success and representation when relevant
camera mode and controlled FOV setting
```

Bound sampling by count and duration. Provide one-shot and short-window modes
when dynamic transitions matter. Isolate calls so one missing method does not
abort the rest of the probe.

For native RTTI, distinguish these stages in logs:

```text
class/type resolved
function resolved
game-system instance resolved
function execution succeeded
returned value passed semantic validation
packet field published
```

A scripting API proving `receiver:method()` works does not prove that the same
interface class is a valid native invocation context. The concrete implementation
may own the reflected function. Resolve and log the implementation type, function,
and instance separately; use interface fallback only when supported by evidence.

Log availability transitions and one first valid sample. Use a bounded heartbeat
only when needed. Never log every frame.

## Build, deployment, and verification

- Use the loader's authoritative x64 plugin template or a locally successful
  same-loader project.
- Pin the SDK revision and record target game/loader versions.
- Keep source outside the game tree and deploy only owned artifacts.
- Refuse native deployment while the game process is running unless verified hot
  reload is supported.
- Resolve and verify destination containment before copy or cleanup.
- Compare source and deployed hashes.
- Inspect exports for undecorated `DC_GetCameraPacketV2` and loader entry points.
- Keep build products, SDK working trees, logs, and runtime copies out of source
  control unless intentionally packaging them.

Runtime verification should check:

| Layer | Evidence |
| --- | --- |
| Loader | Provider loads/unloads without version or API failure |
| Binding | expected class, functions, and instance resolve |
| Packet | sequence changes; expected valid bits and values appear |
| Bridge | correct Provider selected; uniforms match packet validity |
| Camera Normal | level surfaces and camera rotations match controlled baselines |
| World Normal | camera rotation does not rotate stationary world surfaces |
| Capture | OBS/sliced output preserves the expected channel semantics |

For a Camera-only Provider, World mode is expected to be unavailable. That is not
a failed acceptance test.

## Project knowledge boundaries

Write target-specific evidence to the Mod project:

- `docs/interface-matrix.md`: loader/API capabilities, exact receiver and method,
  versions, limitations, evidence state.
- `docs/experiments.md`: raw values, modes, logs, contradictions, build/deploy
  hashes, visual test results.
- `docs/pitfalls.md`: reproducible wrong contexts, signatures, lifecycle errors,
  coordinate mistakes, and verified fixes.

Record in the project rather than this reference:

```text
game and loader versions
SDK commit
camera system class and function names
native call shape
game world axes and handedness
FOV behavior by camera mode
heading policy and reset mechanism
deployment paths
runtime hashes and logs
```

Promote a lesson into this Skill only when it is protocol-defined or plausibly
cross-game. Keep one-game evidence scoped and labeled.

## Known-bad assumptions

- Treating normalized linear depth as metric depth without the DataCollector
  reconstruction contract.
- Publishing horizontal FOV in a vertical-FOV field.
- Assuming a static FOV setting covers ADS, scopes, cutscenes, or post-projection
  zoom.
- Requiring a world matrix for Camera Normal.
- Marking identity matrix valid when world pose is unavailable.
- Calling game APIs from the Bridge getter or during an unsafe loader phase.
- Copying CET/script receiver syntax directly into native RTTI code.
- Assuming interface and concrete implementation classes expose identical native
  function lookup behavior.
- Inferring basis handedness from method names.
- Calling provider-first heading capture-start heading without synchronization.
- Deploying a loaded native DLL and assuming the process uses the replacement.
- Treating packet receipt as proof that every semantic field is valid.

## Acceptance criteria

### Camera Normal Provider

- The native module and exact DCC2 export load successfully.
- Sequence advances and valid bit 0 reflects current FOV availability.
- FOV is finite, vertical, and validated in at least two controlled states.
- Camera Normal renders correctly in a visual baseline.
- Missing matrix remains explicitly invalid and does not prevent Camera Normal.
- Loading/menu/camera-unavailable behavior clears stale validity safely.

### World Normal Provider

Meet all Camera Normal criteria, plus:

- Basis handedness and game axes are runtime-verified.
- Heading policy is explicit.
- Matrix is finite, approximately orthonormal, and determinant `+1`.
- Valid bit 3 tracks current matrix availability independently.
- Controlled yaw/pitch/roll and stationary-world tests match canonical-space
  expectations.

For both profiles, require reproducible build/deploy steps, bounded diagnostics,
source/deployed hash verification, and updated project evidence.
