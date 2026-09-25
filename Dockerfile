FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM python:3.12-alpine@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31 AS package-guard-python

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# libffi is an Alpine system package (/usr/lib), not a Python package under
# /usr/local. Copy it from the pinned Python Alpine stage so restricted
# dependency-fetch builds do not need direct apk repository access.
COPY --from=package-guard-python /usr/lib/libffi.so.8 /usr/lib/libffi.so.8.2.0 /usr/lib/

COPY --from=package-guard-python /usr/local /usr/local
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# The npm cache goes, npm itself stays. Deleting npm/npx was meant as
# hardening -- an app that cannot install packages at runtime -- but AgentBox
# already governs runtime installs with package-guard, which is a stronger and
# far more visible control than removing the binary: it resolves the
# dependency tree, scans the real artifacts, checks advisories and either
# allows, denies, or holds for operator approval, and records every decision.
#
# Removing npm did not add to that; it subtracted. package-guard installs a
# shim for every supported tool regardless, and the shim directory is on PATH,
# so `npm install` still reached policy and then died deep in the resolver on
# a missing /usr/local/bin/npm.real. Fail-closed, but it meant this starter
# could not exercise npm policy at all -- and a DENY probe still went green,
# because a denylist hit short-circuits before the resolver ever needs npm: a
# false green over a probe that could never reach a verdict.
#
# The js-claude starter had this corrected; the two TypeScript starters were
# missed, so `POST /packages/install` could never have reached a real verdict
# here. Confirmed on this file as committed.
RUN npm install --omit=dev \
  && rm -rf /root/.npm
COPY --from=build /app/dist ./dist
# The browser console `src/server.ts` mounts at `/`. It is static, so it is
# copied into the RUNTIME stage rather than compiled -- and `dist/server.js`
# resolves it as `../ui`, which is this path.
COPY ui ./ui
# The concept: the prompt, the eight steps and their sentences, the sample
# data. Source, not a mount -- it is what this application IS.
COPY concept ./concept
# AgentBox ADOPTS the image's own uid rather than imposing one, and REFUSES an
# image that runs as root (`APP-UID`). An image with no `USER` runs as uid 0,
# so provisioning stops with *the image declares no USER, which means it runs
# as root*. Declaring a uid here is therefore not hardening advice -- it is the
# minimum an application must do to be adoptable, and this is the shape to copy.
#
# The home directory is load-bearing and must match `runtime_agentic_files` in
# `agentbox-config.yaml`: it is the second step of the HOME resolution order
# (`Config.Env`, then `/etc/passwd`, then REFUSE) and the directory the
# platform mounts this application's HOME volume onto. Changing one without
# the other puts the agent's state somewhere neither guard watches.
#
# Everything above this line runs as root on purpose -- the dependency install
# writes into system paths the application only ever reads.
RUN addgroup -g 10001 agent \
  && adduser -D -u 10001 -G agent -h /home/agent agent
USER 10001:10001

ENV PORT=8081
EXPOSE 8081
# Confirmed live 2026-08-28 on the Python starter's equivalent healthcheck
# (same gVisor sandbox every custom app runs under): a fresh interpreter
# process spawned per invocation pays real, repeated import/init overhead
# under gVisor's syscall interception -- near-zero CPU time, pure wait -- and
# a 3s timeout consistently flapped a perfectly healthy app to "unhealthy"
# every ~10s. Node's `fetch` pulls in the whole undici/http stack on every
# cold invocation, which is exactly the cost to avoid; `net.connect` skips it
# and a generous timeout absorbs whatever gVisor overhead remains.
HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('net').createConnection({host:'127.0.0.1',port:8081,timeout:8000}).on('connect',function(){this.end();process.exit(0)}).on('error',function(){process.exit(1)}).on('timeout',function(){process.exit(1)})"
CMD ["node", "dist/server.js"]
