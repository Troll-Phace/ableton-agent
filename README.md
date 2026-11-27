# ableton-claude-agent

An Ableton Live extension built with `@ableton-extensions/sdk`. The current implementation uses Claude; the approved next
phase is [Sign in with ChatGPT](docs/CHATGPT_MIGRATION.md). Migration is planned,
not yet implemented.

## Get Started

Learn about building extensions: https://ableton.github.io/extensions-sdk/

## Setup

The path to Ableton Live's Extension Host module is stored in `.env` as
`EXTENSION_HOST_PATH`. The generator filled this in for you; edit it if your
install moves.

## Scripts

```sh
npm start                  # build + run in Live's Extension Host
npm run build              # production bundle of src/extension.ts
npm run build:dev          # dev bundle (sourcemaps, not minified)
npm run package            # build for production + create a .ablx archive
```
