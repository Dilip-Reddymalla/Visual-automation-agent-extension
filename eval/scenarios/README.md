# Agent scenarios

    python eval/scenarios.py                 # every scenario
    python eval/scenarios.py --only shop-*   # a subset
    python eval/scenarios.py --headed        # watch it work

A real Google Chrome, the built extension loaded unpacked, and a goal that the agent runs
to its own conclusion. This is the other half of `eval/harness.py`: the harness measures
one perception cycle per corpus page and scores it against hand-made labels; this
measures whether the agent can actually finish a task.

## What makes a scenario pass

Three independent kinds of evidence, and all three have to agree:

| evidence | where it comes from |
| --- | --- |
| what the agent believes | its progress ledger and decomposition, read out of `chrome.storage.session` |
| what the page says | JS assertions evaluated in the tab after the run |
| what it looked like | a screenshot per checkpoint |

The screenshots are last on that list on purpose. A picture is not proof; it is what a
person looks at once the structured checks have already said something is wrong. No pass
condition is a screenshot.

Each scenario writes `eval/report/scenarios/<id>/scenario.json` with the goal, every step
and its outcome, the plan's legs and their statuses, the page checks, the checkpoints and
their screenshots, and `posted` -- what actually crossed the network, minus the image
bytes. The suite summary is `eval/report/scenarios.json`.

## The fixtures

`pages/` holds static HTML with no network calls, no timers and no randomness, served over
loopback (`file://` gets no content script -- see `runner/serve.py`). Each one exists for a
specific failure mode:

| page | what it is for |
| --- | --- |
| `shop.html` | a search that filters in place, and a grid of priced cards to choose between |
| `item.html` | a product page whose "Add to cart" navigates, so a step transition is real |
| `cart.html` | a mock cart. The run stops here |
| `form.html` | an ordinary form with a status line that is in the DOM before it is shown |
| `stubborn.html` | controls that do nothing. The correct outcome is a run that notices |
| `shifting.html` | a control that removes itself, so a stale element reference cannot survive |
| `privacy.html` | everything the gate must remove, in both the forms it has to handle |

## The planner

`runner/scripted.py` -- a grammar over the element list and the decomposition the device
sent. No GPU, no weights, no network. A suite whose planner varied between runs could not
be a regression test: every failure would have to be re-run to find out whether it was the
extension or the weather.

It sees exactly what the shipped planner sees, and nothing else.

## What this suite will not do

No purchases, no payments, no account creation, no password or card entry, and no
production websites. The shop fixture ends at a mock cart page, and the scripted planner
refuses to type into anything named like a secret -- which the extension would refuse
anyway (CLAUDE.md invariant 6), so a harness that tried would be testing the refusal
rather than the flow.

## Groups

1. **navigation and search** -- find a search control, enter a query, verify the result state.
2. **multi-step interaction** -- several pages or states, a candidate chosen under a
   constraint, a safe final action, and a verified completion.
3. **failure recovery** -- a page that does nothing, and a page that rearranges itself
   under the agent.
4. **privacy** -- a password field, printed identifiers, and an image region; nothing the
   page holds may appear in any artefact.
