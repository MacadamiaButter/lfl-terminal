# Chrome Web Store listing - lfl-terminal

Draft copy for the Web Store dashboard. Paste these into the matching fields.
Nothing here is auto-published; it is a working draft for the human submitter.

---

## Product name
lfl-terminal

## Summary (max 132 chars, shown under the name)
Browser terminal with deterministic commands and a local LLM that proposes page actions you approve. Nothing leaves your machine.

## Category
Developer Tools

## Language
English

---

## Detailed description (paste into "Description")

lfl-terminal is a keyboard-first terminal that lives in your browser. Press the
backtick key on any page and a terminal overlay slides up. Type deterministic
commands to read, search, navigate, and act on the page - and for anything that
needs interpretation, a LOCAL AI model (one you run yourself) proposes a single
action that you approve or reject before it ever touches the page.

The whole point is local-first, human-supervised control:

- Nothing leaves your machine. Deterministic commands run entirely in your
  browser. The AI half talks only to a local model on your own computer
  (loopback, 127.0.0.1). There are no accounts, no servers, no telemetry.
- The model proposes; you decide. Any action that changes the page (click,
  fill, navigate) is shown to you as a plain, deterministic summary and waits
  for your explicit approval. Read-only commands run without a gate.
- The model is never a security boundary. Approval, the fixed set of allowed
  actions, and the hard blocks (for example, credential fields are never
  auto-filled) are enforced by the extension's own code, not by the model.

What you can do:

- Navigate and act: go, open, back, click, fill, search, scroll
- Read and orient: read, ls, extract links/table, here
- Find and highlight: find, highlight (mark every match on the page), matches
  (list them with context)
- Make it yours: alias, macro, themes, per-site auto-open, a resizable and
  collapsible panel
- Ask the local model: prefix a request with "ask" (or just type a plain
  request) and approve the single action it proposes

Requirements (please read before installing):

- You need a local, OpenAI-compatible model server running at
  http://127.0.0.1:1238 (for example llama.cpp's llama-server, LM Studio, or
  Ollama behind a compatible endpoint). The deterministic commands work without
  it; the AI proposals need it.
- Chrome only, for now.

What it will NOT do (on purpose):

- It will not run shell commands, touch your filesystem, or use sudo. Ever.
- It will not send your page content or commands to any cloud service or to us.
- It will not act on a page without your approval for anything that mutates it.

Open source (Apache-2.0). Source, threat model, and issues:
https://github.com/MacadamiaButter/lfl-terminal

---

## Privacy practices tab

### Single purpose (required statement)
A single-purpose terminal overlay for the browser: it lets a user run
deterministic commands against the current web page and approve individual
page actions proposed by a local AI model. Everything runs locally.

### Permission justifications

- storage: Saves the user's own preferences (themes, aliases, macros, panel
  size, per-site auto-open) and recent command history locally on their device.
- Host permission http://127.0.0.1:1238/*: Connects only to a local AI model
  the user runs on their own machine (loopback). This is the extension's AI
  lane; no remote server is contacted.
- Content scripts / access to all sites (<all_urls>): The terminal is a general
  tool that must be able to open on, read, and (only after explicit user
  approval) act on whatever page the user is currently viewing. It activates on
  user action (a keypress) and does not run in the background collecting data.

### Data usage disclosures (check on the form)
- Does NOT collect or use personal or sensitive user data.
- Does NOT sell or transfer user data to third parties.
- Does NOT use data for purposes unrelated to the item's single purpose.
- Does NOT use or transfer data for creditworthiness or lending.

### Privacy policy URL
https://localfirstlab.org/lfl-terminal-privacy.html   (dedicated EXTENSION policy, deployed and live - the site's own /privacy.html is a separate document and does not cover the extension)

---

## Assets checklist
- Store icon 128x128: docs/store/icon-128-preview.png (from extension/icons/icon128.png)
- Screenshot 1 (1280x800): docs/store/screenshot-1-1280x800.png  [starter - retake fresher ones showing highlight/matches/collapse]
- Recommended: 2-4 more screenshots showing highlight + matches, the resizable panel, and a proposal/approve card. Capture at 1280x800.
- Optional: small promo tile 440x280.
