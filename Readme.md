# [MQTT Explorer](https://mqtt-explorer.com)

[![Downloads](https://img.shields.io/github/release/thomasnordquist/mqtt-explorer.svg)](https://travis-ci.org/thomasnordquist/MQTT-Explorer/releases)
[![Downloads](https://img.shields.io/github/downloads/thomasnordquist/mqtt-explorer/total.svg)](https://travis-ci.org/thomasnordquist/MQTT-Explorer/releases)
[![Build_Status](https://travis-ci.org/thomasnordquist/MQTT-Explorer.svg?branch=master)](https://travis-ci.org/thomasnordquist/MQTT-Explorer)
[![Build status](https://ci.appveyor.com/api/projects/status/c35tkm29rm4m5364/branch/master?svg=true)](https://ci.appveyor.com/project/thomasnordquist/mqtt-explorer/branch/master)
[![Codacy Badge](https://api.codacy.com/project/badge/Grade/47b26e03fce543ceac7914214482334a)](https://app.codacy.com/app/thomasnordquist/MQTT-Explorer?utm_source=github.com&utm_medium=referral&utm_content=thomasnordquist/MQTT-Explorer&utm_campaign=Badge_Grade_Dashboard)

|                                                                                                                                     |                                                                                                                |                                                                                                                |
| :---------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------: |
| [![screen_composite](https://mqtt-explorer.com/img/screen-composite_small.png)](https://mqtt-explorer.com/img/screen-composite.png) | [![screen2_small](https://mqtt-explorer.com/img/screen2_small.png)](https://mqtt-explorer.com/img/screen2.png) | [![screen3_small](https://mqtt-explorer.com/img/screen3_small.png)](https://mqtt-explorer.com/img/screen3.png) |

# The App has moved to [mqtt-explorer.com](https://mqtt-explorer.com)

MQTT Explorer is a comprehensive and easy-to-use MQTT Client.  
Downloads can be found at the link above.

This page is dedicated to its development.
Pull-Requests and error reports are welcome.

## Sparkplug B fork

This public fork adds birth-aware Sparkplug B inspection to MQTT Explorer.
Original authorship, attribution, donation links and license remain unchanged.
Upstream downloads do not include these changes; build this fork from source.

Connect normally and subscribe to `spBv1.0/#` **before** the publisher sends
NBIRTH/DBIRTH. Select an NDATA/DDATA topic to see named, typed metric values
instead of unresolved numeric aliases. Commands use the same birth context.
Aliases are scoped by connection, group, node and device. A node rebirth clears
its device definitions; death messages and broker disconnects invalidate context.
Stale NDEATH messages with a different `bdSeq` do not invalidate a newer birth.

Decoded JSON includes `type`, `value` and a `sparkplug` object containing
message identity, lifecycle status at receipt and warnings. Original wire fields,
timestamps, metadata and properties remain visible. All 64-bit integers are
decimal strings, including aliases and timestamps, to avoid precision loss.
Datasets and inline template metrics are decoded; binary/file values use base64.
Payload bytes remain unchanged, and history keeps the context captured at receipt,
even while the tree is paused or after alias reuse.

Missing births, unknown aliases, duplicate mappings and unsupported values produce
visible warnings; names are never guessed. If connected after birth, wait for the
publisher's next birth or request rebirth using your existing tooling. This fork
does not automatically publish rebirth commands, expand shared template definitions,
unpack typed-array/compressed payloads, or implement a full Sparkplug host.
Unsupported wire fields remain available for inspection.

Run the focused checks from `app`:

```bash
yarn mocha --require tsx --require source-map-support/register src/decoders/SparkplugBDecoder.spec.ts
```

For independent Python-to-browser E2E checks, install
[`pysparkplug`](https://pypi.org/project/pysparkplug/) into your Python environment.
Mosquitto must be on PATH, and Playwright needs Chromium (or an installed Edge/Chrome).
From the repository root:

```bash
python -m pip install -r scripts/requirements-sparkplug.txt
yarn build:server
yarn playwright install chromium
python scripts/sparkplug-e2e.py | yarn --silent test:sparkplug-e2e
```

Set `MOSQUITTO` to a broker executable path if needed. Set `PLAYWRIGHT_CHANNEL`
to `msedge` or `chrome` to use an installed browser instead of downloading Chromium.
The runner starts an isolated broker and app server, connects through the browser,
and cleans up its own processes/settings. Python independently encodes payloads;
the runner publishes those bytes unchanged over MQTT and checks rendered values:
missing birth warnings, alias zero, omitted datatypes, exact maximum UInt64,
alias reuse after rebirth, device death and post-death invalidation.

## Quick Start with GitHub Codespaces

The fastest way to start developing is with GitHub Codespaces:

1. Click the green "Code" button above
2. Select "Codespaces" tab
3. Click "Create codespace on [branch]"
4. Wait for the environment to set up (includes Node.js and MQTT broker)
5. Run `yarn dev:server` to start development

The devcontainer includes a pre-configured MQTT broker and all development tools. See [.devcontainer/README.md](.devcontainer/README.md) for details.

## Run from sources

### Desktop Application (Electron)

```bash
npm install -g yarn
yarn
yarn build
yarn start
```

### Browser Mode (Web Application)

MQTT Explorer can also run as a web application served by a Node.js server:

```bash
npm install -g yarn
yarn
yarn build:server
yarn start:server
```

Then open your browser to `http://localhost:3000`. For more details, see [BROWSER_MODE.md](BROWSER_MODE.md).

### Docker (Browser Mode)

[![Try in PWD](https://raw.githubusercontent.com/play-with-docker/stacks/master/assets/images/button.png)](https://labs.play-with-docker.com/?stack=https://raw.githubusercontent.com/thomasnordquist/MQTT-Explorer/master/docker-compose.yml)

Run MQTT Explorer in a Docker container:

```bash
docker run -d \
  -p 3000:3000 \
  -e MQTT_EXPLORER_USERNAME=admin \
  -e MQTT_EXPLORER_PASSWORD=your_secure_password \
  -v mqtt-explorer-data:/app/data \
  ghcr.io/thomasnordquist/mqtt-explorer:latest
```

**Supports multiple platforms**: amd64, arm64 (Raspberry Pi 3/4/5), arm/v7 (Raspberry Pi 2/3).

**Enterprise integration**: Set `MQTT_EXPLORER_SKIP_AUTH=true` to disable built-in authentication when deploying behind a secure authentication proxy (e.g., OAuth2 Proxy, SSO).

For complete Docker documentation including authentication options, deployment examples, and security best practices, see [DOCKER.md](DOCKER.md).

## Develop

### Desktop Application

Launch Application

```bash
npm install -g yarn
yarn
yarn dev
```

### Browser Mode

Launch in development mode with hot reload:

```bash
npm install -g yarn
yarn
yarn dev:server
```

The `app` directory contains all the rendering logic, the `backend` directory currently contains the models, tests, connection management, `src` contains all the electron bindings. [mqttjs](https://github.com/mqttjs/MQTT.js) is used to facilitate communication to MQTT brokers.

For information on styling conventions and visual design patterns, see [STYLING.md](STYLING.md).

## Automated Tests

MQTT Explorer uses multiple test suites to ensure reliability and quality:

### Unit Tests

**App tests** - Frontend component and logic tests:
```bash
yarn test:app
```

**Backend tests** - Data model and business logic tests:
```bash
yarn test:backend
```

**Run all unit tests**:
```bash
yarn test
```

### LLM Testing

The AI Assistant feature includes comprehensive tests to validate proposal quality and LLM integration.

**Offline tests** (default - no API key needed):
```bash
yarn test:app
```

**Live LLM integration tests** (requires API key):
```bash
# Set your API key
export OPENAI_API_KEY=sk-your-key-here
# Or use Gemini
export GEMINI_API_KEY=your-key-here

# Opt-in to live tests
export RUN_LLM_TESTS=true

# Run tests
yarn test:app
```

For detailed LLM testing documentation, see [app/src/services/spec/README.md](app/src/services/spec/README.md).

### Integration & UI Tests

**UI test suite** - Independent, deterministic browser tests:
```bash
yarn build
yarn test:ui
```

**Demo video generation** - UI test recording for documentation:
```bash
yarn build
yarn test:demo-video
```
Note: Requires Xvfb, mosquitto broker, tmux, and ffmpeg. For full video recording setup, use `./scripts/uiTests.sh`.

**MCP introspection tests** - Model Context Protocol validation:
```bash
yarn build
yarn test:mcp
```

**Run all tests** (unit tests + demo video):
```bash
yarn build
yarn test:all
```

### Run UI Test Suite

The UI test suite validates core functionality through automated browser tests. Each test is independent and deterministic.

```bash
# Run with automated setup (recommended)
./scripts/runUiTests.sh

# Or run directly (requires manual MQTT broker setup)
yarn build
yarn test:ui
```

See [docs/UI-TEST-SUITE.md](docs/UI-TEST-SUITE.md) for more details.

### Run Demo Video Generation

The demo video is used for documentation and showcases key features. It requires additional dependencies:

```bash
yarn build
yarn test:demo-video
```

**Requirements:**
- mosquitto MQTT broker
- Xvfb (virtual framebuffer)
- tmux (terminal multiplexer)
- ffmpeg (video encoding)

**For full video recording with post-processing:**
```bash
yarn build
./scripts/uiTests.sh
```

This script handles Xvfb setup, mosquitto startup, video recording, and cleanup.

### Mobile Demo Video

A mobile-focused demo video showcases MQTT Explorer in a mobile viewport (Pixel 6: 412x915px):

```bash
yarn build
yarn test:demo-video:mobile
```

Or with full recording setup:
```bash
yarn build
./scripts/uiTestsMobile.sh
```

This demonstrates the mobile compatibility features and responsive design improvements. See [MOBILE_COMPATIBILITY.md](MOBILE_COMPATIBILITY.md) for the mobile strategy and implementation details.

## Mobile Compatibility

MQTT Explorer supports mobile devices through its browser mode with responsive design enhancements:

- **Target Device**: Google Pixel 6 (412x915px viewport)
- **Touch-Friendly UI**: Minimum 44px tap targets for better mobile UX
- **Responsive Layout**: Sidebar and panels adapt to mobile viewports
- **Browser Mode**: Access via mobile browser or install as PWA

For the complete mobile compatibility concept, implementation phases, and future roadmap, see [MOBILE_COMPATIBILITY.md](MOBILE_COMPATIBILITY.md).

## Create a release

Create a PR to `release` branch.
There needs to be a "feat: some new feature" or "fix: some bugfix" commit for a new release to be created

### macOS Notarization

macOS builds are automatically notarized during the release process. To set up notarization credentials, see [NOTARIZATION.md](NOTARIZATION.md).

## Create a beta release

Create a PR to `beta` branch. A "feat" or "fix" commit is necessary to create a new version.

## Write docs

```
git clone --single-branch -b gh-pages https://github.com/thomasnordquist/MQTT-Explorer.git mqtt-explorer-pages
cd mqtt-explorer-pages
bundle install
bundle exec jekyll serve --incremental
```

Readme file: `Readme.tpl.md`

Preview is available at
http://localhost:4000/Readme.tpl

## Update docs

```
npm install
./updateReadme.ts
```

The readme will be generated from the docs.

## License

![CC BY-SA 4.0](https://img.shields.io/badge/License-CC%20BY--SA%204.0-blue.svg)  
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

**Special requirement:** When distributing, the attribution and donation page may not be altered or made less accessible without explicit approval.

The license allows for anyone to adapt, share, and redistribute the material, as long as they give appropriate credit and distribute any derivative works under the same license.
