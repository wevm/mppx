# Runtime benchmark — 2026-09-28

Measured implementation: `9e45f7e3`. These measurements apply to the combination
of the [fixture changes](https://github.com/wevm/mppx/pull/926) and
[scheduling changes](https://github.com/wevm/mppx/pull/927). The PRs can be merged
independently; the results describe their combined effect.

## GitHub Actions

Observed Ubuntu runner times from [the reference run](https://github.com/wevm/mppx/actions/runs/36450981124)
and [the optimized run](https://github.com/wevm/mppx/actions/runs/36453850508).
Both completed their runtime jobs successfully.

| Configuration | Job       | Test step | Entire job |
| ------------- | --------- | --------: | ---------: |
| Before        | Node 1/2  |      256s |       341s |
| Before        | Node 2/2  |      106s |       190s |
| Before        | CLI       |      167s |       232s |
| After         | Node      |       58s |        97s |
| After         | Tempo 1/2 |       61s |       158s |
| After         | Tempo 2/2 |       76s |       151s |
| After         | CLI       |       22s |        57s |

- Longest runtime job: **341s → 158s**, a **54% reduction**.
- Sum of runtime job durations: **763s → 463s**, a **39% reduction**, despite adding a fourth job.
- Summed assertion time in the two integration shards: **37.4s and 39.8s**.
- CLI validation assertions: **132.3s → 4.1s**.

These are single CI observations, not a controlled same-revision experiment:
the reference PR also contains additional fee-token tests. Setup, runner load,
and queue time vary. Entire-job times exclude time waiting for a runner;
test-step times include runner startup and teardown. JSON timing reports and
verbose logs are attached to the optimized run as `runtime-test-log-*` artifacts.

## Controlled local fixture comparison

Baseline: `dcf15895`; optimized: `9e45f7e3`. Same macOS arm64 machine,
Node v24.13.0, and locked dependencies. All four suites ran serially, with
`--retry=0` and `VITE_TEMPO_NETWORK=none`. Values below are suite elapsed times,
excluding runner startup. One baseline run; median of three optimized runs.

| Suite           |  Before |  After | Reduction |
| --------------- | ------: | -----: | --------: |
| CLI validation  | 172.51s | 13.80s |     92.0% |
| Session client  |  37.04s |  0.14s |     99.6% |
| Session manager |  33.95s |  0.12s |     99.6% |
| Session server  |  65.85s |  4.48s |     93.2% |

The three session suites passed all 242 tests before and after. The unchanged
CLI baseline was run with an empty `XDG_DATA_HOME` to avoid installed-skill
notices contaminating captured JSON; all 58 tests passed. The optimized CLI
suite isolates its own data directory and includes three additional polling
cases; all 61 tests passed in each optimized run. Its observed range was
12.73–15.69s.

The fixture comparison isolates retry/polling changes from file parallelism.
Use the CI observations above to evaluate the combined scheduling changes.
