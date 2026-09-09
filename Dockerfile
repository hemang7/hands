FROM node:22-slim

# curl is used by the make-evidence.sh health-check loop that waits for
# the target app to be ready. The Playwright --with-deps flag below will
# pull everything Chromium needs, but we install curl separately first.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies before copying source so Docker can cache
# this layer independently of code changes.
COPY package.json package-lock.json ./
RUN npm ci

# Install the Playwright-managed Chromium browser and all of its system
# library dependencies inside the image. PLAYWRIGHT_BROWSERS_PATH tells
# Playwright where to put the browser at install time and where to find
# it at runtime—no HANDS_CHROMIUM_PATH override needed.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium

COPY . .

# Default credentials for the mock banking app. These match the values
# in .env.example and contain no real data. Override at runtime with
# -e LEGACYCORE_USER=... if needed.
ENV LEGACYCORE_USER=teller1 \
    LEGACYCORE_PASSWORD=teller1-pass

# Offline demo by default: scripted decider, no API key required.
# To run real model-driven discovery, override the command:
#   docker compose run hands npm run evidence
CMD ["npm", "run", "demo:offline"]
