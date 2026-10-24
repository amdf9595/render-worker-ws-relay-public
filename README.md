# Private Worker WebSocket Relay

A small WebSocket-to-WebSocket bridge for one fixed upstream hostname and up to six explicitly configured upstream paths. It does not implement VLESS, accept arbitrary destination URLs, or act as an open HTTP/SOCKS proxy; it forwards the client's WebSocket frames unchanged to the configured upstream Worker.

## Safe first deploy

The app starts with the relay disabled unless `ENABLE_RELAY=true`. In the disabled state, `/health` returns `ok`, while all WebSocket upgrades receive HTTP 503. This makes it possible to test whether the Render hostname is reachable before adding any connection secrets.

## Required Render environment variables to enable the relay

- `ENABLE_RELAY`: set to `true` only after preparing rotated credentials.
- `UPSTREAM_HOST`: hostname only, e.g. the user's own `*.workers.dev` host. Do not include a scheme or path.
- `RELAY_TOKEN`: random secret of at least 32 characters. Store it as a Render secret, not in source control.
- `UPSTREAM_PATH_1` through `UPSTREAM_PATH_6`: only the paths that the upstream expects. Store them as Render secrets; do not commit them.

The relay exposes `/relay/1` through `/relay/6` only for paths configured in the corresponding environment variables. It requires the incoming WebSocket request to include `X-Relay-Token: <RELAY_TOKEN>`. The public health endpoint reveals no configuration.

## Render settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Plan: Free for initial testing
- Region: choose the closest available region to the user

## Client-side changes after activation

For each profile, change the server and TLS SNI/Host to the Render service's `*.onrender.com` hostname, change the WebSocket path to the matching `/relay/n` route, and add an `X-Relay-Token` WebSocket header. Keep the VLESS UUID in the client only; never store it in this repository. Test one route first.

## Operational caveats

Render Free services can sleep, restart, or be suspended after quota or policy thresholds. An active relay consumes outbound bandwidth. Do not expose this endpoint publicly without the relay token. Rotate the token and upstream credentials if they are disclosed. Use only where permitted by applicable laws and provider terms.
