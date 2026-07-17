# lfl-terminal cheat sheet

One page to get fluent. Everything here runs locally; the only network traffic is
your own browser doing what you told it to, plus calls to the model endpoint YOU
configured (default `127.0.0.1:1238`).

## Open, close, move

| Action | How |
|---|---|
| Open / close | backtick (`) or Ctrl+K, or the toolbar button. Esc closes. |
| Panel appears at your cursor | default behavior; press the hotkey near where you want it |
| Move it | drag the title bar |
| Keep it where you put it | `pin` (undo: `unpin`) |
| Resize | drag the top grip, or Ctrl+Up / Ctrl+Down |
| Collapse to a strip | click the title bar, or Ctrl+backtick |
| Old bottom-bar look | `config anchor dock` (back: `config anchor cursor`) |
| Middle-click to open | `config middleclick alt` (opt-in, Alt+middle-click) |

As you type, known command words light up in color. Lit first word = runs
deterministically, no model involved. Unlit = it will become ONE model proposal
that you approve or reject. The color is a hint, not a security control; the
same fixed checks run either way.

## Read the page

| Command | Does |
|---|---|
| `here` | where am I: origin, element counts, suggested next commands |
| `ls` / `ls links x` / `ls buttons` / `ls fields` | numbered map of the page (filter optional) |
| `read` | extract the main article text |
| `find <text>` | scroll to text; bare `find` jumps to the next match |
| `highlight <text>` | mark every occurrence; `highlight clear` removes |
| `matches` | numbered list of all current matches with context |
| `extract links` / `extract table` | dump visible links / first table as text |

## Act on the page

| Command | Does |
|---|---|
| `search "query"` | fill and submit the page's own search box |
| `open <text>` or `open <N>` | follow a link by visible text, or by its `ls` number |
| `click <N>` | click item N from the last `ls` |
| `fill <N> with <text>` / `fill <label> with <text>` | fill a field (credential fields are always refused) |
| `scroll up` / `scroll down`, `back` | what they say |

## Go places

| Command | Does |
|---|---|
| `go <url or domain>` | navigate anywhere; plain words fall back to the model resolving a destination |
| `open!` | confirm a pending cross-origin open |
| `origins` | list origins this tab visited this session |
| `autoopen` | auto-open the terminal on THIS site (per-origin opt-in) |

First visit to a new origin asks once. Cross-origin navigation proposed from
page content is always blocked; only you can take the terminal somewhere new.

## The AI lane

Type anything that is not a known command, or be explicit with `ask <...>`:

```
ask find the cheapest option on this page
```

The local model sees the page's element map and proposes ONE action from a fixed
set (click / fill / select / navigate / scroll / extract / answer / abort). You
get an approval card: Enter approves, Esc rejects. Mutating actions never run
without that approval, and hard blocks (credentials, cross-origin, non-http)
apply even to approved proposals. `budget` shows your remaining call/action
allowance; `continue` resumes after a rate-limit pause. `log` shows the session's
audit trail.

## Shortcuts you define

```
alias wiki = go en.wikipedia.org        # one command, one name
macro morning = go news.ycombinator.com && read   # up to 5 steps, one line
```
`unalias <name>` / `unmacro <name>` to remove. Names share one namespace with
scripts: one name, one thing.

## Scripts (multi-step, parameterized)

```
script new lookup          # opens a line-by-line editor, # comments allowed
  go en.wikipedia.org
  search "$1"
  read
                           # blank line or Ctrl+Enter saves, Esc cancels
run lookup "terminal emulator"
```

Rules the editor enforces:
- Up to 20 steps; params `$1`..`$9` and `$@`; values are substituted as opaque
  text and can never add new steps.
- Every step must start with a known command. Index-addressed steps (`click 4`,
  `open 3`, `fill 2 with ...`) are rejected at save time because the numbers go
  stale between visits; use `pause "click the right result"` instead, which
  stops the script, hands you control, and resumes when you type `continue`.
- `run <name>` always shows the fully substituted plan first; one Enter runs it.
- `script export <name>` / `script export --all` writes a plain-text
  `.lflscript` file; `script import` re-validates every step on the way in.
  Share them; imported files get the same checks as typed ones.

`script ls` / `script show <name>` / `script rm <name>` manage them.

## teach - the model writes the script, you approve it

Opt-in, off by default:

```
teach on
teach look up a topic on wikipedia and open the best article as wikilookup
```

The model drafts a script body from your goal sentence (your typed words are the
ONLY thing it sees - never page content). The draft goes through exactly the
same validator as a hand-typed script, then an approval card shows every step;
Enter saves it as `wikilookup`, Esc discards. Then `run wikilookup` like any
script. `teach off` disables the lane again.

Tips that make drafts land on the first try:
- Name the destination explicitly: "go to en.wikipedia.org and ..." beats
  "look up ...". The model writes better `go` steps when you say where.
- Small goals draft better than long ones; chain two scripts rather than
  teaching one giant workflow.
- If a draft step needs a click-by-number, expect the validator to push it to a
  `pause` - that is by design, not a failure.
- `... as <name>` at the end names the script; otherwise you are asked.

## Memory - let it learn your habits (opt-in, off by default)

The terminal can remember which COMMANDS you use on which SITES, so `teach` can
offer to turn a routine into a script. It records verbs and site origins only:
never what you typed into a search box or form, never page content, never full
URLs. Off until you turn it on.

```
memory on              # start remembering (off by default)
memory show            # see exactly what it knows - plain text, nothing hidden
memory forget <site>   # drop one site's record
memory clear           # wipe everything
memory off             # stop; memory quiet / memory loud toggles the nudges
```

When it notices you repeat a sequence on a site, it prints one line:
`you've run "go, search, read" here 3 times - type "teach save that" to make it a script`.
Then `teach save that` (needs `teach on` too) drafts a script from that pattern -
the drafting model sees only your verbs-and-counts summary, never any page, and
the draft still goes through the same approval card as any teach. Nothing about
this memory is ever sent anywhere except your own model when you ask it to draft.

## Looks and toys

`theme` lists themes (`default`, `phosphor`, `amber`, `paper`). `snake`, `2048`,
`games` (arrows to play, q or Esc to quit), `cowsay <text>`, `fortune`, `stats`,
and one more the help list will not admit to.

## What it will never do

No shell, no sudo, no local files. No credentials through the model, ever
(password/OTP fields are refused in code, not by policy). The model never picks
from an open-ended action space, only the fixed set above, and every mutating
step waits for your Enter. Full details: `docs/threat-model.md`.

## When something is off

- "local model offline": your endpoint on `127.0.0.1:1238` is not answering -
  start your model server (or bridge) and retry. Deterministic commands keep
  working without it.
- "rate-limit check unavailable ... blocked for safety" right after an
  extension update: reload the extension at `chrome://extensions` FIRST, then
  refresh the page. That order.
- A command "does nothing" on a weird page: `here` first; the page may render
  its controls in ways the map cannot see (canvas, cross-origin frames).
- `man <cmd>` gives detailed usage for any command; `help` lists everything.
