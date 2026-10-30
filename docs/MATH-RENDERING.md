# Math Rendering Fix Guide

---

## How data comes in

Each question from the DB has string fields — `question_text`, `choice_a` through `choice_e`. These are plain strings that may or may not already contain LaTeX delimiters:

```
"Solve 2x + 3 = 7 for x."                        // no delimiters
"Solve \( 2x + 3 = 7 \) for x."                  // already delimited
"\[ x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \]"   // display math
```


---

## Step 1 — Check for delimiters

Look for any of these three formats:

| Format | Type |
|---|---|
| `\( ... \)` | Inline math |
| `\[ ... \]` | Display math (centered block) |
| `$$ ... $$` | Display math (centered block) |

If delimiters are present → go to **Step 2**.  
If not → go to **Step 3**.

---

## Step 2 — Normalize inside the delimiters

Strip the delimiters, clean up what's inside, then re-wrap. Common things to fix:

| Raw inside delimiter | What KaTeX needs |
|---|---|
| `sqrt(x)` | `\sqrt{x}` |
| `3rd-root(8)` | `\sqrt[3]{8}` |
| `1/2` | `\frac{1}{2}` |
| `(x+1)/(x-1)` | `\frac{x+1}{x-1}` |
| `x^(n+1)` | `x^{n+1}` |
| `sin x`, `cos x`, `log x` | `\sin x`, `\cos x`, `\log x` |
| `log₂ x` | `\log_2 x` |
| `3.2 × 10^5` | `3.2 \times 10^{5}` |
| `π`, `θ` | `\pi`, `\theta` |
| `≤`, `≥`, `≠` | `\le`, `\ge`, `\ne` |
| `>=`, `<=`, `!=` | `\ge`, `\le`, `\ne` |
| `∈`, `∉` | `\in`, `\notin` |
| `a dot b` | `a \cdot b` |
| `5 cm^2` | `5\text{ cm}^2` |

Then go to **Step 4**.

---

## Step 3 — Auto-detect and wrap raw math

If there were no delimiters, scan the string for math signals and wrap each detected expression in `\( ... \)`:

- Bare LaTeX: `\frac{1}{2}`, `\sqrt{x}`
- Equations: `f(x) = 2x + 1`, `x^2 - 1 = 0`
- Fractions: `1/2`, `(x+1)/(x-1)`
- Roots: `sqrt(x)`, `3rd-root(8)`
- Trig: `sin^2 θ`
- Logs: `log₂ x`, `log_2(x)`
- Scientific notation: `3.2 × 10^5`
- Inequalities: `x >= 0`, `y != 5`

Once wrapped, run **Step 2** on what's inside the new delimiters.

---

## Step 4 — Render with KaTeX

Pass each delimited segment to KaTeX:

```js
katex.renderToString(math, {
  displayMode,        // true for \[...\] and $$...$$, false for \(...\)
  throwOnError: false,
  strict: "ignore",
})
```

Everything outside delimiters renders as plain text. The final output is an array of plain-text strings and KaTeX HTML strings, rendered inline.
