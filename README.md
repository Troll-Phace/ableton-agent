# ableton-claude-agent

An Ableton Live extension built with `@ableton-extensions/sdk`. The current implementation uses Claude; the approved next
phase is [Sign in with ChatGPT](docs/CHATGPT_MIGRATION.md). Migration is planned,
not yet implemented.

## Get Started

Learn about building extensions: https://ableton.github.io/extensions-sdk/

## Setup

Obtain the pinned Ableton Extensions SDK and CLI version `1.0.0-beta.0` from
[Ableton’s official SDK resources](https://ableton.github.io/extensions-sdk/) under
Ableton’s terms. Place the two original package archives in the local
`vendor/` directory as `ableton-extensions-sdk-1.0.0-beta.0.tgz` and
`ableton-extensions-cli-1.0.0-beta.0.tgz`, then run `npm ci`. These archives
are intentionally not distributed with the project source.

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

## License

Project-authored source and documentation are available under the [MIT License](LICENSE).
The separately obtained Ableton SDK and CLI, other third-party dependencies,
and trademarks remain subject to their respective owners’ terms; they are not
relicensed by this project.
