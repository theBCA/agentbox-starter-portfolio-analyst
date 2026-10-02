# Fonts shipped with the page

The page must not depend on the network at demo time (it is shown on planes,
in locked-down customer networks and on air-gapped installs), so its two
typefaces ship here as woff2 and `index.html` loads them with `@font-face`,
falling back to `system-ui` when a file is missing.

| File | Family | Weight | Subset |
|---|---|---|---|
| `InstrumentSans-600.woff2`, `InstrumentSans-700.woff2` | Instrument Sans | 600, 700 | latin |
| `Inter-400.woff2`, `Inter-500.woff2`, `Inter-600.woff2` | Inter | 400, 500, 600 | latin |

Both families are published under the SIL Open Font License 1.1
(Instrument Sans: Rodrigo Fuenzalida / Google Fonts; Inter: Rasmus Andersson).
The files are the latin subsets as served by Google Fonts, unmodified.
