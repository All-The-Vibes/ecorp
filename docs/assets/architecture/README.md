# ECorp architecture artwork

## Current explanatory diagrams

Reviewed against main `39632b957819012721c90902925d8fa7a9c7e873` on
September 19, 2026 (UTC):

| View | Editable source | PNG |
| --- | --- | --- |
| Three planes, multiplayer context, and the cross-cutting trust fabric | [System overview](ecorp-architecture-multiplayer-v3.svg) | [1680 × 1000](ecorp-architecture-multiplayer-v3.png) |
| Shared mission context, fenced human control, replay, and independent runners | [Multiplayer](ecorp-multiplayer-control-v1.svg) | [1680 × 1000](ecorp-multiplayer-control-v1.png) |
| Source, contributors, evidence, and acceptance rules woven through the work | [Blockchain as fabric](ecorp-trust-fabric-v1.svg) | [1680 × 1000](ecorp-trust-fabric-v1.png) |

These are code-native technical diagrams, not generated scene artwork. Their
labels are editable SVG text; the PNGs are direct raster exports. They reuse the
approved ECorp mark and the incumbent navy, ivory, coral, and teal direction.
The original generated factory artwork, hero, and logo bytes are unchanged.

[Trust fabric](../../TRUST_FABRIC.md) maps the woven model to actual source and
sets its limits. The diagrams do not introduce a product called Fabric, a token
network, distributed consensus, or a second source of operational authority.
The multiplayer view depicts the implemented foundation; the
[parity matrix](../../multiplayer/U7_PARITY_MATRIX.md) retains remaining release
and cross-owner acceptance work.

## Original factory illustration

[Open the preserved full-resolution artwork](ecorp-architecture-retro-v2.jpg).

### Original artwork: origin and branding

Created in **Google Gemini**, image mode with **Pro Extended**, on September 6, 2026
(America/Chicago). Gemini used the existing approved
[software-factory hero](../branding/source/ecorp-software-factory-hero-v2.jpg) and a PNG export of
the [outlined ECorp logo](../branding/svg/ecorp-logo.svg) as references.

The final JPEG is **2752 × 1536**, downloaded at native resolution without cropping, recompression,
retouching, or upscaling. It preserves ECorp's ivory, navy, coral, and teal retro-futuristic sprite
theme. The existing hero and logo were not modified.

The corrected diagram names the central component **ECorp Control Server**. **Rust + Axum**
appears only as a smaller implementation annotation, not as the component's architectural identity.
The [previous image](ecorp-architecture-retro.jpg) is retained for reference.

SHA-256:

```text
1bb05beb712257f7c1739986d2bc495f3ee0c260bd1aaf6b17ed633c82a36fb3
```

### Original illustration: architecture scope

Grounded in [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) at
`e76adf03185d2dd93b2761ecb5cf4ceee41a79e5`. The illustration shows three logical planes,
runner-side verification, private artifact storage, and human-authorized pull-request publication.
Storage is intentionally vendor-neutral; the picture does not assert a particular cloud deployment.

This is a raster illustration, not an editable vector diagram or an exhaustive security model.
Runtime availability varies by runner and platform. Git worktrees are not complete OS sandboxes,
and publication does not authorize automatic merge or deployment.
