# PptxGenJS 4.0.1 distribution

This directory contains the unmodified runtime, types and MIT license from the official npm `pptxgenjs@4.0.1` tarball. The tarball SHA-512 was verified before extraction; `UPSTREAM.json` records that integrity value and per-file SHA-256 values.

The only packaging changes are removal of the unused `image-size` runtime dependency and upstream development dependencies/scripts. Other runtime dependencies and the original package name/version/exports are preserved. No image parser has been renamed, suppressed, or replaced with a stub: the vulnerable parser is absent from the installed dependency graph. The published ESM/CJS/browser artifacts do not import it; their bytes are unchanged.

This packaging correction addresses GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq, for which the upstream image-size package has no published fix as of 2026-09-08. It preserves the existing local `generate-ppt.ts` tool. The original and a reduced-dependency package both generated its 15 slides; all 106 ZIP entries matched after normalizing generation timestamps and temporary image-directory paths (including all slide, media and relationship content).

Run `node scripts/ci/check-vendored-pptxgen.mjs` after a clean install. Dependency audits remain enabled for both production and development. Future upgrades must verify a fresh official tarball, review its dependency use, update checksums, and repeat ESM/CJS and presentation output comparisons. Do not edit runtime artifacts here to silence a scan. Prefer returning to a regular upstream dependency once its published dependency graph is safe.
