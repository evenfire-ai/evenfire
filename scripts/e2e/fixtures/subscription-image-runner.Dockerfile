# E2E-only image. The build context is an explicitly staged source/lock closure,
# never the repository root. Main reviews the digest-pinned Linux base first.
#
# The base reference comes from subscription-image-runner.base-image and is
# bound into the sealed main admission, so a changed base record cannot be used
# with a stale admission. The pinned Debian base does not ship sfw; main either
# provides a reviewed base that does or approves the documented sfw staging
# path. The apt package names below are self-verified by the command and ldd
# checks: a missing package or a renamed Debian package fails the build loudly.
ARG RUNNER_BASE_IMAGE
FROM ${RUNNER_BASE_IMAGE} AS build
USER 0:0
WORKDIR /opt/evenfire
# Reviewed SocketDev/sfw-free binary staged by the host admission writer. It is
# a third-party artifact with its own receipt and hash binding, never part of
# the Git source manifest, and it is the only sfw in the image.
COPY third-party/sfw-free /usr/local/bin/sfw
RUN chmod 0755 /usr/local/bin/sfw \
    && node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)" \
    && command -v apt-get && command -v sfw
RUN sfw apt-get update && sfw apt-get install -y --no-install-recommends \
      ca-certificates git python3 make g++ pkg-config libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

# packages/ contains only the package/lock dependency closure plus the existing
# image codec/padding source. Exclude environment, personal config and logs.
COPY packages/ ./packages/
COPY desktop-app/package.json desktop-app/package-lock.json ./desktop-app/
COPY mcp-host/package.json mcp-host/package-lock.json ./mcp-host/
RUN sfw npm ci --prefix desktop-app --userconfig=/dev/null --globalconfig=/dev/null \
    && sfw npm ci --prefix mcp-host --omit=dev --userconfig=/dev/null --globalconfig=/dev/null
COPY desktop-app/src/ ./desktop-app/src/
COPY desktop-app/ui/ ./desktop-app/ui/
COPY desktop-app/assets/ ./desktop-app/assets/
COPY desktop-app/renderer/ ./desktop-app/renderer/
COPY desktop-app/tsconfig.json ./desktop-app/tsconfig.json
COPY desktop-app/scripts/verify-electron-runtime.mjs ./desktop-app/scripts/verify-electron-runtime.mjs
COPY scripts/tests/lib/subscription-image-runner-contract.mjs \
     scripts/tests/lib/subscription-image-source-context.mjs ./scripts/tests/lib/
COPY desktop-app/test/e2e-playwright/ ./desktop-app/test/e2e-playwright/
COPY scripts/e2e/run-subscription-image-journeys.mjs ./scripts/e2e/run-subscription-image-journeys.mjs
COPY scripts/e2e/prepare-subscription-remaining-fixtures.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.gfs.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.runtime.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.prepare.mjs ./scripts/e2e/
COPY scripts/e2e/fixtures/ ./scripts/e2e/fixtures/
COPY subscription-image-input-source.json ./subscription-image-input-source.json
# Compile-time UI feature flags come from the admitted suite contract. The
# default false keeps every other suite on the unmodified UI.
ARG VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM=false
ENV VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM=${VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM}
# Recheck the actual allowlisted input around compilation. HEAD/tree/blob IDs
# were observed by main from the clean checkout, never synthesized in the image.
RUN node --input-type=module -e "import fs from 'node:fs'; import {verifyInputSource} from './scripts/tests/lib/subscription-image-source-context.mjs'; verifyInputSource(JSON.parse(fs.readFileSync('subscription-image-input-source.json')), process.cwd())" \
    && npm --prefix desktop-app run verify:electron && npm --prefix desktop-app run build \
    && node --input-type=module -e "import fs from 'node:fs'; import {verifyInputSource} from './scripts/tests/lib/subscription-image-source-context.mjs'; verifyInputSource(JSON.parse(fs.readFileSync('subscription-image-input-source.json')), process.cwd())"

FROM ${RUNNER_BASE_IMAGE} AS runner
USER 0:0
WORKDIR /opt/evenfire
COPY third-party/sfw-free /usr/local/bin/sfw
# Runtime X/dbus/keyring and Electron shared libraries. ca-certificates is
# required because node:*-slim purges it after fetching Node.
RUN chmod 0755 /usr/local/bin/sfw \
    && sfw apt-get update && sfw apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth dbus gnome-keyring libsecret-1-0 \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libgtk-3-0 \
      libx11-xcb1 libxcb-dri3-0 libxshmfence1 fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)" \
    && command -v Xvfb && command -v xauth && command -v dbus-daemon \
    && command -v gnome-keyring-daemon
RUN test ! -e /home/evenfire-e2e \
    && groupadd --gid 10001 evenfire-e2e \
    && useradd --uid 10001 --gid 10001 --home-dir /home/evenfire-e2e --create-home evenfire-e2e \
    && chmod 0700 /home/evenfire-e2e \
    && mkdir -p /run/evenfire-e2e /runner-admission \
    && chown 10001:10001 /run/evenfire-e2e /runner-admission \
    && chmod 0700 /run/evenfire-e2e /runner-admission
COPY --from=build /opt/evenfire/packages/ ./packages/
COPY --from=build /opt/evenfire/desktop-app/node_modules/ ./desktop-app/node_modules/
COPY --from=build /opt/evenfire/desktop-app/dist/ ./desktop-app/dist/
COPY --from=build /opt/evenfire/desktop-app/ui-dist/ ./desktop-app/ui-dist/
COPY --from=build /opt/evenfire/desktop-app/assets/ ./desktop-app/assets/
COPY --from=build /opt/evenfire/desktop-app/renderer/ ./desktop-app/renderer/
COPY --from=build /opt/evenfire/desktop-app/package.json /opt/evenfire/desktop-app/package-lock.json ./desktop-app/
COPY --from=build /opt/evenfire/mcp-host/node_modules/ ./mcp-host/node_modules/
COPY --from=build /opt/evenfire/mcp-host/package.json /opt/evenfire/mcp-host/package-lock.json ./mcp-host/
RUN ldd desktop-app/node_modules/electron/dist/electron > /tmp/electron-ldd.txt 2>&1 \
    && ! grep -q 'not found' /tmp/electron-ldd.txt \
    && rm -f /tmp/electron-ldd.txt
COPY desktop-app/test/e2e-playwright/subscription-image-input.spec.ts \
     desktop-app/test/e2e-playwright/playwright.subscription-image.config.ts \
     desktop-app/test/e2e-playwright/subscriptionImageFixtures.ts \
     desktop-app/test/e2e-playwright/subscriptionImageRunContract.ts \
     desktop-app/test/e2e-playwright/subscriptionImageChallenge.ts \
     desktop-app/test/e2e-playwright/codexImageChallenge.ts \
     desktop-app/test/e2e-playwright/subscription-tool-screenshot.spec.ts \
     desktop-app/test/e2e-playwright/subscription-gfs-image.spec.ts \
     desktop-app/test/e2e-playwright/subscription-admission-recovery.spec.ts \
     desktop-app/test/e2e-playwright/playwright.subscription-tool-screenshot.config.ts \
     desktop-app/test/e2e-playwright/playwright.subscription-gfs-image.config.ts \
     desktop-app/test/e2e-playwright/playwright.subscription-admission-recovery.config.ts \
     desktop-app/test/e2e-playwright/subscriptionRemainingJourneyConfig.ts \
     desktop-app/test/e2e-playwright/subscriptionRemainingJourneyData.ts \
     desktop-app/test/e2e-playwright/subscriptionRemainingJourneyUi.ts \
     desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts \
     desktop-app/test/e2e-playwright/navigationHelpers.ts ./desktop-app/test/e2e-playwright/
COPY scripts/e2e/run-subscription-image-journeys.mjs ./scripts/e2e/run-subscription-image-journeys.mjs
COPY scripts/e2e/prepare-subscription-remaining-fixtures.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.gfs.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.runtime.mjs \
     scripts/e2e/prepare-subscription-remaining-fixtures.prepare.mjs ./scripts/e2e/
COPY scripts/e2e/fixtures/subscription-image-provider.mjs \
     scripts/e2e/fixtures/subscription-image-challenge.cjs \
     scripts/e2e/fixtures/subscription-image-decoder.mjs \
     scripts/e2e/fixtures/subscription-image-session.mjs \
     scripts/e2e/fixtures/subscription-image-admission-pressure.mjs \
     scripts/e2e/fixtures/subscription-image-runner.base-image ./scripts/e2e/fixtures/
COPY scripts/tests/lib/subscription-image-runner-contract.mjs \
     scripts/tests/lib/subscription-image-source-context.mjs ./scripts/tests/lib/
COPY subscription-image-input-source.json ./subscription-image-input-source.json
# Exported public source is private on the host; the sealed nonroot image must read it.
RUN chmod -R a+rX /opt/evenfire
RUN node --input-type=module -e "import {sealSourceManifest} from './scripts/e2e/run-subscription-image-journeys.mjs'; sealSourceManifest(process.cwd())" \
    && chown root:root desktop-app/node_modules/electron/dist/chrome-sandbox \
    && chmod 4755 desktop-app/node_modules/electron/dist/chrome-sandbox
ENV HOME=/home/evenfire-e2e USER=evenfire-e2e LOGNAME=evenfire-e2e
USER 10001:10001
ENTRYPOINT ["node", "/opt/evenfire/scripts/e2e/run-subscription-image-journeys.mjs"]
# A default container cannot launch, authenticate, inspect personal state or
# activate an external fixture. Reviewed physical admission is mandatory.
CMD ["bootstrap", "/runner-admission/main-admission.json"]
