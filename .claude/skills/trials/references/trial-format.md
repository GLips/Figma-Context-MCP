# Trial file format

One markdown file per trial in [`definitions/`](../definitions/). The file name is the trial name.

```markdown
---
surface: edit # create | read | edit | component | cross-session
needs: pricing-page # optional — work on the page the newest built run of that trial made
page: Messy checkout # optional — work on a page a designer made by hand
blocked: fig-46 # optional — `run` refuses until this is removed
---

## Brief

The prompt, written as a user would type it. No tool names, no flcm, no hints.

## Follow-up

Optional second prompt, sent to the same session after the first turn settles.
Same rules. This is how a same-session edit trial works: build, then change.

## Rubric

Optional. What Graham judges a craft run against. Three or four bullets.
```

A trial has no track of its own: every run is ergo unless invoked with `--craft`.

## Placeholders

The runner substitutes these in Brief and Follow-up; an unresolved one fails the run before anything spawns.

| Placeholder | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| `{page}`    | the new page this run creates — `<trial> <YYYY-MM-DD HH:mm>` |
| `{source}`  | the page named by `needs:` or `page:`                        |
| `{file}`    | `figmaFileUrl` from the repo's `trials/config.json`          |
| `{renders}` | the renders directory under the scratch dir, for HTML output |

## Writing the brief

- What a normal user types. Say where the work goes ("on a new page named {page}") and nothing about how.
- Write it so it also works as a craft brief — audience, content, tone. The runner appends the craft framing (best work, iterate, two or three variations) on `--craft`; don't repeat it.
- A read or edit trial names its target page through `{source}`, never by hand.
- `needs:` points at a trial whose runs _build_ something. If no built run exists, `run` says so and stops.
