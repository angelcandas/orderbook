## 2026-11-19 00:40 UTC · b9a9381 · ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)

Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, linux 6.18.44-fc-v653. 10 s per scenario after 4 s warmup, 1440x900.

| Scenario | Level changes/s | Frame p50 / p99 (ms) | Slow frames | Render CPU p50 / p99 (ms) | Receive→draw p50 / p99 (ms) | Parse+apply p99 (ms) | Main long frames | Checksum / gaps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 pair, 2k/s | 2,029 | 17.9 / 33.3 | 2.39% | 0.26 / 0.66 | 4.1 / 7.5 | 0.800 | 0 | 0 / 0 |
| 10 pairs, 10k/s | 11,636 | 17.9 / 33.3 | 17.45% | 0.36 / 1.22 | 3.2 / 6.9 | 0.513 | 0 | 0 / 0 |
| 10 pairs, 50k/s | 51,661 | 17.9 / 33.3 | 32.45% | 0.36 / 1.22 | 3.4 / 7.5 | 2.238 | 0 | 0 / 0 |
| 25 pairs, 100k/s | 103,338 | 17.9 / 33.3 | 31.36% | 0.36 / 1.45 | 3.2 / 7.5 | 1.663 | 0 | 0 / 0 |
| 10 pairs, 10k/s, CPU 4x slower | 11,708 | 17.9 / 33.3 | 28.88% | 0.33 / 1.22 | 3.2 / 8.9 | 0.611 | 1 | 0 / 0 |
