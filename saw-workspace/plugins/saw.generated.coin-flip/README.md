# Coin Flip (SAW plugin)

Simulates flipping a (possibly biased) coin one or more times.

## Params
- `num_flips` (number, default `1`): number of flips to simulate.
- `p_heads` (number, default `0.5`): probability of heads (clamped to `[0, 1]`).
- `seed` (string, optional): if provided, results are deterministic for the same seed + settings.
- `return_labels` (string, default `HT`): use `HT` for `H/T` output, or `words` for `heads/tails`.

## Outputs
- `flips` (array): list of flip results.
- `summary` (object): counts + settings.
